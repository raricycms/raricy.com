'use client';

// ─────────────────────────────────────────────────────────────────────────────
// 通知发送中心（对齐 Flask auth/admin_notifications.html）：
//   • 发送方式单选：发送给指定用户 / 群发通知
//   • 指定用户面板：可搜索用户列表 + 编写表单（通知类型 / 内容 / 关联对象类型·ID）
//   • 群发面板：目标用户组 + 通知类型 + 关联对象类型·ID + 实时目标用户数量预览
// 群发走 POST /api/admin/broadcast（已支持 objectType/objectId）。
// 单用户发送走 POST /api/admin/notify-user（对齐 Flask sendNotificationToUser）。
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useMemo, useState } from 'react';

// 目标用户群标签逐字对齐 Flask admin_notifications.html 的 targetGroup 选项。
const GROUPS: Array<{ value: string; label: string }> = [
  { value: 'all', label: '所有用户' },
  { value: 'authenticated', label: '认证用户' },
  { value: 'normal', label: '普通用户' },
];

// 关联对象类型选项，逐字对齐 Flask objectType / broadcastObjectType。
const OBJECT_TYPES: Array<{ value: string; label: string }> = [
  { value: '', label: '无关联对象' },
  { value: 'blog', label: '博客文章' },
  { value: 'user', label: '用户' },
  { value: 'system', label: '系统' },
];

interface UserLite {
  id: string;
  username: string;
  email: string;
  role: string;
}

const ROLE_BADGE: Record<string, { cls: string; label: string }> = {
  owner: { cls: 'badge-danger', label: '站长' },
  admin: { cls: 'badge-danger', label: '管理员' },
  core: { cls: 'badge-success', label: '认证用户' },
  user: { cls: 'badge-secondary', label: '普通用户' },
};

