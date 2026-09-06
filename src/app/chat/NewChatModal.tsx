'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ChatChannelDTO, ChatUserLite } from '@/lib/chat-shared';

declare global {
  interface Window {
    showToast?: (message: string, type?: string) => void;
  }
}

const ROLE_LABEL: Record<string, string> = {
  owner: '站长',
  admin: '管理员',
  core: '认证',
};

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
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const load = useCallback(async (q: string) => {
    setLoading(true);
    try {
      const qs = q.trim() ? `?q=${encodeURIComponent(q.trim())}` : '';
      const res = await fetch(`/api/chat/users${qs}`, { credentials: 'same-origin' });
      const data = await res.json();
      if (data.code === 200 && Array.isArray(data.users)) {
        setUsers(data.users as ChatUserLite[]);
      }
    } catch {
      /* 忽略 */
    } finally {
      setLoading(false);
    }
  }, []);

  // 输入防抖搜索；清空时回到默认列表
  useEffect(() => {
    const t = setTimeout(() => void load(query), 200);
    return () => clearTimeout(t);
  }, [query, load]);

  const filtered = useMemo(() => users, [users]);

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
      if (data.code === 200 && data.channel) {
        onCreated(data.channel as ChatChannelDTO);
      } else {
        window.showToast?.(data.message || '发起失败', 'error');
      }
    } catch {
      window.showToast?.('网络错误，请重试', 'error');
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="modal-overlay show" onClick={() => !busyId && onClose()}>
      <div className="modal-dialog chat-new-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-content">
          <div className="modal-header">
            <h3 className="modal-title">发起私聊</h3>
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
            <div className="chat-new-list">
              {loading ? (
                <div className="chat-new-empty">加载中…</div>
              ) : filtered.length === 0 ? (
                <div className="chat-new-empty">没有匹配的用户</div>
              ) : (
                filtered.map((u) => {
                  const label = ROLE_LABEL[u.role] ?? '认证';
                  const isSelf = u.id === currentUserId;
                  return (
                    <button
                      key={u.id}
                      type="button"
                      className="chat-new-item"
                      disabled={isSelf || busyId === u.id}
                      onClick={() => void start(u)}
                    >
                      <img className="chat-new-item__avatar" src={`/api/avatar/${u.id}`} alt="" loading="lazy" />
                      <span className="chat-new-item__name">{u.username}</span>
                      {isSelf && <span className="chat-new-item__tag">（自己）</span>}
                      <span className="chat-new-item__role">{label}</span>
                    </button>
                  );
                })
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}