// ─────────────────────────────────────────────────────────────────────────────
// md-editor/draft.ts —— 新建页的本地草稿（两个老键的原样续用）
//
// 【键不能改】`blog-upload-editor` / `clipboard-upload-editor` 这两个键名先于本
// 编辑器存在，且**存的本来就是纯文本 Markdown 正文** —— 于是换代时原样续用，老用户
// 浏览器里那份没写完的草稿会被照常恢复。换成新键名 = 那批草稿静默消失，页面上不会
// 有任何提示（键名是本地数据的物理形态，改它等于丢数据）。见 §5.2 的表格。
//
// 【格式也一起存】reactive 草稿必须连**正文语言**一起恢复；裸 Markdown 的落盘
// 形态一个字都不变（老草稿续用、且只能恢复成 markdown）。编码细节见下面
// 「格式怎么存」。
//
// 【为什么单独一层】「防抖写入 / 离页尽力落下 / 发布成功后先停再清」这三条是**容易
// 写错且错了看不出来**的地方：
//   · 先清键、后停定时器 —— 延迟回调把刚清掉的草稿又写回来，用户下次打开看到的是
//     一篇已经发布过的旧文，还以为是服务端丢了数据；
//   · 只在 unmount 里写 —— 直接关标签页/切前后台时 unmount 不一定跑，最后一段输入丢；
//   · localStorage 抛异常（隐私模式、配额满）时若让异常逃出去，编辑器初始化会整个
//     挂掉 —— 而「写不了草稿」远不该等于「用不了编辑器」。
// 所以这里把失败收成 `onUnavailable` 回调，由调用方给一句提示即可，编辑继续。
// ─────────────────────────────────────────────────────────────────────────────

import type { ContentFormat } from '../content-format';

/** 防抖间隔。取 500ms：比一次连续打字的停顿略长，又短到「刚打完切走」也来得及。 */
export const DRAFT_DEBOUNCE_MS = 500;

/**
 * 草稿 = 正文 + 格式 + 语法版本。
 *
 * 三者必须一起恢复：正文按 A 版语法写成，却按 B 版语义恢复，页面上通常看不出
 * 异常（滑块照样能拖），直到保存 / 迁移时才出问题。`syntaxVersion` 只是**原样
 * 保存与回传**，不在前端推导（权威值来自服务端 / 解析器）。
 */
export interface DraftEntry {
  format: ContentFormat;
  text: string;
  /** 正文写入时的语法版本；null = 旧文档 / 未知（不是「最新版」）。 */
  syntaxVersion: string | null;
}

/**
 * ★ 格式怎么存：**正文永远是裸正文，格式/版本放旁路元数据** ★
 *
 * 旧阅读器（回滚后的构建、同一浏览器里还没刷新的旧标签页）只会读主键。任何
 * 「把 JSON 信封写在主键里」的方案，在它眼里都是一段以 `{` 开头的普通 Markdown
 * —— 用户一保存就把信封写进文章（审查 4.2）。所以当前写入形态是：
 *
 *   · `key`          —— 原文，逐字节就是用户写的内容（老阅读器照常显示）；
 *   · `key + ':meta'`—— JSON `{ version, format, syntaxVersion }`，只给新阅读器。
 *
 * 老阅读器读到 reactive 草稿时会把源码当 Markdown 显示：这是**降级但保留原文**，
 * 不会产生 JSON 正文；新阅读器读回格式与版本。markdown 草稿不需要元数据（主键
 * 裸正文即全部信息），写入时顺手清掉可能残留的旧 meta。
 *
 * 历史兼容：v1（`{text, format}`）与早期 v2（`{text, format, syntaxVersion}`）
 * 信封仍可读 —— 升级前浏览器里留下的那些草稿照常恢复。未知形态一律按裸 Markdown
 * 恢复，绝不因为「看起来像 JSON」就猜成 reactive。
 */
const DRAFT_ENVELOPE_V1 = 'raricy-md-draft:v1:';
const DRAFT_ENVELOPE_V2 = 'raricy-md-draft:v2:';

/** 旁路元数据键（相对主键）。 */
export function draftMetaKey(key: string): string {
  return `${key}:meta`;
}

/**
 * 正文指纹（FNV-1a 32 位）。只用来判断「元数据还配不配得上主键里的正文」：
 * 旧标签页 / 回滚构建只写主键、不碰 meta，若不校验，它保存的新正文会被新阅读器
 * 按旧的 reactive 格式恢复。指纹不一致 → 忽略 meta，按 Markdown 恢复。
 */