export default function AdminBroadcastPage() {
  const [sendMode, setSendMode] = useState<'user' | 'all'>('user');

  // ── 群发表单状态 ──
  const [action, setAction] = useState('系统通知');
  const [detail, setDetail] = useState('');
  const [targetGroup, setTargetGroup] = useState('all');
  const [objectType, setObjectType] = useState('');
  const [objectId, setObjectId] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);

  // ── 指定用户表单状态 ──
  const [users, setUsers] = useState<UserLite[]>([]);
  const [userSearch, setUserSearch] = useState('');
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const [selectedUsername, setSelectedUsername] = useState('');
  const [userAction, setUserAction] = useState('系统公告');
  const [userDetail, setUserDetail] = useState('');
  const [userObjectType, setUserObjectType] = useState('');
  const [userObjectId, setUserObjectId] = useState('');

  const toast = (text: string, type: 'success' | 'error' | 'info' | 'warning' = 'info') => {
    const w = window as unknown as { showToast?: (m: string, t: string) => void };
    if (w.showToast) w.showToast(text, type);
  };

  // 拉取用户列表用于「指定用户」面板与群发预览计数。
  useEffect(() => {
    let cancelled = false;
    fetch('/api/admin/users?perPage=100', { credentials: 'same-origin' })
      .then((r) => r.json())
      .then((data) => {
        if (cancelled || data.code !== 200 || !Array.isArray(data.users)) return;
        setUsers(
          data.users.map((u: { id: string; username: string; email: string; role: string }) => ({
            id: u.id,
            username: u.username,
            email: u.email,
            role: u.role,
          }))
        );
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  // 实时目标用户数量（对齐 Flask updateTargetUserCount，按已加载用户列表计数）。
  const targetUserCount = useMemo(() => {
    return users.filter((u) => {
      const isCore = ['core', 'admin', 'owner'].includes(u.role);
      if (targetGroup === 'all') return true;
      if (targetGroup === 'authenticated') return isCore;
      if (targetGroup === 'normal') return u.role === 'user';
      return false;
    }).length;
  }, [users, targetGroup]);

  const filteredUsers = useMemo(() => {
    const q = userSearch.trim().toLowerCase();
    if (!q) return users;
    return users.filter(
      (u) => u.username.toLowerCase().includes(q) || u.email.toLowerCase().includes(q)
    );
  }, [users, userSearch]);

  async function submitBroadcast(e: React.FormEvent) {
    e.preventDefault();
    if (!detail.trim() || busy) return;
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch('/api/admin/broadcast', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          action,
          detail,
          targetGroup,
          objectType: objectType || null,
          objectId: objectId || null,
        }),
      });
      const data = await res.json();
      const ok = data.code === 200;
      setMsg({ text: data.message ?? (ok ? '已发送' : '发送失败'), ok });
      if (ok) setDetail('');
    } catch {
      setMsg({ text: '网络错误', ok: false });
    } finally {
      setBusy(false);
    }
  }

  async function submitToUser(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    if (!selectedUserId) {
      toast('请先选择要接收通知的用户', 'warning');
      return;
    }
    if (!userAction.trim() || !userDetail.trim()) {
      toast('请填写完整的通知信息', 'warning');
      return;
    }
    setBusy(true);
    try {
      const res = await fetch('/api/admin/notify-user', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          recipientId: selectedUserId,
          action: userAction,
          detail: userDetail,
          objectType: userObjectType || null,
          objectId: userObjectId || null,
        }),
      });
      const data = await res.json();
      if (data.code === 200) {
        toast(data.message ?? '通知发送成功', 'success');
        clearUserForm();
      } else {
        toast(data.message ?? '发送失败', 'error');
      }
    } catch {
      toast('网络错误', 'error');
    } finally {
      setBusy(false);
    }
  }

  function clearUserForm() {
    setSelectedUserId(null);
    setSelectedUsername('');
    setUserAction('系统公告');
    setUserDetail('');
    setUserObjectType('');
    setUserObjectId('');
  }

  return (
    <>
      <section className="admin-hero">
        <h1>通知发送中心</h1>
        <p>向指定用户或用户组发送通知，群发忽略接收者的通知偏好设置。</p>
      </section>

      <div className="admin-container">
        <div className="notification-card">
          {/* 发送方式单选 */}
          <div className="send-options">
            <h4 className="mb-3">选择发送方式</h4>
            <div className="btn-group w-100" role="group">
              <input
                type="radio"
                className="btn-check"
                name="sendMode"
                id="sendToUser"
                autoComplete="off"
                checked={sendMode === 'user'}
                onChange={() => setSendMode('user')}
              />
              <label className="btn btn-outline-primary" htmlFor="sendToUser">
                发送给指定用户
              </label>

              <input
                type="radio"
                className="btn-check"
                name="sendMode"
                id="sendToAll"
                autoComplete="off"
                checked={sendMode === 'all'}
                onChange={() => setSendMode('all')}
              />
              <label className="btn btn-outline-success" htmlFor="sendToAll">
                群发通知
              </label>
            </div>
          </div>

          {/* 发送给指定用户 */}
          {sendMode === 'user' && (
            <div className="row">
              <div className="col-md-4">
                <h5>选择用户</h5>
                <div className="user-select-card card">
                  <div className="card-body p-2">
                    <div className="mb-2">
                      <input
                        type="text"
                        className="form-control"
                        placeholder="搜索用户..."
                        value={userSearch}
                        onChange={(e) => setUserSearch(e.target.value)}
                      />
                    </div>
                    <div>
                      {filteredUsers.map((u) => {
                        const badge = ROLE_BADGE[u.role] ?? ROLE_BADGE.user;
                        return (
                          <div
                            key={u.id}
                            className={`user-item p-2 rounded mb-1 ${
                              selectedUserId === u.id ? 'is-selected' : ''
                            }`}
                            onClick={() => {
                              setSelectedUserId(u.id);
                              setSelectedUsername(u.username);
                            }}
                          >
                            <div className="d-flex justify-content-between align-items-center">
                              <div>
                                <strong>{u.username}</strong>
                                <br />
                                <small className="text-muted">{u.email}</small>
                              </div>
                              <div>
                                <span className={`badge ${badge.cls}`}>{badge.label}</span>
                              </div>
                            </div>
                          </div>
                        );
                      })}
                      {filteredUsers.length === 0 && (
                        <p className="text-muted text-center" style={{ margin: 0 }}>
                          没有匹配的用户
                        </p>
                      )}
                    </div>
                  </div>
                </div>
              </div>

              <div className="col-md-8">
                <h5>编写通知</h5>
                <form onSubmit={submitToUser}>
                  <div className="form-group">
                    <label className="form-label">接收用户</label>
                    <input
                      type="text"
                      className="form-control"
                      readOnly
                      placeholder="请先选择用户"
                      value={selectedUsername}
                    />
                  </div>

                  <div className="form-group">
                    <label className="form-label">通知类型</label>
                    <select
                      className="form-control"
                      value={userAction}
                      onChange={(e) => setUserAction(e.target.value)}
                    >
                      <option value="系统公告">系统公告</option>
                      <option value="维护通知">维护通知</option>
                      <option value="功能更新">功能更新</option>
                      <option value="用户提醒">用户提醒</option>
                      <option value="警告通知">警告通知</option>
                      <option value="活动通知">活动通知</option>
                    </select>
                  </div>

                  <div className="form-group">
                    <label className="form-label">通知内容</label>
                    <textarea
                      className="form-control"
                      rows={5}
                      placeholder="请输入通知内容..."
                      value={userDetail}
                      onChange={(e) => setUserDetail(e.target.value)}
                    />
                  </div>

                  <div className="form-row">
                    <div className="col-md-6">
                      <label className="form-label">关联对象类型（可选）</label>
                      <select
                        className="form-control"
                        value={userObjectType}
                        onChange={(e) => setUserObjectType(e.target.value)}
                      >
                        {OBJECT_TYPES.map((o) => (
                          <option key={o.value} value={o.value}>
                            {o.label}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="col-md-6">
                      <label className="form-label">关联对象ID（可选）</label>
                      <input
                        type="text"
                        className="form-control"
                        placeholder="如：博客ID、用户ID等"
                        value={userObjectId}
                        onChange={(e) => setUserObjectId(e.target.value)}
                      />
                    </div>
                  </div>

                  <div className="d-flex align-items-center gap-2 mt-4">
                    <button type="submit" className="btn btn-primary btn-lg">
                      发送通知
                    </button>
                    <button
                      type="button"
                      className="btn btn-secondary btn-lg"
                      onClick={clearUserForm}
                    >
                      清空
                    </button>
                  </div>
                </form>
              </div>
            </div>
          )}

          {/* 群发通知 */}
          {sendMode === 'all' && (
            <form onSubmit={submitBroadcast}>
              <div className="row">
                <div className="col-md-6">
                  <div className="form-group">
                    <label className="form-label" htmlFor="bc-group">
                      目标用户组
                    </label>
                    <select
                      id="bc-group"
                      className="form-select"
                      value={targetGroup}
                      onChange={(e) => setTargetGroup(e.target.value)}
                      disabled={busy}
                    >
                      {GROUPS.map((g) => (
                        <option key={g.value} value={g.value}>
                          {g.label}
                        </option>
                      ))}
                    </select>
                    <small className="form-text text-muted">选择要接收通知的用户群体</small>
                  </div>

                  <div className="form-group">
                    <label className="form-label" htmlFor="bc-action">
                      通知类型
                    </label>
                    <input
                      id="bc-action"
                      type="text"
                      className="form-control"
                      value={action}
                      onChange={(e) => setAction(e.target.value)}
                      disabled={busy}
                    />
                  </div>
                </div>

                <div className="col-md-6">
                  <div className="form-row">
                    <div className="col-md-6">
                      <label className="form-label">关联对象类型（可选）</label>
                      <select
                        className="form-control"
                        value={objectType}
                        onChange={(e) => setObjectType(e.target.value)}
                        disabled={busy}
                      >
                        {OBJECT_TYPES.map((o) => (
                          <option key={o.value} value={o.value}>
                            {o.label}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="col-md-6">
                      <label className="form-label">关联对象ID（可选）</label>
                      <input
                        type="text"
                        className="form-control"
                        placeholder="如：博客ID等"
                        value={objectId}
                        onChange={(e) => setObjectId(e.target.value)}
                        disabled={busy}
                      />
                    </div>
                  </div>

                  {/* 目标用户数量实时预览 */}
                  <div className="mt-3 p-3 bg-light rounded">
                    <h6>预览信息</h6>
                    <p className="mb-1">
                      目标用户数量:{' '}
                      <span className="font-weight-bold text-primary">{targetUserCount}</span>
                    </p>
                    <small className="text-muted">请确认发送范围后再提交</small>
                  </div>
                </div>
              </div>

              <div className="form-group">
                <label className="form-label" htmlFor="bc-detail">
                  通知内容
                </label>
                <textarea
                  id="bc-detail"
                  className="form-control"
                  value={detail}
                  onChange={(e) => setDetail(e.target.value)}
                  disabled={busy}
                  rows={5}
                  placeholder="请输入群发通知内容..."
                />
                <small className="form-text text-muted">
                  群发通知会发送给所有符合条件的用户，请谨慎编写内容。
                </small>
              </div>

              <div className="d-flex align-items-center gap-2 mt-4">
                <button
                  type="submit"
                  className="btn btn-success btn-lg"
                  disabled={busy || !detail.trim()}
                >
                  {busy ? '发送中…' : '群发通知'}
                </button>
                {msg && (
                  <span
                    className={msg.ok ? 'text-muted' : 'text-danger'}
                    style={{ fontSize: '0.85rem' }}
                  >
                    {msg.text}
                  </span>
                )}
              </div>
            </form>
          )}
        </div>
      </div>
    </>
  );
}
