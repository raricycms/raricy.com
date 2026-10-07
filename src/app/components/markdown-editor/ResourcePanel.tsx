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
  /** 只认最后一次请求：切标签 / 连点刷新时，先发的后到不许覆盖后发的。 */
  const reqSeqRef = useRef(0);

  const spec = resourceKind(kind);

  const load = useCallback(async (target: ResourceKind, force: boolean) => {
    const cached = cacheRef.current.get(target);
    if (cached && cached.status === 'ready' && !force) {
      setState(cached);
      return;
    }
    const seq = (reqSeqRef.current += 1);
    setState({ status: 'loading' });
    try {
      const res = await fetch(resourceKind(target).endpoint, { credentials: 'same-origin' });
      // 401 / 403 是「这一档你用不了」，与「加载失败」不是一回事：前者重试多少次
      // 都一样，给一颗重试按钮只会让人白点。
      if (res.status === 401 || res.status === 403) {
        const body = (await res.json().catch(() => null)) as { message?: string } | null;
        const next: LoadState = {
          status: 'unavailable',
          message: body?.message || (res.status === 401 ? '请先登录' : '你的账号还不能用这一档'),
        };
        if (seq === reqSeqRef.current) setState(next);
        cacheRef.current.set(target, next);
        return;
      }
      if (!res.ok) throw new Error(String(res.status));
      const payload: unknown = await res.json();
      const next: LoadState = { status: 'ready', items: resourceKind(target).parse(payload) };
      if (seq === reqSeqRef.current) setState(next);
      cacheRef.current.set(target, next);
    } catch {
      const next: LoadState = { status: 'failed' };
      if (seq === reqSeqRef.current) setState(next);
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

  // Esc 关闭。父级负责把焦点还给编辑区。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
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

  return (
    <div className="modal-overlay show" onClick={onClose}>
      <div
        className="modal-dialog md-res-modal"
        role="dialog"
        aria-modal="true"
        aria-label="插入引用"
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
                onChange={(e) => {
                  setQuery(e.target.value);
                  setReveal(REVEAL_STEP); // 换了过滤条件就收回首屏
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
                    <ul className="md-res-list">
                      {shown.map((item) => (
                        <li key={item.key}>
                          <button
                            type="button"
                            className="md-res-item"
                            // 不可插入的那几条**留着**而不是藏掉：用户要找的是
                            // 「我那个收藏夹」，藏掉之后他会以为它丢了。
                            disabled={!item.insert}
                            title={item.reason ?? item.title}
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
