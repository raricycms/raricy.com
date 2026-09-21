'use client';

// ─────────────────────────────────────────────────────────────────────────────
// UserPicker.tsx — 「发用户名片」：挑一个人，把 `[@用户/<用户名>]` 插进输入框
//
// 【谁来插】本组件只把选中的人交回调用方（RichComposer），**不自己写 textarea** ——
// 插入位置要在点工具栏按钮那一刻就捕获好（见 textarea-insert.ts 的 captureCaret），
// 那份状态住在输入区那一层。
//
// 【为什么是居中弹窗，而不是像表情那样的贴边面板】要输搜索词 → 必须抢焦点。贴边面板
// 的全部理由是「不抢焦点、光标全程留在 textarea 里」（StickerPicker 的文件头），而这
// 一条与搜索框天然冲突。既然焦点非走不可，就按 ImagePickerModal 那套居中弹窗来，并
// 用捕获好的选区把光标位置补回去。
//
// 【数据源】GET /api/chat/users?q=&include_self=1（core+ 才调得动；讨论与评论本来都是
// core+ 档）。⚠️ 它只搜得到 **core+ 用户** —— 非核心账号的名片仍然可以手打 token 发，
// 只是这个面板搜不到。见 docs/guide/内容引用语法指南.md。
//
// 【弹窗外壳】照抄 ImagePickerModal 的 `modal-overlay show` / `modal-dialog` /
// `modal-content` —— ⚠️ 展开类是 `show`，**不是**另一套 modal 系统的 `is-open`。
// 写错的表现是弹窗恒为 display:none（用户那边就是「点了没反应」），而接口与单测全都正常。
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useRef, useState } from 'react';
import { IdCard } from 'lucide-react';
import Avatar from './Avatar';

interface PickedUser {
  id: string;
  username: string;
}

/** 结果项（形状对齐 GET /api/chat/users 的 users[]）。 */
interface SearchUser {
  id: string;
  username: string;
  frame_url: string | null;
}

/** 输入停顿多久才发请求。太短会把每个字母都打成一次查询。 */
const DEBOUNCE_MS = 250;

export default function UserPicker({
  onClose,
  onPick,
}: {
  onClose: () => void;
  /** 选中一个人 → 交给调用方拼 token 并插入。 */
  onPick: (user: PickedUser) => void;
}) {
  const [query, setQuery] = useState('');
  const [users, setUsers] = useState<SearchUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // 搜索（带防抖）。query 为空时也请求一次 —— 服务端会返回最近注册的一批，
  // 打开面板就有东西可点，不用先想好名字。
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const qs = new URLSearchParams({ q: query.trim(), include_self: '1' });
          const res = await fetch(`/api/chat/users?${qs.toString()}`, {
            credentials: 'same-origin',
          });
          const data = (await res.json()) as { code?: number; users?: unknown };
          if (cancelled) return;
          if (data.code !== 200 || !Array.isArray(data.users)) {
            setFailed(true);
            setUsers([]);
            return;
          }
          setFailed(false);
          setUsers(parseUsers(data.users));
        } catch {
          if (!cancelled) {
            setFailed(true);
            setUsers([]);
          }
        } finally {
          if (!cancelled) setLoading(false);
        }
      })();
    }, DEBOUNCE_MS);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query]);

  // Esc 关掉（点遮罩关闭走的是外壳那层 onClick，与 ImagePickerModal 同款）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="modal-overlay show" onClick={onClose}>
      <div className="modal-dialog user-picker" onClick={(e) => e.stopPropagation()}>
        <div className="modal-content">
          <div className="modal-header">
            <h3 className="modal-title">发送用户名片</h3>
            <button type="button" className="chat-modal-close" onClick={onClose} aria-label="关闭">
              ×
            </button>
          </div>
          <div className="modal-body">
            <input
              ref={inputRef}
              type="search"
              className="form-control chat-new-search"
              placeholder="搜索用户名…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />

            <div className="user-picker__list">
              {loading ? (
                <div className="chat-new-empty">加载中…</div>
              ) : failed ? (
                <div className="chat-new-empty">搜索失败，请稍后重试</div>
              ) : users.length === 0 ? (
                <div className="chat-new-empty">
                  {query.trim() ? '没有匹配的用户' : '还没有可选的用户'}
                </div>
              ) : (
                users.map((u) => (
                  <button
                    key={u.id}
                    type="button"
                    className="user-picker__item"
                    onClick={() => onPick({ id: u.id, username: u.username })}
                  >
                    <Avatar
                      userId={u.id}
                      frameUrl={u.frame_url}
                      // 名字就在右边，头像图是装饰（与 Avatar 那一处「屏读器再念一遍
                      // 是噪音」的口径一致）
                      alt=""
                      loading="lazy"
                      imgClassName="user-picker__avatar"
                    />
                    <span className="user-picker__name">{u.username}</span>
                  </button>
                ))
              )}
            </div>

            <p className="user-picker__hint">
              <IdCard aria-hidden="true" />
              对方收到的是一张带头像的名片，点一下就进他的主页；不会给他发通知。
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

/** 严格挑出合法形状 —— 面板是纯展示组件，宁可少画几行也不要渲染出半个坏按钮。 */
function parseUsers(raw: unknown[]): SearchUser[] {
  const out: SearchUser[] = [];
  for (const u of raw) {
    if (!u || typeof u !== 'object') continue;
    const { id, username, frame_url } = u as Record<string, unknown>;
    if (typeof id !== 'string' || !id) continue;
    if (typeof username !== 'string' || !username) continue;
    out.push({ id, username, frame_url: typeof frame_url === 'string' ? frame_url : null });
  }
  return out;
}
