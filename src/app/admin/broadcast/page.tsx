'use client';

// 通知发送中心 — 管理端设计系统
//
// 两种发送方式（发送给指定用户 / 群发通知）共用一张 `.admin-panel` 工作台：
//   · 顶部是 `.admin-seg` 的互斥切换（按钮 + aria-pressed）；
//   · 指定用户：左选人、右编写（桌面两栏，窄屏单列），用户列表是可滚动的胶囊行；
//   · 群发：字段 + 目标人数预览 + 内容。
//
// 【不许动的部分】接口、状态、校验与文案语义全部沿用改版前：/api/admin/users 拉列表、
// /api/admin/notify-user 单人通知、/api/admin/broadcast 群发；群发忽略接收者的通知偏好
// 设置的说明照旧。这里只重排 DOM 与类名。
// ⚠️ 群发是站长专属（/admin/broadcast/layout.tsx 的服务端守卫），本页不做权限判断。

import { useEffect, useMemo, useState } from 'react';
import { Check, Megaphone, Search } from 'lucide-react';
import AdminPageHeader from '@/app/components/AdminPageHeader';

const GROUPS: Array<{ value: string; label: string }> = [
  { value: 'all', label: '所有用户' },
  { value: 'authenticated', label: '认证用户' },
  { value: 'normal', label: '普通用户' },
];

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

// 角色徽标：只借用共享 .admin-chip 的三种档位（brand / success / 默认弱化档）。
// ⚠️ 别用旧页面的 badge-success / badge-danger：那套类名在 CSS 里根本不存在
// （只剩 Bootstrap fallback 的零散规则），「认证用户」会渲染成没有样式的裸文字。
const ROLE_BADGE: Record<string, { cls: string; label: string }> = {
  owner: { cls: 'admin-chip--brand', label: '站长' },
  admin: { cls: 'admin-chip--brand', label: '管理员' },
  core: { cls: 'admin-chip--success', label: '认证用户' },
  user: { cls: '', label: '普通用户' },
};

/**
 * 用户选择器要一次看到全站用户 —— 服务端每页最多 100 条（MAX_PER_PAGE），
 * 只取第一页会让「目标用户数量」偏小、搜索也搜不到第 100 名之后的人，
 * 而群发是不可逆的。所以这里按页拉全量，并给一个硬上限防止异常分页把页面拖死。
 */
const USER_PAGE_SIZE = 100;
const MAX_USER_PAGES = 100;

