'use client';

// ─────────────────────────────────────────────────────────────────────────────
// StickerPicker.tsx — 表情面板（评论与聊天共用，由 RichComposer 承载）
//
// 【数据源】GET /api/stickers（要登录）。返回「合集 → 表情」，站长往
// instance/stickers/ 里拷文件即生效，前端不需要任何构建步骤。
//
// 【为什么是贴边面板，而不是 ImagePickerModal 那种居中弹窗】两个理由：
//   · ImagePickerModal 打开时会把焦点抢到搜索框（`inputRef.current?.focus()`）。
//     表情面板若照抄，textarea 就会失焦 —— 桌面端读取 selectionStart 的行为在失焦后
//     不完全一致，移动端更直接：失焦 = 键盘收起，插完再 focus 不一定能重新拉起。
//   · 微信式面板本来就该从输入框下方长出来。既符合交互习惯，又顺手消掉上面这类问题。
// 配套的一条细节：面板里每个表情按钮都 `onMouseDown={preventDefault}` —— 让按钮
// **永远不抢焦点**，光标全程留在 textarea 里，插入位置天然正确。
//
// 【manifest 缓存】模块级的 5 分钟 TTL + 并发去重，照抄 useResolvedContent 的范式。
// 服务端那边还有一层扫盘缓存（见 sticker-service.ts），两边互不冲突。
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useRef, useState } from 'react';
import { Smile } from 'lucide-react';

interface StickerCollectionDTO {
  key: string;
  title: string;
  stickers: { name: string; url: string }[];
}

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
  /** 选中一个表情 → 交回 token `[@合集/表情]`，由调用方决定插入还是直接发送。 */
  onPick: (token: string) => void;
}) {
  const [data, setData] = useState<StickerData | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [active, setActive] = useState(0);
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

  const collections = data?.collections ?? [];
  const current = collections[active] ?? collections[0];

  return (
    <div className="sticker-picker" ref={rootRef}>
      {loading ? (
        <div className="sticker-picker__state">加载中…</div>
      ) : failed ? (
        <div className="sticker-picker__state">表情加载失败，请稍后重试</div>
      ) : collections.length === 0 ? (
        <div className="sticker-picker__state">
          <Smile aria-hidden="true" />
          <p>还没有可用的表情</p>
          {data?.empty && (
            <p className="sticker-picker__hint">
              把表情图片放进服务器的 instance/stickers/&lt;合集&gt;/ 目录即可。
            </p>
          )}
        </div>
      ) : (
        <>
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
                    onClick={() => onPick(token)}
                  >
                    <img src={s.url} alt={s.name} loading="lazy" draggable={false} />
                  </button>
                );
              })}
            </div>
          </div>
          <div className="sticker-picker__tabs" role="tablist">
            {collections.map((c, i) => (
              <button
                key={c.key}
                type="button"
                role="tab"
                aria-selected={i === active}
                className={`sticker-picker__tab${i === active ? ' is-active' : ''}`}
                title={c.title}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => setActive(i)}
              >
                {c.title}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
