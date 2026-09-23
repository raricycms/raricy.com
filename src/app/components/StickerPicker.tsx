'use client';

// ─────────────────────────────────────────────────────────────────────────────
// StickerPicker.tsx — 表情面板（评论与讨论共用，由 RichComposer 承载）
//
// 【数据源】两个，都一样渲染：
//   · GET /api/stickers（要登录）—— 站长往 instance/stickers/ 里拷文件即生效，
//     前端不需要任何构建步骤；
//   · **内置「黄脸表情」栏** —— 编译期清单，客户端直接合成，不问服务器（见
//     EMOJI_COLLECTION_VIEW）。所以素材目录为空的站也照样有内容。
//
// 【为什么是贴边面板，而不是 ImagePickerModal 那种居中弹窗】两个理由：
//   · ImagePickerModal 打开时会把焦点抢到搜索框（`inputRef.current?.focus()`）。
//     表情面板若照抄，textarea 就会失焦 —— 桌面端读取 selectionStart 的行为在失焦后
//     不完全一致，移动端更直接：失焦 = 键盘收起，插完再 focus 不一定能重新拉起。
//   · 微信式面板本来就该从输入框下方长出来。既符合交互习惯，又顺手消掉上面这类问题。
// 配套的一条细节：面板里每个表情按钮都 `onMouseDown={preventDefault}` —— 让按钮
// **永远不抢焦点**，光标全程留在 textarea 里，插入位置天然正确。
//
// 【合集条在网格**上面**，且记得上次停留的那一栏】两件事：
//   · 次序 —— 先选合集、再挑表情，所以合集条在上、网格在下（微信也是这个次序）；
//   · 记忆 —— 上次停在哪个合集记在 localStorage（键 `sticker_collection`）。面板在
//     RichComposer 里是 `{stickerOpen && …}`，**挂载/卸载**的，组件状态留不下；
//     而「上次在挑猫猫」跨页也该记住。记的是**key**（token 里那一段）而不是下标，
//     理由见下面的 activeKey 注释。
//
// 【manifest 缓存】模块级的 5 分钟 TTL + 并发去重，照抄 useResolvedContent 的范式。
// 服务端那边还有一层扫盘缓存（见 sticker-service.ts），两边互不冲突。
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useRef, useState } from 'react';
import {
  EMOJI_COLLECTION,
  EMOJI_COLLECTION_TITLE,
  listEmojiFaces,
} from '@/lib/emoji-faces';

interface StickerCollectionDTO {
  key: string;
  title: string;
  stickers: { name: string; url: string }[];
}

/**
 * 点了一格之后交给调用方的东西是哪一类。
 *
 * 面板自己**不决定**发不发 —— 它只把这个 kind 交出去（见 onPick）：
 *   · `sticker` —— 站长放的图片表情。讨论区点一下**直接发一条消息**。
 *   · `emoji`   —— 内置黄脸。**插到输入框光标处**，讨论区也不直接发。
 */
export type StickerPickKind = 'sticker' | 'emoji';

/**
 * 面板里的一栏。站长的图片合集与内置黄脸**在渲染上完全同构**（都是 name + url 的
 * 图片格子），差别只有 kind —— 所以不需要为黄脸另写一套网格。
 */
interface CollectionView extends StickerCollectionDTO {
  kind: StickerPickKind;
}

/**
 * 内置「黄脸表情」栏 —— **客户端合成**，不走 /api/stickers。
 *
 * 【为什么不走接口】它是编译期就固定的清单（见 src/lib/emoji-faces.ts 的文件头），
 * 没有扫盘、没有权限、也不受站长素材目录影响。顺带两个好处：
 *   · **素材为空的站照样能用这一栏** —— 这正是当前仓库的状态；
 *   · 接口挂了（`failed`）时它其实还能用，只是面板整体进了失败态（刻意没扩，见组件体）。
 */
