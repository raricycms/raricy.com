'use client';

import { useState } from 'react';
import Link from 'next/link';
import { ArrowRight, Bell } from 'lucide-react';
import type { NotificationDTO } from '@/lib/notification-service';

declare global {
  interface Window {
    showToast?: (message: string, type?: string) => void;
  }
}

function toast(message: string, type: string) {
  if (typeof window !== 'undefined' && window.showToast) window.showToast(message, type);
}

// 紧凑通知列表：初始数据由 Server Component 注入。标记已读 / 删除均走 API 后就地更新 UI，
// 交互（确认框 + toast 反馈）对齐 Flask notifications.html。
export default function NotificationItems({ initial }: { initial: NotificationDTO[] }) {
  const [items, setItems] = useState<NotificationDTO[]>(initial);
  const [busy, setBusy] = useState<string | null>(null); // 正在处理的 id / 'all' / 'read'

  async function markOne(id: string) {
    if (busy) return;
    setBusy(id);
    try {
      const res = await fetch(`/api/notifications/${id}/read`, {
        method: 'POST',
        credentials: 'same-origin',
      });
      const data = await res.json();
      if (data.code === 200) {
        setItems((prev) => prev.map((n) => (n.id === id ? { ...n, read: true } : n)));
        toast('已标记为已读', 'success');
      } else {
        toast('操作失败: ' + (data.message ?? ''), 'error');
      }
    } catch {
      toast('操作失败，请重试', 'error');
    } finally {
      setBusy(null);
    }
  }

  async function markAll() {
    if (busy) return;
    if (!confirm('确定要标记所有通知为已读吗？')) return;
    setBusy('all');
    try {
      const res = await fetch('/api/notifications/read-all', {
        method: 'POST',
        credentials: 'same-origin',
      });
      const data = await res.json();
      if (data.code === 200) {
        setItems((prev) => prev.map((n) => ({ ...n, read: true })));
        toast(data.message ?? '已全部标记为已读', 'success');
      } else {
        toast('操作失败: ' + (data.message ?? ''), 'error');
      }
    } catch {
      toast('操作失败，请重试', 'error');
    } finally {
      setBusy(null);
    }
  }

  async function deleteOne(id: string) {
    if (busy) return;
    if (!confirm('确定要删除这个通知吗？此操作不可恢复！')) return;
    setBusy(id);
    try {
      const res = await fetch(`/api/notifications/${id}/delete`, {
        method: 'DELETE',
        credentials: 'same-origin',
      });
      const data = await res.json();
      if (data.code === 200) {
        setItems((prev) => prev.filter((n) => n.id !== id));
        toast('通知已删除', 'success');
      } else {
        toast('操作失败: ' + (data.message ?? ''), 'error');
      }
    } catch {
      toast('操作失败，请重试', 'error');
    } finally {
      setBusy(null);
    }
  }

  async function deleteRead() {
    if (busy) return;
    if (!confirm('确定要删除所有已读通知吗？此操作不可恢复！')) return;
    setBusy('read');
    try {
      const res = await fetch('/api/notifications/delete-read', {
        method: 'DELETE',
        credentials: 'same-origin',
      });
      const data = await res.json();
      if (data.code === 200) {
        setItems((prev) => prev.filter((n) => !n.read));
        toast(data.message ?? '已删除已读通知', 'success');
      } else {
        toast('操作失败: ' + (data.message ?? ''), 'error');
      }
    } catch {
      toast('操作失败，请重试', 'error');
    } finally {
      setBusy(null);
    }
  }

  // 对齐 Flask datetime_format('%m-%d %H:%M')：不含年份。
  // 一律 getUTC* 读：库内时间戳是「UTC+8 墙上时间贴 Z」（见 src/lib/db-time.ts），
  // 本地 getter 会被浏览器时区再平移一次（UTC+8 下整体 +8 小时）。
  function fmt(ts: string | null): string {
    if (!ts) return '';
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) return '';
    const p = (n: number) => String(n).padStart(2, '0');
    return `${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
  }

  return (
    <>
      <div className="btn-group">
        <button
          className="action-btn"
          onClick={markAll}
          disabled={busy !== null}
        >
          全部标记已读
        </button>
        <button
          className="action-btn btn-danger"
          type="button"
          onClick={deleteRead}
          disabled={busy !== null}
        >
          删除已读
        </button>
      </div>

      {items.length === 0 ? (
        <div className="empty-state">
          <div className="empty-state-icon" aria-hidden="true">
            <Bell />
          </div>
          <h3>暂无通知</h3>
          <p>你还没有任何通知，保持关注最新动态！</p>
        </div>
      ) : (
        <div id="notifications-list">
          {items.map((n) => (
            <div
              key={n.id}
              className={`notification-card${n.read ? '' : ' unread'}`}
              data-id={n.id}
            >
              <div className="notification-header">
                <span className="notification-action">{n.action}</span>
                {!n.read && (
                  <span className="notification-unread-badge">未读</span>
                )}
                <span className="notification-meta">
                  {fmt(n.timestamp)} ·{' '}
                  {n.actor && n.actor.id ? (
                    <Link href={`/u/${n.actor.id}`}>{n.actor.username}</Link>
                  ) : (
                    '系统'
                  )}
                </span>
                <span className="notification-actions">
                  {!n.read && (
                    <button
                      className="btn-mark-read"
                      onClick={() => markOne(n.id)}
                      disabled={busy !== null}
                    >
                      已读
                    </button>
                  )}
                  <button
                    className="btn-delete"
                    type="button"
                    onClick={() => deleteOne(n.id)}
                    disabled={busy !== null}
                  >
                    删除
                  </button>
                </span>
              </div>
              {n.detail && (
                <p className="notification-content">{n.detail}</p>
              )}
              {n.object.type === 'blog' && n.object.id && (
                <Link href={`/blog/${n.object.id}`} className="notification-blog-link">
                  查看博客 <ArrowRight aria-hidden="true" />
                </Link>
              )}
              {/* @ 提及通知（objectType='chat_channel'，objectId=频道 id，见 chat-service） */}
              {n.object.type === 'chat_channel' && n.object.id && (
                <Link
                  href={`/chat?channel=${encodeURIComponent(n.object.id)}`}
                  className="notification-blog-link"
                >
                  查看聊天 <ArrowRight aria-hidden="true" />
                </Link>
              )}
            </div>
          ))}
        </div>
      )}
    </>
  );
}