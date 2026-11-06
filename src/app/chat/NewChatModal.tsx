'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChatChannelDTO, ChatUserLite } from '@/lib/chat-shared';
import Avatar from '@/app/components/Avatar';
import { showToast } from '@/app/components/toast';

const PER_PAGE = 20;

export default function NewChatModal({
  currentUserId,
  onClose,
  onCreated,
}: {
  currentUserId: string;
  onClose: () => void;
  onCreated: (ch: ChatChannelDTO) => void;
}) {
  const [query, setQuery] = useState('');
  const [users, setUsers] = useState<ChatUserLite[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(1);
  const inputRef = useRef<HTMLInputElement>(null);
  /** 请求序号：慢网下旧搜索响应不能覆盖新结果（与 ChatSearchModal 同一套）。 */
  const reqSeqRef = useRef(0);
  /** 已关闭：在飞请求回来时不得再切频道 / 弹 toast（关闭即放弃）。 */
  const closedRef = useRef(false);
  useEffect(() => () => {
    closedRef.current = true;
    reqSeqRef.current++;
  }, []);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const requestClose = useCallback(() => {
    if (busyId) return; // 发起请求在途：关掉会让人以为没发出去（两条关闭路径同一判据）
    closedRef.current = true;
    reqSeqRef.current++;
    onClose();
  }, [busyId, onClose]);

  const load = useCallback(async (q: string, p: number) => {
    const seq = ++reqSeqRef.current;
    setLoading(true);
    try {
      const qs = new URLSearchParams({
        limit: String(PER_PAGE),
        offset: String((p - 1) * PER_PAGE),
      });
      const trimmed = q.trim();
      if (trimmed) qs.set('q', trimmed);
      const res = await fetch(`/api/chat/users?${qs.toString()}`, { credentials: 'same-origin' });
      const data = await res.json();
      if (seq !== reqSeqRef.current) return;
      if (data.code === 200 && Array.isArray(data.users)) {
        setUsers(data.users as ChatUserLite[]);
        setPage(p);
        setPages(Math.max(1, Math.ceil((Number(data.total) || 0) / PER_PAGE)));
      }
    } catch {
      /* 忽略 */
    } finally {
      if (seq === reqSeqRef.current) setLoading(false);
    }
  }, []);

  // 输入防抖搜索；条件变化回第 1 页
  useEffect(() => {
    const t = setTimeout(() => void load(query, 1), 200);
    return () => {
      clearTimeout(t);
      reqSeqRef.current++; // 条件变了：在飞请求作废
    };
  }, [query, load]);

  async function start(user: ChatUserLite) {
    if (busyId) return;
    if (user.id === currentUserId) return;
    setBusyId(user.id);
    try {
      const res = await fetch('/api/chat/channels', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ user_id: user.id }),
      });
      const data = await res.json();
      // 关闭后到达的响应不再切频道（否则点了 × 还是被推进新会话）
      if (closedRef.current) return;
      if (data.code === 200 && data.channel) {
        onCreated(data.channel as ChatChannelDTO);
      } else {
        showToast(data.message || '发起失败', 'error');
      }
    } catch {
      if (!closedRef.current) showToast('网络错误，请重试', 'error');
    } finally {
      if (!closedRef.current) setBusyId(null);
    }
  }

  return (
    <div className="modal-overlay show" onClick={requestClose}>
      <div className="modal-dialog chat-new-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-content">
          <div className="modal-header">
            <h3 className="modal-title">发起私聊</h3>
            <button type="button" className="chat-modal-close" onClick={requestClose} aria-label="关闭">
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
            <div className="chat-new-list">
              {loading ? (
                <div className="chat-new-empty">加载中…</div>
              ) : users.length === 0 ? (
                <div className="chat-new-empty">没有匹配的用户</div>
              ) : (
                users.map((u) => {
                  const isSelf = u.id === currentUserId;
                  return (
                    <button
                      key={u.id}
                      type="button"
                      className="chat-new-item"
                      disabled={isSelf || busyId === u.id}
                      onClick={() => void start(u)}
                    >
                      <Avatar
                        userId={u.id}
                        frameUrl={u.frame_url}
                        alt=""
                        loading="lazy"
                        imgClassName="chat-new-item__avatar"
                      />
                      <span className="chat-new-item__name">{u.username}</span>
                      {isSelf && <span className="chat-new-item__tag">（自己）</span>}
                    </button>
                  );
                })
              )}
            </div>
            <div className="chat-pager">
              <button
                type="button"
                className="chat-pager__btn"
                disabled={loading || page <= 1}
                onClick={() => void load(query, page - 1)}
              >
                上一页
              </button>
              <span className="chat-pager__info numeric">
                第 {page} 页 / 共 {pages} 页
              </span>
              <button
                type="button"
                className="chat-pager__btn"
                disabled={loading || page >= pages}
                onClick={() => void load(query, page + 1)}
              >
                下一页
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
