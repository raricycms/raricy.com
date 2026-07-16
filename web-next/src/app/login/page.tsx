'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';

function toast(msg: string, type: string) {
  if (typeof window === 'undefined') return;
  const w = window as unknown as { showToast?: (m: string, t: string) => void };
  if (w.showToast) w.showToast(msg, type);
}

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
        router.push('/');
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
    <div className="auth-wrap">
      <div className="card auth-card">
        <div className="auth-head">
          <h1>用户登录</h1>
          <p>请填写以下信息完成登录</p>
        </div>

        <form id="loginForm" onSubmit={submit}>
          <input type="hidden" name="next" value={next} />
          <div className="field">
            <label htmlFor="username">用户名</label>
            <input
              className="input"
              type="text"
              id="username"
              name="username"
              placeholder="请输入用户名"
              autoComplete="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
            />
          </div>
          <div className="field">
            <label htmlFor="password">密码</label>
            <input
              className="input"
              type="password"
              id="password"
              name="password"
              placeholder="请输入密码"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={6}
            />
          </div>
          <button
            type="submit"
            className="btn btn--primary btn--full"
            id="submitBtn"
            disabled={loading}
            style={{ marginTop: 8 }}
          >
            <span id="submitText" style={{ display: loading ? 'none' : 'inline' }}>
              立即登录
            </span>
            <span id="loadingText" style={{ display: loading ? 'inline' : 'none' }}>
              登录中…
            </span>
          </button>
        </form>

        <p className="auth-alt">
          没有账号？<Link href="/register">立即注册</Link>
        </p>
      </div>
    </div>
  );
}
