'use client';

// ─────────────────────────────────────────────────────────────────────────────
// ChatSearchModal.tsx — 当前会话内的消息搜索
//
// 复用发起私聊弹窗的样式（.chat-new-modal / .chat-new-list / .chat-pager），
// 防抖 250ms 走 /api/chat/channels/:id/search。点一条结果 → 关弹窗 + 跳到该消息
// （由 ChatApp 的 jumpToMessage 负责滚动与高亮）。
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useRef, useState } from 'react';
import { Search } from 'lucide-react';
import type { ChatMessageDTO } from '@/lib/chat-shared';
import { fmtTime } from './ChatMessageItem';

const PER_PAGE = 20;

export default function ChatSearchModal({
  channelId,
  channelTitle,
  onClose,
  onJump,
}: {
  channelId: string;
  channelTitle: string;
  onClose: () => void;
  onJump: (messageId: number) => void;
}) {
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<ChatMessageDTO[]>([]);
  const [loading, setLoading] = useState(false);
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(1);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // 防抖搜索（与 NewChatModal 同一套写法：条件变化回第 1 页）
  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setHits([]);
      setPage(1);
      setPages(1);
      return;
    }
    const timer = setTimeout(() => {
      void (async () => {
        setLoading(true);
        try {
          const qs = new URLSearchParams({ q, page: '1' });
          const res = await fetch(`/api/chat/channels/${channelId}/search?${qs.toString()}`, {
            credentials: 'same-origin',
          });
          const data = (await res.json()) as {
            code: number;
            messages?: ChatMessageDTO[];
            total?: number;
          };
          if (data.code === 200 && Array.isArray(data.messages)) {
            setHits(data.messages);
            setPage(1);
            setPages(Math.max(1, Math.ceil((Number(data.total) || 0) / PER_PAGE)));
          }
        } catch {
          /* 忽略：保留旧结果 */
        } finally {
          setLoading(false);
        }
      })();
    }, 250);
    return () => clearTimeout(timer);
  }, [query, channelId]);

  async function goPage(p: number) {
    const q = query.trim();
    if (!q || loading) return;
    setLoading(true);
    try {
      const qs = new URLSearchParams({ q, page: String(p) });
      const res = await fetch(`/api/chat/channels/${channelId}/search?${qs.toString()}`, {
        credentials: 'same-origin',
      });
      const data = (await res.json()) as {
        code: number;
        messages?: ChatMessageDTO[];
        total?: number;
      };
      if (data.code === 200 && Array.isArray(data.messages)) {
        setHits(data.messages);
        setPage(p);
        setPages(Math.max(1, Math.ceil((Number(data.total) || 0) / PER_PAGE)));
      }
    } catch {
      /* 忽略 */
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="modal-overlay show" onClick={onClose}>
      <div className="modal-dialog chat-new-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-content">
          <div className="modal-header">
            <h3 className="modal-title">搜索「{channelTitle}」</h3>
            <button type="button" className="chat-modal-close" onClick={onClose} aria-label="关闭">
              ×
            </button>
          </div>
          <div className="modal-body">
            <input
              ref={inputRef}
              type="search"
              className="form-control chat-new-search"
              placeholder="搜索消息内容…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <div className="chat-new-list">
              {loading ? (
                <div className="chat-new-empty">搜索中…</div>
              ) : !query.trim() ? (
                <div className="chat-new-empty">输入关键词开始搜索</div>
              ) : hits.length === 0 ? (
                <div className="chat-new-empty">没有匹配的消息</div>
              ) : (
                hits.map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    className="chat-search-item"
                    onClick={() => {
                      onClose();
                      onJump(m.id);
                    }}
                  >
                    <span className="chat-search-item__head">
                      <span className="chat-search-item__author">{m.author.username}</span>
                      <span className="chat-search-item__time">{fmtTime(m.created_at)}</span>
                    </span>
                    <span className="chat-search-item__text">{m.content}</span>
                  </button>
                ))
              )}
            </div>
            <div className="chat-pager">
              <button
                type="button"
                className="chat-pager__btn"
                disabled={loading || page <= 1}
                onClick={() => void goPage(page - 1)}
              >
                上一页
              </button>
              <span className="chat-pager__info">
                第 {page} 页 / 共 {pages} 页
              </span>
              <button
                type="button"
                className="chat-pager__btn"
                disabled={loading || page >= pages}
                onClick={() => void goPage(page + 1)}
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

/** 搜索入口按钮（放在会话头部），图标 + 无障碍标签。 */
export function SearchButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      className="chat-main__search"
      onClick={onClick}
      title="搜索消息"
      aria-label="搜索消息"
    >
      <Search aria-hidden="true" />
    </button>
  );
}
