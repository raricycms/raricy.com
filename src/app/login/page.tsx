'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { safeNextPath } from '@/lib/safe-url';

function toast(msg: string, type: string) {
  if (typeof window === 'undefined') return;
  const w = window as unknown as { showToast?: (m: string, t: string) => void };
  if (w.showToast) w.showToast(msg, type);
}

// 登录页 — Flask `auth/login.html` 样式（auth-page > .container > register-container > register-header）
export default function LoginPage() {
  const router = useRouter();
  const [next, setNext] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setNext(new URLSearchParams(window.location.search).get('next') || '');
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ username, password }),
      });
      const data = await res.json();
      if (data.code === 200) {
        toast(data.message || '登录成功！正在跳转...', 'success');
        router.push(safeNextPath(next));
        router.refresh();
      } else {
        toast(data.message || '登录失败，请检查用户名和密码', 'error');
      }
    } catch {
      toast('网络错误，请稍后重试', 'error');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="auth-page">
      <div className="container">
        <div className="register-container">
          <div className="register-header">
            <h2><span className="icon icon-person" aria-hidden="true"></span> 用户登录</h2>
            <p className="text-muted">请填写以下信息完成登录</p>
          </div>

          <form id="loginForm" onSubmit={submit} noValidate>
            <input type="hidden" name="next" value={next} />
            <div className="form-group">
              <label htmlFor="username" className="form-label">用户名</label>
              <input
                type="text"
                className="form-control"
                id="username"
                name="username"
                placeholder="请输入用户名"
                autoComplete="username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                required
              />
              <div className="invalid-feedback">请输入用户名</div>
            </div>

            <div className="form-group">
              <label htmlFor="password" className="form-label">密码</label>
              <input
                type="password"
                className="form-control"
                id="password"
                name="password"
                placeholder="请输入密码"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                minLength={6}
              />
              <div className="invalid-feedback">密码长度至少6个字符</div>
            </div>

            <button
              type="submit"
              className="button button-primary"
              style={{ width: '100%', marginTop: 20 }}
              disabled={loading}
              id="submitBtn"
            >
              <span id="submitText">
                <span className="icon icon-box-arrow-right" aria-hidden="true"></span>{' '}
                {loading ? '登录中...' : '立即登录'}
              </span>
            </button>
          </form>

          <div className="login-link">
            <p className="text-muted">没有账号？ <Link href="/register" className="text-primary">立即注册</Link></p>
          </div>
        </div>
      </div>
    </div>
  );
}