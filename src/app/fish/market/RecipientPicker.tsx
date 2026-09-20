'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Avatar from '@/app/components/Avatar';

// 收款人选择弹窗 —— 搜索任意用户（服务端已排除自己）。
//
// 结构与交互对齐讨论页的「发起私聊」弹窗（NewChatModal）：200ms 防抖搜索 + 分页。
// 但类名是市场自己的（.market-*）：那边是讨论域的 BEM，两处复用同一套类名会让
// 「改讨论弹窗样式」静默改到这里（frontend-styles §11.1 讲的 drift）。
// 通用外壳（.modal-overlay / .modal-dialog / .modal-content）是共用组件，照用。

declare global {
  interface Window {
    showToast?: (message: string, type?: string) => void;
  }
}

// ⚠️ 手抄服务端 fish-market-service.TransferTarget 的形状（客户端组件 import 不了
// 拖着 prisma 的那个模块）。加字段忘了这里 → 那一处静默地没有框。
export interface TransferTarget {
  id: string;
  username: string;
  frame_url: string | null;
}

const PER_PAGE = 20;

export default function RecipientPicker({
  onPick,
  onClose,
}: {
  onPick: (u: TransferTarget) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const [users, setUsers] = useState<TransferTarget[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(1);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const load = useCallback(async (q: string, p: number) => {
    setLoading(true);
    try {
      const qs = new URLSearchParams({
        limit: String(PER_PAGE),
        offset: String((p - 1) * PER_PAGE),
      });
      const trimmed = q.trim();
      if (trimmed) qs.set('q', trimmed);
      const res = await fetch(`/api/fish/market/users?${qs.toString()}`, {
        credentials: 'same-origin',
      });
      const data = await res.json();
      if (data.code === 200 && Array.isArray(data.users)) {
        setUsers(data.users as TransferTarget[]);
        setPage(p);
        setPages(Math.max(1, Math.ceil((Number(data.total) || 0) / PER_PAGE)));
      }
    } catch {
      /* 忽略：下一次输入会重试 */
    } finally {
      setLoading(false);
    }
  }, []);

  // 输入防抖搜索；条件变化回第 1 页
  useEffect(() => {
    const t = setTimeout(() => void load(query, 1), 200);
    return () => clearTimeout(t);
  }, [query, load]);

  return (
    <div className="modal-overlay show" onClick={onClose}>
      <div
        className="modal-dialog market-picker"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="选择收款人"
      >
        <div className="modal-content">
          <div className="modal-header">
            <h3 className="modal-title">选择收款人</h3>
            <button type="button" className="market-modal-close" onClick={onClose} aria-label="关闭">
              ×
            </button>
          </div>
          <div className="modal-body">
            <input
              ref={inputRef}
              type="search"
              className="form-control market-picker__search"
              placeholder="搜索用户名…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <div className="market-picker__list">
              {loading ? (
                <div className="market-picker__empty">加载中…</div>
              ) : users.length === 0 ? (
                <div className="market-picker__empty">没有匹配的用户</div>
              ) : (
                users.map((u) => (
                  <button
                    key={u.id}
                    type="button"
                    className="market-picker__item"
                    onClick={() => onPick(u)}
                  >
                    <Avatar
                      userId={u.id}
                      frameUrl={u.frame_url}
                      alt=""
                      loading="lazy"
                      imgClassName="market-picker__avatar"
                    />
                    <span className="market-picker__name">{u.username}</span>
                  </button>
                ))
              )}
            </div>
            <div className="market-picker__pager">
              <button
                type="button"
                className="market-picker__page-btn"
                disabled={loading || page <= 1}
                onClick={() => void load(query, page - 1)}
              >
                上一页
              </button>
              <span className="market-picker__page-info">
                第 {page} 页 / 共 {pages} 页
              </span>
              <button
                type="button"
                className="market-picker__page-btn"
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
