'use client';

// ─────────────────────────────────────────────────────────────────────────────
// AdminUserActions — 用户卡片的操作簇（对齐 Flask auth/management.html 的按钮 + 模态框）：
//   查看 / 发通知（站长）/ 禁言·解除禁言 / 禁言历史 / 认证·取消认证（站长）。
// 认证 = 设为 core，取消认证 = 设为 user，对应 Flask 的 promote/demote。
// 禁言 / 解除禁言 走 POST /api/admin/users/:id；角色变更走 PATCH。
// 发通知 → POST /api/admin/notify-user（对齐 Flask sendNotificationTo）。
// 禁言历史 → GET /api/users/:id/ban-history（对齐 Flask showBanHistory）。
// ─────────────────────────────────────────────────────────────────────────────

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';

export interface AdminUserActionsProps {
  user: {
    id: string;
    username: string;
    role: string;
    currentlyBanned: boolean;
  };
  isOwner: boolean;
  currentUserId: string;
}

const toast = (msg: string, type: 'success' | 'error' | 'info' | 'warning' = 'info') => {
  const w = window as unknown as { showToast?: (m: string, t: string) => void };
  if (w.showToast) w.showToast(msg, type);
};

// 单条禁言历史（对齐 Flask UserBan.to_dict()）。
interface BanRecord {
  id: number;
  banned_at: string | null;
  ban_until: string | null;
  reason: string;
  is_lifted: boolean | null;
  admin_username: string | null;
  lifted_at: string | null;
  lifted_by: string | null;
}

// 对齐 Flask showBanHistory 的 new Date(x).toLocaleString()。
const fmtTime = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : '');