export default function AdminBroadcastPage() {
  const [sendMode, setSendMode] = useState<'user' | 'all'>('user');

  const [action, setAction] = useState('系统通知');
  const [detail, setDetail] = useState('');
  const [targetGroup, setTargetGroup] = useState('all');
  const [objectType, setObjectType] = useState('');
  const [objectId, setObjectId] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);

  const [users, setUsers] = useState<UserLite[]>([]);
  const [totalUsers, setTotalUsers] = useState<number | null>(null);
  const [usersLoading, setUsersLoading] = useState(true);
  const [usersTruncated, setUsersTruncated] = useState(false);
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

  useEffect(() => {
    let cancelled = false;

    // 逐页拉取；每拿到一页就并入列表，长列表加载过程中也能开始选人。
    (async () => {
      const loaded: UserLite[] = [];
      let total: number | null = null;
      try {
        for (let page = 1; ; page += 1) {
          const res = await fetch(
            `/api/admin/users?perPage=${USER_PAGE_SIZE}&page=${page}`,
            { credentials: 'same-origin' }
          );
          const data = await res.json();
          if (cancelled) return;
          if (data.code !== 200 || !Array.isArray(data.users)) {
            setUsersLoading(false);
            return;
          }
          for (const u of data.users as Array<{
            id: string;
            username: string;
            email: string;
            role: string;
          }>) {
            loaded.push({ id: u.id, username: u.username, email: u.email, role: u.role });
          }
          if (typeof data.pagination?.total === 'number') total = data.pagination.total;
          setUsers([...loaded]);

          const hasNext = Boolean(data.pagination?.has_next);
          if (!hasNext) {
            setTotalUsers(total);
            setUsersTruncated(false);
            setUsersLoading(false);
            return;
          }
          if (page >= MAX_USER_PAGES) {
            // 到上限还有下一页：如实标注「列表已截断」，别把已加载数当成全站人数。
            setTotalUsers(total);
            setUsersTruncated(true);
            setUsersLoading(false);
            return;
          }
        }
      } catch {
        if (!cancelled) setUsersLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const targetUserCount = useMemo(() => {
    // 「所有用户」优先用服务端总数（不受分页上限影响）；其余分组只能按已加载列表算，
    // 截断时页面会额外标出这一点。
    if (targetGroup === 'all' && totalUsers != null) return totalUsers;
    return users.filter((u) => {
      const isCore = ['core', 'admin', 'owner'].includes(u.role);
      if (targetGroup === 'all') return true;
      if (targetGroup === 'authenticated') return isCore;
      if (targetGroup === 'normal') return u.role === 'user';
      return false;
    }).length;
  }, [users, totalUsers, targetGroup]);

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
      <AdminPageHeader
        eyebrow={
          <>
            <Megaphone aria-hidden="true" />
            运营
          </>
        }
        title="通知发送中心"
        subtitle="向指定用户或用户组发送通知，群发忽略接收者的通知偏好设置。"
      />

      <div className="admin-container">
        <section className="admin-panel">
          {/* 发送方式：2 选 1 的互斥视图，切页档胶囊 */}
          <div className="admin-broadcast-mode">
            <div className="admin-seg" role="group" aria-label="发送方式">
              <button
                type="button"
                className={`admin-seg__btn${sendMode === 'user' ? ' is-active' : ''}`}
                aria-pressed={sendMode === 'user'}
                onClick={() => setSendMode('user')}
              >
                发送给指定用户
              </button>
              <button
                type="button"
                className={`admin-seg__btn${sendMode === 'all' ? ' is-active' : ''}`}
                aria-pressed={sendMode === 'all'}
                onClick={() => setSendMode('all')}
              >
                群发通知
              </button>
            </div>
          </div>

          {sendMode === 'user' ? (
            <div className="admin-broadcast-grid">
              {/* 左：选择用户 */}
              <div className="admin-broadcast-picker">
                <div className="admin-broadcast-picker__head">
                  <h2 className="admin-broadcast-picker__title">选择用户</h2>
                  <span className="admin-section-count numeric">{filteredUsers.length}</span>
                </div>

                <label className="admin-search">
                  <span className="admin-search__icon" aria-hidden="true">
                    <Search />
                  </span>
                  <input
                    type="search"
                    className="admin-search__input"
                    placeholder="搜索用户…"
                    aria-label="搜索用户"
                    value={userSearch}
                    onChange={(e) => setUserSearch(e.target.value)}
                  />
                </label>

                {usersLoading && users.length === 0 ? (
                  <p className="admin-user-list__empty">加载中…</p>
                ) : filteredUsers.length === 0 ? (
                  <p className="admin-user-list__empty">没有匹配的用户</p>
                ) : (
                  <div className="admin-user-list" id="userList">
                    {filteredUsers.map((u) => {
                      const badge = ROLE_BADGE[u.role] ?? ROLE_BADGE.user;
                      const selected = selectedUserId === u.id;
                      return (
                        <button
                          key={u.id}
                          type="button"
                          className={`admin-user-pick${selected ? ' is-selected' : ''}`}
                          data-user-id={u.id}
                          data-username={u.username}
                          aria-pressed={selected}
                          onClick={() => {
                            setSelectedUserId(u.id);
                            setSelectedUsername(u.username);
                          }}
                        >
                          <span className="admin-user-pick__main">
                            <span className="admin-user-pick__name">{u.username}</span>
                            <span className="admin-user-pick__email">{u.email}</span>
                          </span>
                          <span className={`admin-chip ${badge.cls}`.trim()}>{badge.label}</span>
                          {selected && (
                            <span className="admin-user-pick__check" aria-hidden="true">
                              <Check />
                            </span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                )}

                {usersTruncated && (
                  <p className="admin-user-list__note">
                    用户过多，仅加载前 <span className="numeric">{users.length}</span> 名；
                    搜索只覆盖已加载的用户。
                  </p>
                )}
              </div>

              {/* 右：编写通知 */}
              <form className="admin-broadcast-form" id="notificationForm" onSubmit={submitToUser}>
                <div className="admin-field">
                  <label className="admin-field__label" htmlFor="selectedUser">
                    接收用户
                  </label>
                  <input
                    type="text"
                    className="form-control admin-field__control"
                    id="selectedUser"
                    readOnly
                    placeholder="请先选择用户"
                    value={selectedUsername}
                  />
                </div>

                <div className="admin-field">
                  <label className="admin-field__label" htmlFor="notificationAction">
                    通知类型
                  </label>
                  <select
                    className="form-select admin-field__control"
                    id="notificationAction"
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

                <div className="admin-field">
                  <label className="admin-field__label" htmlFor="notificationDetail">
                    通知内容
                  </label>
                  <textarea
                    className="form-control admin-field__control"
                    id="notificationDetail"
                    rows={5}
                    placeholder="请输入通知内容..."
                    value={userDetail}
                    onChange={(e) => setUserDetail(e.target.value)}
                  />
                  <small className="admin-broadcast-hint">请详细描述通知内容，确保用户能够理解。</small>
                </div>

                <div className="admin-broadcast-fields">
                  <div className="admin-field">
                    <label className="admin-field__label" htmlFor="objectType">
                      关联对象类型（可选）
                    </label>
                    <select
                      className="form-select admin-field__control"
                      id="objectType"
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
                  <div className="admin-field">
                    <label className="admin-field__label" htmlFor="objectId">
                      关联对象ID（可选）
                    </label>
                    <input
                      type="text"
                      className="form-control admin-field__control"
                      id="objectId"
                      placeholder="如：博客ID、用户ID等"
                      value={userObjectId}
                      onChange={(e) => setUserObjectId(e.target.value)}
                    />
                  </div>
                </div>

                <div className="admin-broadcast-actions">
                  <button type="submit" className="btn btn-primary" disabled={busy}>
                    发送通知
                  </button>
                  <button type="button" className="btn btn-secondary" onClick={clearUserForm}>
                    清空
                  </button>
                </div>
              </form>
            </div>
          ) : (
            /* 群发通知 */
            <form className="admin-broadcast-form admin-broadcast-form--wide" id="broadcastForm" onSubmit={submitBroadcast}>
              <div className="admin-broadcast-fields">
                <div className="admin-field">
                  <label className="admin-field__label" htmlFor="targetGroup">
                    目标用户群
                  </label>
                  <select
                    className="form-select admin-field__control"
                    id="targetGroup"
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
                  <small className="admin-broadcast-hint">选择要接收通知的用户群体</small>
                </div>

                <div className="admin-field">
                  <label className="admin-field__label" htmlFor="broadcastAction">
                    通知类型
                  </label>
                  <input
                    id="broadcastAction"
                    type="text"
                    className="form-control admin-field__control"
                    value={action}
                    onChange={(e) => setAction(e.target.value)}
                    disabled={busy}
                  />
                </div>
              </div>

              <div className="admin-broadcast-fields">
                <div className="admin-field">
                  <label className="admin-field__label" htmlFor="broadcastObjectType">
                    关联对象类型（可选）
                  </label>
                  <select
                    className="form-select admin-field__control"
                    id="broadcastObjectType"
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
                <div className="admin-field">
                  <label className="admin-field__label" htmlFor="broadcastObjectId">
                    关联对象ID（可选）
                  </label>
                  <input
                    type="text"
                    className="form-control admin-field__control"
                    id="broadcastObjectId"
                    placeholder="如：博客ID等"
                    value={objectId}
                    onChange={(e) => setObjectId(e.target.value)}
                    disabled={busy}
                  />
                </div>
              </div>

              {/* 预览：目标是「先看清有多少人再按发送」 */}
              <div className="admin-broadcast-preview">
                <div className="admin-broadcast-preview__label">目标用户数量</div>
                <div className="admin-broadcast-preview__count numeric">{targetUserCount}</div>
                <p className="admin-broadcast-preview__caveat">
                  群发将忽略接收者的通知偏好设置，请确认发送范围后再提交。
                </p>
                {usersTruncated && (
                  <p className="admin-broadcast-preview__warn">
                    「所有用户」按服务端总数计；其余分组按已加载的{' '}
                    <span className="numeric">{users.length}</span> 名用户估算（列表已截断）。
                  </p>
                )}
              </div>

              <div className="admin-field">
                <label className="admin-field__label" htmlFor="broadcastDetail">
                  通知内容
                </label>
                <textarea
                  className="form-control admin-field__control"
                  id="broadcastDetail"
                  value={detail}
                  onChange={(e) => setDetail(e.target.value)}
                  disabled={busy}
                  rows={5}
                  placeholder="请输入群发通知内容..."
                />
                <small className="admin-broadcast-hint">
                  群发通知会发送给所有符合条件的用户，请谨慎编写内容。
                </small>
              </div>

              <div className="admin-broadcast-actions">
                <button type="submit" className="btn btn-primary" disabled={busy || !detail.trim()}>
                  {busy ? '发送中…' : '群发通知'}
                </button>
                {msg && (
                  <span
                    className={`admin-broadcast-result ${msg.ok ? 'is-ok' : 'is-error'}`}
                    role="status"
                  >
                    {msg.text}
                  </span>
                )}
              </div>
            </form>
          )}
        </section>
      </div>
    </>
  );
}