const EMOJI_COLLECTION_VIEW: CollectionView = {
  key: EMOJI_COLLECTION,
  title: EMOJI_COLLECTION_TITLE,
  kind: 'emoji',
  stickers: listEmojiFaces(),
};

interface StickerData {
  collections: StickerCollectionDTO[];
  /** 站长还没往 instance/stickers 里放素材。 */
  empty: boolean;
}

const CACHE_TTL_MS = 5 * 60_000;

let cache: (StickerData & { at: number }) | null = null;
let inflight: Promise<StickerData> | null = null;

/** 严格挑出合法形状 —— 面板是个纯展示组件，宁可少画几个也不要渲染出半个坏按钮。 */
function parseCollections(raw: unknown): StickerCollectionDTO[] {
  if (!Array.isArray(raw)) return [];
  const out: StickerCollectionDTO[] = [];
  for (const c of raw) {
    if (!c || typeof c !== 'object') continue;
    const key = (c as { key?: unknown }).key;
    const title = (c as { title?: unknown }).title;
    const stickers = (c as { stickers?: unknown }).stickers;
    if (typeof key !== 'string' || !Array.isArray(stickers)) continue;
    const list = stickers
      .filter(
        (s): s is { name: string; url: string } =>
          !!s &&
          typeof s === 'object' &&
          typeof (s as { name?: unknown }).name === 'string' &&
          typeof (s as { url?: unknown }).url === 'string'
      )
      .map((s) => ({ name: s.name, url: s.url }));
    if (list.length === 0) continue;
    out.push({ key, title: typeof title === 'string' && title ? title : key, stickers: list });
  }
  return out;
}

/**
 * 「上次停留的合集」的 localStorage 键 —— 与 theme / blog_sort / chat_sidebar_collapsed
 * 同款：纯本机偏好，不上送服务端（隐私页 2.2 有对外口径）。
 */
const LS_KEY = 'sticker_collection';

/** 读上次停留的合集。读不到（首次 / 被清）或存不了（隐私模式）都返回 null。 */
function readSavedCollection(): string | null {
  try {
    return localStorage.getItem(LS_KEY);
  } catch {
    return null; // 隐私模式/被禁 → 不记忆，落回黄脸那一栏
  }
}

/** 记住这次停在哪一栏。写失败也只是不记忆 —— 本次会话内照常切换。 */
function rememberCollection(key: string) {
  try {
    localStorage.setItem(LS_KEY, key);
  } catch {
    // 同上
  }
}

function loadStickers(): Promise<StickerData> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) {
    return Promise.resolve({ collections: cache.collections, empty: cache.empty });
  }
  if (inflight) return inflight;
  const task = (async () => {
    try {
      const res = await fetch('/api/stickers', { credentials: 'same-origin' });
      if (!res.ok) throw new Error('failed');
      const data = (await res.json()) as { collections?: unknown; empty?: unknown };
      const result: StickerData = {
        collections: parseCollections(data.collections),
        empty: data.empty === true,
      };
      // 失败不进缓存，下次打开面板重试
      cache = { ...result, at: Date.now() };
      return result;
    } finally {
      inflight = null;
    }
  })();
  inflight = task;
  return task;
}

