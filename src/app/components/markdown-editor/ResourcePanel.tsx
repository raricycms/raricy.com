'use client';

// ─────────────────────────────────────────────────────────────────────────────
// markdown-editor/ResourcePanel.tsx —— 「插入引用」面板（图床 / 音频 / 剪贴板 / 投票 / 收藏夹）
//
// 【为什么是一个面板而不是五颗工具条按钮】工具条已经排满，再挂五颗按钮在窄屏会
// 多折出两行；而这五类**用法完全一样**（挑一条 → 插回正文），分成五个弹窗只是把
// 同一套加载 / 搜索 / 空 / 失败状态抄五遍。于是：一颗按钮、五个标签。
//
// 【它只负责画】读口、解析、插入语法、能不能插全在 lib/md-editor/resources.ts
// （零 React，可单测）。这里**一个字面量 token 都不拼** —— 拼错的表现是正文里
// 留一段方括号，谁也不报错。
//
// 【弹窗外壳】照抄 ImagePickerModal 的 `modal-overlay show` / `modal-dialog` /
// `modal-content`：展开类是 `show`，**不是** `is-open`。写错的表现是弹窗恒为
// display:none（用户那边就是「点了没反应」），而接口与单测全都正常。
//
// 【键盘】Esc 关（父级在关闭时把焦点还给编辑区）。搜索框自动获得焦点，
// 于是「打开面板 → 打字 → ↓ → Enter」全程不用碰鼠标。
//   · ↑ / ↓ 移动高亮（**跳过不可插入的那些**，停在两头不绕回）；
//   · Enter 插入高亮那条，并且**无条件 preventDefault**：面板挂在页面那个 <form>
//     里，输入框里按 Enter 会触发隐式提交（见输入框上那段注释）；
//   · 焦点一直留在搜索框上（roving 的是高亮，不是 DOM 焦点）—— 这样打完字接着
//     按 ↓ 不会先要 Tab 回来。
//
// 【拉取的是「自己的」五类】接口本身就按 authorId 过滤（§4.1），面板不额外放宽
// 也不额外收紧；私有 / 公开只是**角标**，唯一的例外是私有收藏夹不可插入
// （它没有对外 ID），那一条连同理由一起显示在行内。
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Check, ImageOff, Lock, RefreshCw } from 'lucide-react';
import {
  RESOURCE_KINDS,
  filterResourceItems,
  resourceKind,
  type ResourceItem,
  type ResourceKind,
} from '@/lib/md-editor/resources';

/** 首屏渲染多少条；「显示更多」每次再加这么多（与图床选择器同一个量级）。 */
const REVEAL_STEP = 24;

type LoadState =
  | { status: 'loading' }
  | { status: 'ready'; items: ResourceItem[] }
  | { status: 'failed' }
  /** 这一档对当前账号根本不可用（未登录 / 不是核心用户）。 */
  | { status: 'unavailable'; message: string };

export interface ResourcePanelProps {
  onClose: () => void;
  /** 插进正文（父级走 CM6 事务）。插完由父级决定是否关闭面板。 */
  onInsert: (text: string) => void;
}