export default function AdminUserActions({ user, isOwner, currentUserId }: AdminUserActionsProps) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [modal, setModal] = useState<null | 'ban' | 'unban' | 'notify' | 'banHistory'>(null);
  const [banHours, setBanHours] = useState('24');
  const [banReason, setBanReason] = useState('');
  const [unbanReason, setUnbanReason] = useState('');
  const [notifyType, setNotifyType] = useState('系统公告');
  const [notifyContent, setNotifyContent] = useState('');
  const [banHistory, setBanHistory] = useState<BanRecord[] | null>(null);
  const [banHistoryLoading, setBanHistoryLoading] = useState(false);

  // 对齐 Flask 发送通知模态框的通知类型预设。
  const NOTIFY_TYPES = ['系统公告', '维护通知', '功能更新', '用户提醒', '警告通知', '活动通知'];

  const isSelf = user.id === currentUserId;
  const banDisabled = isSelf || user.role === 'owner' || user.role === 'admin';

  async function call(url: string, method: string, payload: object, okMsg: string) {
    setBusy(true);
    try {
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (data.code === 200) {
        toast(data.message || okMsg, 'success');
        setModal(null);
        setTimeout(() => router.refresh(), 300);
      } else {
        toast(data.message || '操作失败', 'error');
      }
    } catch {
      toast('操作失败，请稍后重试', 'error');
    } finally {
      setBusy(false);
    }
  }

  const promote = () =>
    call(`/api/admin/users/${user.id}`, 'PATCH', { role: 'core' }, '用户认证成功！');
  const demote = () =>
    call(`/api/admin/users/${user.id}`, 'PATCH', { role: 'user' }, '取消认证成功！');

  function confirmBan() {
    const hours = parseFloat(banHours);
    if (!hours || hours <= 0) {
      toast('请输入有效的禁言时长', 'warning');
      return;
    }
    if (!banReason.trim()) {
      toast('请输入禁言原因', 'warning');
      return;
    }
    call(
      `/api/admin/users/${user.id}`,
      'POST',
      { action: 'ban', hours, reason: banReason.trim() },
      '禁言设置成功！'
    );
  }

  function confirmUnban() {
    call(
      `/api/admin/users/${user.id}`,
      'POST',
      { action: 'unban', reason: unbanReason.trim() },
      '禁言解除成功！'
    );
  }

  function sendNotification() {
    if (!notifyContent.trim()) {
      toast('请输入通知内容', 'warning');
      return;
    }
    call(
      '/api/admin/notify-user',
      'POST',
      { recipientId: user.id, action: notifyType, detail: notifyContent.trim() },
      '通知发送成功！'
    );
  }

  // 拉取禁言历史（对齐 Flask auth.user_ban_history / showBanHistory）。
  async function openBanHistory() {
    setModal('banHistory');
    setBanHistory(null);
    setBanHistoryLoading(true);
    try {
      const res = await fetch(`/api/users/${user.id}/ban-history`, {
        credentials: 'same-origin',
      });
      const data = await res.json();
      if (data.code === 200 && Array.isArray(data.ban_history)) {
        setBanHistory(data.ban_history as BanRecord[]);
      } else {
        setBanHistory([]);
        toast(data.message || '获取禁言历史失败', 'error');
      }
    } catch {
      setBanHistory([]);
      toast('获取禁言历史失败', 'error');
    } finally {
      setBanHistoryLoading(false);
    }
  }

  return (
    <div className="user-card__buttons">
      <Link href={`/u/${user.id}`} className="btn btn-sm btn-info">
        查看
      </Link>

      {isOwner && (
        <button
          type="button"
          className="btn btn-sm btn-secondary"
          disabled={busy}
          onClick={() => {
            setNotifyType('系统公告');
            setNotifyContent('');
            setModal('notify');
          }}
        >
          发通知
        </button>
      )}

      {user.currentlyBanned ? (
        <button
          type="button"
          className="btn btn-sm btn-success"
          disabled={busy}
          onClick={() => {
            setUnbanReason('');
            setModal('unban');
          }}
        >
          解除禁言
        </button>
      ) : (
        <button
          type="button"
          className="btn btn-sm btn-warning"
          disabled={busy || banDisabled}
          onClick={() => {
            setBanHours('24');
            setBanReason('');
            setModal('ban');
          }}
        >
          禁言
        </button>
      )}

      {user.currentlyBanned && (
        <button
          type="button"
          className="btn btn-sm btn-info"
          disabled={busy}
          onClick={openBanHistory}
        >
          禁言历史
        </button>
      )}

      {isOwner &&
        (user.role === 'core' ? (
          <button type="button" className="btn btn-sm btn-warning" disabled={busy} onClick={demote}>
            取消认证
          </button>
        ) : (
          <button type="button" className="btn btn-sm btn-success" disabled={busy} onClick={promote}>
            认证
          </button>
        ))}

      {/* 禁言用户模态框 */}
      {modal === 'ban' && (
        <div className="modal-overlay show" onClick={() => !busy && setModal(null)}>
          <div className="modal-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="modal-content">
              <div className="modal-header">
                <h3 className="modal-title">禁言用户</h3>
                <button type="button" className="btn-close" disabled={busy} onClick={() => setModal(null)}>
                  ×
                </button>
              </div>
              <div className="modal-body">
                <div className="form-group">
                  <label className="form-label">用户</label>
                  <input type="text" className="form-control" readOnly value={user.username} />
                </div>
                <div className="form-group">
                  <label className="form-label">禁言时长（小时）</label>
                  <input
                    type="number"
                    className="form-control"
                    min="1"
                    value={banHours}
                    onChange={(e) => setBanHours(e.target.value)}
                  />
                </div>
                <div className="form-group">
                  <label className="form-label">禁言原因</label>
                  <textarea
                    className="form-control"
                    rows={3}
                    placeholder="请输入禁言原因..."
                    value={banReason}
                    onChange={(e) => setBanReason(e.target.value)}
                  />
                </div>
              </div>
              <div className="modal-footer">
                <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => setModal(null)}>
                  取消
                </button>
                <button type="button" className="btn btn-warning" disabled={busy} onClick={confirmBan}>
                  确认禁言
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 解除禁言模态框 */}
      {modal === 'unban' && (
        <div className="modal-overlay show" onClick={() => !busy && setModal(null)}>
          <div className="modal-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="modal-content">
              <div className="modal-header">
                <h3 className="modal-title">解除禁言</h3>
                <button type="button" className="btn-close" disabled={busy} onClick={() => setModal(null)}>
                  ×
                </button>
              </div>
              <div className="modal-body">
                <div className="form-group">
                  <label className="form-label">用户</label>
                  <input type="text" className="form-control" readOnly value={user.username} />
                </div>
                <div className="form-group">
                  <label className="form-label">解除原因（可选）</label>
                  <textarea
                    className="form-control"
                    rows={3}
                    placeholder="请输入解除禁言的原因..."
                    value={unbanReason}
                    onChange={(e) => setUnbanReason(e.target.value)}
                  />
                </div>
              </div>
              <div className="modal-footer">
                <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => setModal(null)}>
                  取消
                </button>
                <button type="button" className="btn btn-success" disabled={busy} onClick={confirmUnban}>
                  确认解除
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 发送通知模态框（对齐 Flask notificationModal） */}
      {modal === 'notify' && (
        <div className="modal-overlay show" onClick={() => !busy && setModal(null)}>
          <div className="modal-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="modal-content">
              <div className="modal-header">
                <h3 className="modal-title">发送通知</h3>
                <button type="button" className="btn-close" disabled={busy} onClick={() => setModal(null)}>
                  ×
                </button>
              </div>
              <div className="modal-body">
                <div className="form-group">
                  <label className="form-label">接收用户</label>
                  <input type="text" className="form-control" readOnly value={user.username} />
                </div>
                <div className="form-group">
                  <label className="form-label">通知类型</label>
                  <select
                    className="form-control"
                    value={notifyType}
                    onChange={(e) => setNotifyType(e.target.value)}
                  >
                    {NOTIFY_TYPES.map((t) => (
                      <option key={t} value={t}>
                        {t}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="form-group">
                  <label className="form-label">通知内容</label>
                  <textarea
                    className="form-control"
                    rows={4}
                    placeholder="请输入通知内容..."
                    value={notifyContent}
                    onChange={(e) => setNotifyContent(e.target.value)}
                  />
                </div>
              </div>
              <div className="modal-footer">
                <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => setModal(null)}>
                  取消
                </button>
                <button type="button" className="btn btn-primary" disabled={busy} onClick={sendNotification}>
                  发送
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 禁言历史模态框（对齐 Flask showBanHistory） */}
      {modal === 'banHistory' && (
        <div className="modal-overlay show" onClick={() => setModal(null)}>
          <div className="modal-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="modal-content">
              <div className="modal-header">
                <h3 className="modal-title">禁言历史</h3>
                <button type="button" className="btn-close" onClick={() => setModal(null)}>
                  ×
                </button>
              </div>
              <div className="modal-body">
                <p style={{ marginTop: 0 }}>
                  用户 &quot;{user.username}&quot; 的禁言历史：
                </p>
                {banHistoryLoading ? (
                  <p className="text-muted" style={{ margin: 0 }}>
                    加载中…
                  </p>
                ) : banHistory && banHistory.length > 0 ? (
                  <div
                    style={{
                      background: 'var(--color-background-subtle)',
                      padding: '15px',
                      borderRadius: '8px',
                      maxHeight: '400px',
                      overflowY: 'auto',
                    }}
                  >
                    {banHistory.map((ban, index) => (
                      <div
                        key={ban.id}
                        style={{ marginBottom: index === banHistory.length - 1 ? 0 : '1rem' }}
                      >
                        <div>
                          {index + 1}. 禁言时间：{fmtTime(ban.banned_at)}
                        </div>
                        <div>结束时间：{fmtTime(ban.ban_until)}</div>
                        <div>状态：{ban.is_lifted ? '已解除' : '进行中'}</div>
                        <div>原因：{ban.reason}</div>
                        <div>执行者：{ban.admin_username}</div>
                        {ban.is_lifted && ban.lifted_by && (
                          <>
                            <div>解除时间：{fmtTime(ban.lifted_at)}</div>
                            <div>解除者：{ban.lifted_by}</div>
                          </>
                        )}
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-muted" style={{ margin: 0 }}>
                    暂无禁言记录
                  </p>
                )}
              </div>
              <div className="modal-footer">
                <button type="button" className="btn btn-secondary" onClick={() => setModal(null)}>
                  关闭
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