export default function StickerPicker({
  onClose,
  onPick,
}: {
  onClose: () => void;
  /**
   * 选中一格 → 交回 token `[@合集/表情]` **与它是哪一类**，由调用方决定插入还是直接发送。
   *
   * 【为什么要把 kind 一起交出去】图片表情与黄脸的处置不一样（前者讨论区点一下直接发，
   * 后者一律插进输入框）。面板是唯一知道「点的是哪一栏」的地方，所以由它带上 ——
   * 让调用方按 token 前缀去猜，等于把「哪一栏是黄脸」这条知识散到两个文件里。
   */
  onPick: (token: string, kind: StickerPickKind) => void;
}) {
  const [data, setData] = useState<StickerData | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  // 面板只在你点开之后才挂载，所以初值直接读 localStorage 也不会与 SSR 打架。
  // null = 没有记忆，下面落回第一栏（黄脸）。
  const [activeKey, setActiveKey] = useState<string | null>(readSavedCollection);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    loadStickers()
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // 点面板外面关掉；Esc 也关。
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (!t) return;
      // 工具条上那个开关按钮自己会 toggle，这里让开，否则会「关了又开」
      if (t.closest('[data-sticker-toggle]')) return;
      if (rootRef.current && !rootRef.current.contains(t)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  // 黄脸**永远排在最前**，也是没有记忆 / 记忆失效时的落点 —— 对齐微信：打开面板
  // 先看到标准表情，站长的自制合集往后排。
  //
  // 站长若在素材目录里也建了个「黄脸」，**面板里只留内置那一栏**：两种来源共用同一个
  // 名字空间（token 都是 `[@黄脸/…]`，渲染时内置清单优先、清单里没有的才落到字节路由
  // —— 见 sticker-refs 的降级链与指南第七节），列成两栏就等于同一个名字有两个身份。
  // 下面这套「靠 key 认合集」（React key、aria-selected 的比对）也经不起撞名。
  const collections: CollectionView[] = [
    EMOJI_COLLECTION_VIEW,
    ...(data?.collections ?? [])
      .filter((c) => c.key !== EMOJI_COLLECTION)
      .map((c) => ({ ...c, kind: 'sticker' as const })),
  ];
  // ★ 记的是 key（token 里那一段），**不是下标** ★
  // 合集列表是异步来的、站长还会增删目录，下标会在两次打开之间悄悄换人（删掉排在前面的
  // 一栏，后面的整体前移 —— 记忆还「有效」，只是指到了另一个合集上）。key 与目录一一
  // 对应，只有它值得记。
  // 记的那一栏没了（站长删了目录）→ 落回第一栏；下次点任意一栏就把它覆盖掉。
  const current = collections.find((c) => c.key === activeKey) ?? collections[0];

  return (
    <div className="sticker-picker" ref={rootRef}>
      {loading ? (
        <div className="sticker-picker__state">加载中…</div>
      ) : failed ? (
        <div className="sticker-picker__state">表情加载失败，请稍后重试</div>
      ) : (
        <>
          {/* 合集条在上、网格在下（见文件头「合集条在网格上面」） */}
          <div className="sticker-picker__tabs" role="tablist">
            {collections.map((c) => {
              // 高亮跟着**解析后的** current 走，不跟 activeKey：记忆指向一个已经不在的
              // 合集时 activeKey 谁都对不上，那样会一条 tab 都不亮。
              const isActive = c.key === current.key;
              return (
                <button
                  key={c.key}
                  type="button"
                  role="tab"
                  aria-selected={isActive}
                  className={`sticker-picker__tab${isActive ? ' is-active' : ''}`}
                  title={c.title}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    setActiveKey(c.key);
                    rememberCollection(c.key);
                  }}
                >
                  {c.title}
                </button>
              );
            })}
          </div>
          <div className="sticker-picker__body">
            <div className="sticker-picker__grid">
              {current?.stickers.map((s) => {
                const token = `[@${current.key}/${s.name}]`;
                return (
                  <button
                    key={s.name}
                    type="button"
                    className="sticker-picker__item"
                    title={token}
                    aria-label={token}
                    // ★ 不让按钮抢焦点 ★ 见文件头：光标必须留在 textarea 里
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => onPick(token, current.kind)}
                  >
                    <img src={s.url} alt={s.name} loading="lazy" draggable={false} />
                  </button>
                );
              })}
            </div>
          </div>
          {/* 站长指引：只在素材目录为空时出现。
              以前它是一条**整块空态**（连 tab 条都不渲染）—— 现在黄脸永远是内容，
              所以降级成一行小字，别让整站没素材时站长再也看不到这句话。 */}
          {data?.empty && (
            <p className="sticker-picker__hint">
              把表情图片放进服务器的 instance/stickers/&lt;合集&gt;/ 目录即可增加合集。
            </p>
          )}
        </>
      )}
    </div>
  );
}