function textFingerprint(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/** 取信封里的字符串字段；形态不对返回 null（不抛）。 */
function envelopeString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function looksLikeLegacyEnvelope(raw: string): boolean {
  return raw.startsWith(DRAFT_ENVELOPE_V1) || raw.startsWith(DRAFT_ENVELOPE_V2);
}

/** 把**历史信封**解成草稿。裸正文 / 坏信封返回 null（调用方再按 Markdown 处理）。 */
export function parseDraftValue(raw: string | null): DraftEntry | null {
  if (raw === null) return null;
  for (const [prefix, versioned] of [
    [DRAFT_ENVELOPE_V2, true],
    [DRAFT_ENVELOPE_V1, false],
  ] as const) {
    if (!raw.startsWith(prefix)) continue;
    try {
      const parsed: unknown = JSON.parse(raw.slice(prefix.length));
      if (
        parsed &&
        typeof parsed === 'object' &&
        (parsed as { format?: unknown }).format === 'reactive' &&
        typeof (parsed as { text?: unknown }).text === 'string'
      ) {
        return {
          format: 'reactive',
          text: (parsed as { text: string }).text,
          syntaxVersion: versioned
            ? envelopeString((parsed as { syntaxVersion?: unknown }).syntaxVersion)
            : null,
        };
      }
    } catch {
      // 信封坏了就按旧草稿处理：原文仍然还给用户，绝不把它丢掉。
    }
  }
  return null;
}

/** 主键里存的永远是原文（见上面「格式怎么存」）。 */
export function encodeDraftValue(entry: DraftEntry): string {
  return entry.text;
}

/** 旁路元数据；markdown + 无版本时返回 null（不需要写）。 */
export function encodeDraftMeta(entry: DraftEntry): string | null {
  if (entry.format === 'markdown' && entry.syntaxVersion === null) return null;
  return JSON.stringify({
    version: 1,
    format: entry.format,
    syntaxVersion: entry.syntaxVersion,
    hash: textFingerprint(entry.text),
  });
}

/** 解析旁路元数据；形态不对返回 null（退回 markdown，正文不受影响）。 */
export function parseDraftMeta(
  raw: string | null,
  text: string
): { format: ContentFormat; syntaxVersion: string | null } | null {
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const format = (parsed as { format?: unknown }).format;
    if (format !== 'markdown' && format !== 'reactive') return null;
    // 主键被旧阅读器改过 → 指纹对不上，元数据作废（正文仍是安全的）。
    const hash = (parsed as { hash?: unknown }).hash;
    if (typeof hash === 'string' && hash !== textFingerprint(text)) return null;
    const version = (parsed as { syntaxVersion?: unknown }).syntaxVersion;
    return {
      format,
      syntaxVersion: typeof version === 'string' ? version : null,
    };
  } catch {
    return null;
  }
}

export interface DraftStore {
  /**
   * 读回上次的草稿。`{ok:false}` = localStorage 用不了（调用方给提示，继续编辑）。
   *
   * 形状是「正文 + 格式」两个平级字段（而不是把正文包进对象）：老调用方只读
   * `value`，因此不必为格式改动重写一遍；要按格式恢复的调用方再读 `format`。
   * 没有草稿时 `value` 为 null、`format` 仍是 markdown。
   */
  read():
    | { ok: true; value: string | null; format: ContentFormat; syntaxVersion: string | null }
    | { ok: false };
  /**
   * 记下最新正文，防抖后落盘。
   *
   * 字符串重载 = markdown（老调用方 / 老测试的形态，落盘仍是裸正文）。
   */
  schedule(value: DraftEntry | string): void;
  /** 立刻把待写的一份落盘（离页 / 提交前用）。 */
  flush(): void;
  /** 永久停止后续写入（页面马上要跳走、不再编辑时用）。clear() 不必先调它。 */
  stop(): void;
  /** 取消待写并删键。之后接着写仍会攒新草稿（发布成功那一下用）。 */
  clear(): void;
  /** 把待写的一份落盘，再摘掉离页监听（组件卸载）。 */
  dispose(): void;
}

export interface DraftStoreOptions {
  /** localStorage 不可用（读写抛异常）时回调一次。 */
  onUnavailable?: () => void;
  /** 离页时用来挂 pagehide 监听的宿主，默认 window（单测可传桩）。 */
  host?: Pick<Window, 'addEventListener' | 'removeEventListener'>;
  debounceMs?: number;
}