export default function ResourcePanel({ onClose, onInsert }: ResourcePanelProps) {
  const [kind, setKind] = useState<ResourceKind>('image');
  const [query, setQuery] = useState('');
  const [reveal, setReveal] = useState(REVEAL_STEP);
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  /** 每个标签各自的一份结果 —— 切来切去不重复打接口，刷新按标签来。 */
  const cacheRef = useRef(new Map<ResourceKind, LoadState>());
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  /**
   * 输入法是否正在组字。**用 ref 不用 state**：它只在同一次按键事件里被判，
   * state 要等一次重渲染才更新，而 compositionend 与那一下 keydown 挨得太近。
   * 与 `nativeEvent.isComposing` 一起当判据（见搜索框上那段注释）。
   */
  const composingRef = useRef(false);
  /** 只认最后一次请求：切标签 / 连点刷新时，先发的后到不许覆盖后发的。 */
  const reqSeqRef = useRef(0);

  const spec = resourceKind(kind);

  const load = useCallback(async (target: ResourceKind, force: boolean) => {
    // ★ 先作废在飞的一切，**排在最前面** ★
    // 这一步必须在任何分支之前，包括下面那条「缓存命中就早退」的分支。命中缓存时
    // 这一趟既不取数也不写 state，看着什么都不用做 —— 但**别的标签在飞的那一条
    // 仍然会落地**，而它的 seq 还是「当时的当前值」，于是把 state 覆盖成上一个
    // 标签的列表：用户在「投票」加载中切回已缓存好的「图床」，几秒后图片列表
    // **自己变成了投票列表**，没有任何报错。作废它只需要在这里 +1。
    const seq = (reqSeqRef.current += 1);

    const cached = cacheRef.current.get(target);
    if (cached && cached.status === 'ready' && !force) {
      setState(cached);
      return;
    }
    setState({ status: 'loading' });
    try {
      const res = await fetch(resourceKind(target).endpoint, { credentials: 'same-origin' });
      // 401 / 403 是「这一档你用不了」，与「加载失败」不是一回事：前者重试多少次
      // 都一样，给一颗重试按钮只会让人白点。
      if (res.status === 401 || res.status === 403) {
        const body = (await res.json().catch(() => null)) as { message?: string } | null;
        if (seq !== reqSeqRef.current) return;
        const next: LoadState = {
          status: 'unavailable',
          message: body?.message || (res.status === 401 ? '请先登录' : '你的账号还不能用这一档'),
        };
        setState(next);
        cacheRef.current.set(target, next);
        return;
      }
      if (!res.ok) throw new Error(String(res.status));
      const payload: unknown = await res.json();
      if (seq !== reqSeqRef.current) return;
      const next: LoadState = { status: 'ready', items: resourceKind(target).parse(payload) };
      setState(next);
      cacheRef.current.set(target, next);
    } catch {
      if (seq !== reqSeqRef.current) return;
      const next: LoadState = { status: 'failed' };
      setState(next);
      // 失败**不进缓存**：下一次切回来重试一次，而不是把一次网络抖动钉成永久失败。
      //（上限与重试次数的口径见 plan §5.1 —— 这里只有手动触发，不会每次按键重试。）
      cacheRef.current.delete(target);
    }
  }, []);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // 切标签（含首次）时取数：结果已在缓存里就瞬开，不闪加载态
  useEffect(() => {
    void load(kind, false);
  }, [kind, load]);

  // Esc 关闭（父级负责把焦点还给编辑区）+ 焦点锁在弹窗内。
  // Tab 那一段是**极简焦点陷阱**，照 FrameBuster 的既有做法（不引依赖、不做 inert 遍历）：
  // 弹窗自己声明了 aria-modal="true"，也就是「其余内容对辅助技术不可交互」——
  // 不锁的话 Tab 会一路走到遮罩**后面**的表单上：焦点跑到一个看不见的地方，
  // 接着按 Enter 点到的可能是「提交」。只在两端收口，中间照旧交给浏览器。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // ★ 组字期间的 Escape 是**输入法的**（撤掉候选条 / 取消这次组字）★
        // 搜索框自己那段 onKeyDown 已经放行了，但事件**还会冒泡到这里** —— 这里
        // 是 document 级监听，收的是**原生**事件，所以两个判据与搜索框同源：
        // 原生的 `isComposing`，以及 compositionstart / end 翻的本地标志。
        // 少了这一段，中文用户在搜索框里打了一半、按 Esc 取消候选，整个面板跟着关掉
        //（用户只是想把候选收回去），而这不是报错、只是「面板莫名其妙自己没了」。
        if (e.isComposing || composingRef.current) return;
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== 'Tab') return;
      const dialog = dialogRef.current;
      if (!dialog) return;
      // 只收「真的聚焦得起来」的：禁用的按钮（不可插入的那几条）拿不到焦点，
      // 把它算进队尾会让收口静默落空 —— 那正是「Tab 跑出去」最常见的成因。
      const focusables = Array.from(
        dialog.querySelectorAll<HTMLElement>(
          'button:not([disabled]), a[href], input:not([disabled]), select, textarea'
        )
      );
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const activeEl = document.activeElement;
      if (e.shiftKey && (activeEl === first || !dialog.contains(activeEl))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && activeEl === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const items = state.status === 'ready' ? state.items : [];
  const filtered = useMemo(() => filterResourceItems(items, query), [items, query]);
  const shown = filtered.slice(0, reveal);

  function pick(item: ResourceItem) {
    if (!item.insert) return;
    onInsert(item.insert);
  }

  /** 高亮在 `shown` 里的下标。焦点始终留在搜索框上，它是「光标在哪一条」的唯一标记。 */
  const [active, setActive] = useState(0);

  // 「该重设高亮了」的三件事：换标签、换搜索词、列表到货。落点是**第一条可插入的**——
  // 收藏夹那一屏的前几条可能全是私有（不可插），停在 0 会让第一次 Enter 什么也不做。
  // `shown` 不进依赖：它每次渲染都是新的 slice，放进去等于每次渲染都重设。
  useEffect(() => {
    const first = shown.findIndex((i) => i.insert);
    setActive(first < 0 ? 0 : first);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, query, state]);

  /** 上下移动，**跳过不可插入的那些**；到头停住，不绕回（绕回会让「按过头了」回不去）。 */
  function moveActive(delta: number) {
    let i = active;
    for (let step = 0; step < shown.length; step += 1) {
      i += delta;
      if (i < 0 || i >= shown.length) return;
      if (shown[i]?.insert) {
        setActive(i);
        return;
      }
    }
  }

  return (
    <div className="modal-overlay show" onClick={onClose}>
      <div
        className="modal-dialog md-res-modal"
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="插入引用"
        // 焦点陷阱要在「焦点不在弹窗内」时把它收回来（比如点了遮罩），
        // 所以这个容器自己得是聚焦得起来的 —— 与 FrameBuster 的口径一致。
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-content">
          <div className="modal-header">
            <h3 className="modal-title">插入引用</h3>
            <button type="button" className="chat-modal-close" onClick={onClose} aria-label="关闭">
              ×
            </button>
          </div>

          <div className="modal-body">
            <div className="md-res-tabs" role="tablist" aria-label="资源类型">
              {RESOURCE_KINDS.map((s) => (
                <button
                  key={s.key}
                  type="button"
                  role="tab"
                  id={`md-res-tab-${s.key}`}
                  aria-selected={s.key === kind}
                  aria-controls="md-res-panel"
                  className={`md-res-tab${s.key === kind ? ' is-active' : ''}`}
                  onClick={() => {
                    // 点当前这一颗标签是**空操作**。少了这个早退会很安静地坏掉：
                    // kind 没变 → 取数的 effect 不会重跑 → 而下面那行已经把状态
                    // 打回 `loading`，于是面板停在「加载中…」，直到用户切走再切回来。
                    // （用户视角就是「点了一下自己所在的标签，列表没了」。）
                    if (s.key === kind) return;
                    setKind(s.key);
                    setQuery('');
                    setReveal(REVEAL_STEP);
                    // 同步落一个加载态：不落的话，从点标签到 effect 跑完之间会**画一帧
                    // 上一个标签的列表**（标签名已经换了、条目还是旧的），看着像
                    // 「切到收藏夹却列出了我的图片」。
                    setState({ status: 'loading' });
                  }}
                >
                  {s.label}
                </button>
              ))}
            </div>

            <div className="md-res-search">
              <input
                ref={inputRef}
                type="search"
                className="form-control chat-new-search"
                placeholder={`搜索${spec.label}…`}
                value={query}
                role="combobox"
                aria-expanded="true"
                aria-controls="md-res-list"
                aria-autocomplete="list"
                // 高亮的是「哪一条」而不是焦点在哪 —— 焦点始终留在输入框，
                // 屏幕阅读器靠这一格念出当前那条。
                aria-activedescendant={
                  shown[active] ? `md-res-item-${shown[active].key}` : undefined
                }
                onChange={(e) => {
                  setQuery(e.target.value);
                  setReveal(REVEAL_STEP); // 换了过滤条件就收回首屏
                }}
                // 组字起止 —— 只用来喂下面那条判据（同 MentionInput / RichComposer 的写法）
                onCompositionStart={() => {
                  composingRef.current = true;
                }}
                onCompositionEnd={() => {
                  composingRef.current = false;
                }}
                onKeyDown={(e) => {
                  // ★ 输入法组字期间的按键是**输入法的** ★ 中文 / 日文 / 韩文输入法
                  // 用 Enter 确认候选、用 ↑↓ 在候选词之间翻 —— 那几下必须原样交给 IME：
                  // 既不能插引用（用户想插的是候选词里那一条，不是面板高亮那条）、
                  // 不能关面板，更不能 preventDefault（拦下来候选就选不中，字打不进去）。
                  // 两个判据都要，但它们覆盖的是**组字期间不同的到达顺序**：
                  // `isComposing` 是浏览器随事件一起给的；本地标志则由 compositionstart /
                  // end 翻转 —— 有的环境里 keydown 早于 compositionstart（那一下还没有
                  // 「在组字」这个事实），有的则在 compositionend 之前、标志已复位的位置
                  // 收到按键。合成事件层面的用例见 md-editor-resource-panel.test.ts。
                  // ⚠️ **它们管不到「compositionend 之后**那一下** keydown」**：原生标志那时
                  // 可能仍是 false，而本地标志已在 compositionend 里复位成 false。这一格
                  // **刻意不补时序补丁** —— 那种输入法行为本站没有任何实测证据（真中文 /
                  // 日文 IME 未测，e2e 的 `insertText` 绕过整条组字路径），为一个没验证过的
                  // 现象加一条「什么时候算组字结束」的猜测，只会制造新的静默错判。
                  // 这一行必须在下面任何 preventDefault **之前**。
                  if (e.nativeEvent.isComposing || composingRef.current) return;
                  if (e.key === 'Enter') {
                    // ★ 无条件拦下 ★ 面板挂在页面那个 <form> 里（博客新建 / 编辑、
                    // 剪贴板各一个），而 `<input type="search">` 里按 Enter 会触发
                    // **隐式提交**：浏览器不等你点提交按钮，直接把整张表单提交掉。
                    // 后果按页面而不同 —— 博客这边是**当场发出去一篇文章**，
                    // 剪贴板那边是一次没打算做的保存。e2e 实测过：去掉这一行，
                    // 「搜不到结果时按 Enter」会真的打出 `POST /api/blogs`。
                    //
                    // 【为什么插得中那一条反而看不出这个 bug】插进去的那一下会把面板
                    // 卸载掉，输入框连着整个面板一起离开文档 —— 浏览器要执行 Enter 的
                    // 默认动作时已经没有目标了，于是**不拦也照样安静**。
                    // 真正的口子只在「按了 Enter 但插不进去」：搜不到结果 / 列表还在
                    // 加载 / 一屏全是不可插的私有收藏夹 —— 面板留在原地，表单就是靶子。
                    // 拦在面板里而不是给表单加 onKeyDown：这是站内唯一一处
                    // 「表单里有个输入框、用户会习惯性按回车」的地方。
                    e.preventDefault();
                    const item = shown[active];
                    if (item?.insert) pick(item);
                    return;
                  }
                  if (e.key === 'ArrowDown') {
                    e.preventDefault();
                    moveActive(1);
                    return;
                  }
                  if (e.key === 'ArrowUp') {
                    e.preventDefault();
                    moveActive(-1);
                  }
                }}
              />
              <button
                type="button"
                className="md-res-refresh"
                title="重新加载"
                aria-label="重新加载"
                onClick={() => void load(kind, true)}
              >
                <RefreshCw size={14} strokeWidth={2} aria-hidden="true" />
              </button>
            </div>

            <div
              className="md-res-body"
              id="md-res-panel"
              role="tabpanel"
              aria-labelledby={`md-res-tab-${kind}`}
            >
              {state.status === 'loading' && <div className="md-res-state">加载中…</div>}

              {state.status === 'unavailable' && (
                <div className="md-res-state md-res-state--locked">
                  <Lock aria-hidden="true" />
                  <p>{state.message}</p>
                </div>
              )}

              {state.status === 'failed' && (
                <div className="md-res-state">
                  <p>{spec.label}列表加载失败</p>
                  <button
                    type="button"
                    className="md-res-retry"
                    onClick={() => void load(kind, true)}
                  >
                    重试
                  </button>
                </div>
              )}

              {state.status === 'ready' &&
                (filtered.length === 0 ? (
                  <div className="md-res-state">
                    <ImageOff aria-hidden="true" />
                    <p>{items.length === 0 ? spec.empty : '没有匹配的结果'}</p>
                  </div>
                ) : (
                  <>
                    <ul className="md-res-list" id="md-res-list" role="listbox" aria-label={`${spec.label}列表`}>
                      {shown.map((item, index) => (
                        <li key={item.key} role="presentation">
                          <button
                            type="button"
                            id={`md-res-item-${item.key}`}
                            // 这一列是 combobox 的 listbox：屏幕阅读器据此把按钮念成
                            // 「选项」。点击、`disabled` 都不受 role 影响。
                            role="option"
                            aria-selected={index === active}
                            className={`md-res-item${index === active ? ' is-active' : ''}`}
                            // 不可插入的那几条**留着**而不是藏掉：用户要找的是
                            // 「我那个收藏夹」，藏掉之后他会以为它丢了。
                            disabled={!item.insert}
                            title={item.reason ?? item.title}
                            // 鼠标划过也把高亮挪过来 —— 否则「键盘高亮在 A、鼠标点了 B」
                            // 之后按 ↓ 会从 A 往下一格跳，看着像跳错了。
                            onMouseEnter={() => setActive(index)}
                            onClick={() => pick(item)}
                          >
                            {item.thumb && (
                              // 缩略图直接打原图接口（本站图床没有生成缩略图）；
                              // loading=lazy + 首屏截断把实际并发交给视口决定。
                              <img className="md-res-item__thumb" src={item.thumb} alt="" loading="lazy" />
                            )}
                            <span className="md-res-item__main">
                              <span className="md-res-item__title">{item.title}</span>
                              <span className="md-res-item__sub">
                                {item.insert ? item.subtitle : item.reason}
                              </span>
                            </span>
                            {item.badge && <span className="md-res-item__badge">{item.badge}</span>}
                            {item.insert && (
                              <Check
                                className="md-res-item__go"
                                size={14}
                                strokeWidth={2}
                                aria-hidden="true"
                              />
                            )}
                          </button>
                        </li>
                      ))}
                    </ul>
                    {filtered.length > shown.length && (
                      <button
                        type="button"
                        className="image-picker-more"
                        onClick={() => setReveal((n) => n + REVEAL_STEP)}
                      >
                        显示更多（还有 {filtered.length - shown.length} 条）
                      </button>
                    )}
                  </>
                ))}
            </div>

            <p className="md-res-hint">{spec.hint}</p>
          </div>
        </div>
      </div>
    </div>
  );
}
