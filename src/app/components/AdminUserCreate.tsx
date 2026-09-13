'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';

// ─────────────────────────────────────────────────────────────────────────────
// AdminUserCreate — 站长建号表单（仅站长可见，由 /admin/users 页面按 isOwner 门控渲染）。
//
// 【为什么存在】生产机到 challenges.cloudflare.com 的出口不通，Turnstile 的服务端校验
// 不可用；站长选择继续开着验证码（等于关闭匿名注册以防批量注册），改为手动给自己认可的
// 人开号。人机验证只在 /api/auth/register 的路由层，所以这个入口天然不涉及它。
//
// 【成功面板为什么必须给定位入口】新号按 createdAt 升序排在用户列表的**最后一页**，
// router.refresh() 之后站长在当前页看不到任何变化，会以为建号失败了。
// ---------------------------------------------------------------------------

interface Created {
  username: string;
  role: string;
  email: string;
  emailSynthesized: boolean;
}

export default function AdminUserCreate() {
  const router = useRouter();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [email, setEmail] = useState('');
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<Created | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    // 与 service 一致的下限。真正的判定在 adminCreateUser（service 才是权限与规则的边界），
    // 这里只是省一次往返。
    if (password.length < 8) {
      setError('密码长度至少为 8 位');
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch('/api/admin/users', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: username.trim(),
          password,
          email: email.trim() || undefined,
          reason: reason.trim() || undefined,
        }),
      });
      const j = await res.json();
      if (j.code !== 200) throw new Error(j.message || `建号失败 (${res.status})`);

      setCreated({
        username: j.user.username,
        role: j.user.role,
        email: j.email,
        emailSynthesized: j.emailSynthesized,
      });
      // 清掉表单，尤其是密码 —— 别让它一直留在页面状态里
      setUsername('');
      setPassword('');
      setEmail('');
      setReason('');
      router.refresh(); // 让 server component 的列表重新渲染
    } catch (err) {
      setError(err instanceof Error ? err.message : '建号失败，请稍后重试');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="management-card" style={{ marginBottom: 20 }}>
      <div className="management-card__head">
        <h2 className="management-card__title">新建用户（站长）</h2>
      </div>
      <div className="management-card__body">
        <small style={{ color: 'var(--color-text-secondary)', display: 'block', marginBottom: 12 }}>
          不经过人机验证与邀请码，建出来直接是<b>核心用户</b>。
        </small>

        {error && <div className="settings-alert settings-alert--danger">{error}</div>}

        {created && (
          <div className="settings-alert settings-alert--success">
            <div>
              已创建 <strong>{created.username}</strong>（{created.role}）
            </div>
            <div style={{ marginTop: 6 }}>
              邮箱：{created.email}
              {created.emailSynthesized && '（自动合成，不可投递）'}
            </div>
            <div style={{ marginTop: 6 }}>
              请把初始密码转告对方（它不会出现在任何日志里）。
              <Link
                href={`/admin/users?search=${encodeURIComponent(created.username)}`}
                style={{ marginLeft: 6 }}
              >
                在列表中查看
              </Link>
            </div>
          </div>
        )}

        <form onSubmit={submit} className="settings-form">
          <div className="settings-field">
            <label htmlFor="admin-new-username">
              用户名 <span style={{ color: 'var(--color-warning-primary)' }}>*</span>
            </label>
            <input
              id="admin-new-username"
              className="settings-input"
              required
              minLength={3}
              maxLength={20}
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="3-20 位，字母 / 数字 / 下划线 / 连字符"
            />
          </div>

          <div className="settings-field">
            <label htmlFor="admin-new-password">
              初始密码 <span style={{ color: 'var(--color-warning-primary)' }}>*</span>
            </label>
            <input
              id="admin-new-password"
              className="settings-input"
              type="password"
              required
              minLength={8}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="至少 8 位"
            />
            <small style={{ color: 'var(--color-text-secondary)' }}>
              由你设定并转告对方。不会写进审计日志。
            </small>
          </div>

          <div className="settings-field">
            <label htmlFor="admin-new-email">邮箱</label>
            <input
              id="admin-new-email"
              className="settings-input"
              type="email"
              maxLength={100}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="留空则自动合成占位邮箱"
            />
            <small style={{ color: 'var(--color-text-secondary)' }}>
              留空会生成 <code>&lt;用户名&gt;@users.invalid</code>
              （不可投递，仅供占位）。这类账号以后收不到任何邮件。
            </small>
          </div>

          <div className="settings-field">
            <label htmlFor="admin-new-reason">原因</label>
            <input
              id="admin-new-reason"
              className="settings-input"
              maxLength={200}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="可选，写进审计日志"
            />
            <small style={{ color: 'var(--color-text-secondary)' }}>
              这条操作会记入审计日志（<Link href="/audit">/audit</Link> 是公开页）。
            </small>
          </div>

          <button
            type="submit"
            className="settings-btn settings-btn--primary"
            disabled={submitting}
          >
            {submitting ? '创建中…' : '创建账号'}
          </button>
        </form>
      </div>
    </div>
  );
}
