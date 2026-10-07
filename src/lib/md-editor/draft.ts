// ─────────────────────────────────────────────────────────────────────────────
// md-editor/draft.ts —— 新建页的本地纯文本草稿（两个老键的原样续用）
//
// 【键不能改】`blog-upload-editor` / `clipboard-upload-editor` 这两个键名先于本
// 编辑器存在，且**存的本来就是纯文本 Markdown 正文** —— 于是换代时原样续用，老用户
// 浏览器里那份没写完的草稿会被照常恢复。换成新键名 = 那批草稿静默消失，页面上不会
// 有任何提示（键名是本地数据的物理形态，改它等于丢数据）。见 §5.2 的表格。
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

/** 防抖间隔。取 500ms：比一次连续打字的停顿略长，又短到「刚打完切走」也来得及。 */
export const DRAFT_DEBOUNCE_MS = 500;

export interface DraftStore {
  /** 读回上次的草稿。`{ok:false}` = localStorage 用不了（调用方给提示，继续编辑）。 */
  read(): { ok: true; value: string | null } | { ok: false };
  /** 记下最新正文，防抖后落盘。 */
  schedule(value: string): void;
  /** 立刻把待写的一份落盘（离页 / 提交前用）。 */
  flush(): void;
  /** 永久停止后续写入（页面马上要跳走、不再编辑时用）。clear() 不必先调它。 */
  stop(): void;
  /** 取消待写并删键。之后接着写仍会攒新草稿（发布成功那一下用）。 */
  clear(): void;
  /** 摘掉离页监听（组件卸载）。 */
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
  let pending: string | null = null;
  let stopped = false;
  let notified = false;

  function notifyUnavailable(): void {
    if (notified) return;
    notified = true;
    onUnavailable?.();
  }

  function write(): void {
    if (stopped || pending === null) return;
    const value = pending;
    pending = null;
    try {
      window.localStorage.setItem(key, value);
    } catch {
      notifyUnavailable();
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
        return { ok: true, value: window.localStorage.getItem(key) };
      } catch {
        notifyUnavailable();
        return { ok: false };
      }
    },
    schedule(value) {
      if (stopped) return;
      pending = value;
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
      } catch {
        notifyUnavailable();
      }
    },
    dispose() {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      target?.removeEventListener('pagehide', onPageHide);
    },
  };
}