export function createDraftStore(key: string, options: DraftStoreOptions = {}): DraftStore {
  const { onUnavailable, host, debounceMs = DRAFT_DEBOUNCE_MS } = options;
  const target = host ?? (typeof window !== 'undefined' ? window : undefined);

  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: DraftEntry | null = null;
  let stopped = false;
  let notified = false;

  function notifyUnavailable(): void {
    if (notified) return;
    notified = true;
    onUnavailable?.();
  }

  function write(): void {
    if (stopped || pending === null) return;
    const entry = pending;
    pending = null;
    const metaKey = draftMetaKey(key);
    // ★ 先写正文，再写元数据 ★
    // 正文写失败 → 清掉可能残留的旧 meta，避免「旧正文 + 新格式」错配。
    try {
      window.localStorage.setItem(key, entry.text);
    } catch {
      notifyUnavailable();
      try {
        window.localStorage.removeItem(metaKey);
      } catch {
        /* 已经不可写；read 会按裸 Markdown 恢复 */
      }
      return;
    }
    // 元数据失败时正文仍然完整保留；读回时按 Markdown 恢复（不产生 JSON 正文）。
    try {
      const meta = encodeDraftMeta(entry);
      if (meta === null) window.localStorage.removeItem(metaKey);
      else window.localStorage.setItem(metaKey, meta);
    } catch {
      notifyUnavailable();
      try {
        window.localStorage.removeItem(metaKey);
      } catch {
        /* 同上 */
      }
    }
  }

  function flush(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    write();
  }

  // 离页兜底。用 pagehide 而不是 beforeunload：移动端 Safari 关标签页时
  // beforeunload 常不触发，pagehide 是那边唯一可靠的钩子。
  const onPageHide = () => flush();
  target?.addEventListener('pagehide', onPageHide);

  return {
    read() {
      try {
        const raw = window.localStorage.getItem(key);
        if (raw === null) {
          return { ok: true, value: null, format: 'markdown', syntaxVersion: null };
        }
        // 历史信封（v1 / 早期 v2）优先按信封解；裸正文才看旁路元数据。
        const legacy = looksLikeLegacyEnvelope(raw) ? parseDraftValue(raw) : null;
        if (legacy) {
          return {
            ok: true,
            value: legacy.text,
            format: legacy.format,
            syntaxVersion: legacy.syntaxVersion,
          };
        }
        const meta = parseDraftMeta(window.localStorage.getItem(draftMetaKey(key)), raw);
        return {
          ok: true,
          value: raw,
          format: meta?.format ?? 'markdown',
          syntaxVersion: meta?.syntaxVersion ?? null,
        };
      } catch {
        notifyUnavailable();
        return { ok: false };
      }
    },
    schedule(value) {
      if (stopped) return;
      pending =
        typeof value === 'string'
          ? { format: 'markdown', text: value, syntaxVersion: null }
          : value;
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        write();
      }, debounceMs);
    },
    flush,
    stop() {
      stopped = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      pending = null;
    },
    clear() {
      // 顺序是刻意的：先取消待写的定时器、丢掉 pending，再删键。反过来就会留下一个
      // 「定时器还活着、键已经被删」的窗口 —— 它到点把刚发布的正文又写回去，表现为
      // 「发布成功、刷新一下旧草稿又回来了」。
      //
      // **这里刻意不置 stopped**：清草稿是一次性动作，不是「从此不再写草稿」。
      // 剪贴板新建页按 Ctrl+S 保存后并不离开页面，用户接着写的下一段还应该有草稿；
      // 置了 stopped 就等于「保存过一次之后，这一页再也不存草稿了」，且悄无声息。
      // 要彻底停写用 stop()（博客那类保存完就跳走的页面用得上）。
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      pending = null;
      try {
        window.localStorage.removeItem(key);
        window.localStorage.removeItem(draftMetaKey(key));
      } catch {
        notifyUnavailable();
      }
    },
    dispose() {
      // ★ 先 flush 再摘监听，顺序不能反 ★
      // 卸载（换页 / 关标签）**不一定**触发 pagehide —— 站内换页是客户端跳转，
      // 整个过程里 pagehide 一次都不发，只有 React 卸载。而卸载时挂起的恰好是
      // 最后那 500ms 内敲的字：只清定时器就等于把它丢掉，用户视角是
      // 「刚打完一句就点了别处，回来少了最后一句」，而页面上什么提示都没有。
      //
      // ⚠️ 与 clear() 的配合：发布成功后是 clear() 再 unmount。clear() 已经把
      // `pending` 置空，所以这里的 write() 什么也不写（`pending === null` 早退），
      // 不会把刚发布的正文重新写回 localStorage。
      flush();
      target?.removeEventListener('pagehide', onPageHide);
    },
  };
}
