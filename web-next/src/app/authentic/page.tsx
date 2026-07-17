'use client';

import { useState } from 'react';
import Link from 'next/link';

// 邀请码认证页，对齐 app/templates/auth/authentic.html（「去认证」按钮的落地页）。
// 结构 / 文案 / 类名逐字对齐原模板；提交交互（禁用按钮 + 验证中… + toast + 成功跳回主页）用 React 等价实现。

function toast(msg: string, type: string) {
  if (typeof window === 'undefined') return;
  const w = window as unknown as { showToast?: (m: string, t: string) => void };
  if (w.showToast) w.showToast(msg, type);
}

export default function AuthenticPage() {
  const [code, setCode] = useState('');
  const [loading, setLoading] = useState(false);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!e.currentTarget.checkValidity()) {
      e.currentTarget.reportValidity();
      return;
    }
    setLoading(true);
    try {
      const res = await fetch('/api/auth/authentic', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ authentic_code: code }),
      });
      const result = await res.json().catch(() => ({}));
      if (res.ok && result.code === 200) {
        toast(result.message || '验证成功', 'success');
        // 升级成功后回主页（此时角色已升为核心用户）
        setTimeout(() => {
          window.location.href = '/';
        }, 1000);
      } else {
        toast(result.message || '邀请码无效', 'error');
        setLoading(false);
      }
    } catch {
      toast('网络错误，请稍后再试', 'error');
      setLoading(false);
    }
  }

  return (
    <div className="auth-wrap">
      <div className="card auth-card">
        <div className="auth-head">
          <h1>邀请码验证</h1>
          <p>输入邀请码即可升级为核心用户</p>
        </div>

        <form id="authentic-form" onSubmit={submit}>
          <div className="field">
            <label htmlFor="authentic_code">
              邀请码 <span className="req">*</span>
            </label>
            <input
              className="input"
              type="text"
              id="authentic_code"
              name="authentic_code"
              placeholder="请输入您的邀请码"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              required
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
              立即验证
            </span>
            <span id="loadingText" style={{ display: loading ? 'inline' : 'none' }}>
              验证中…
            </span>
          </button>
        </form>

        <p className="auth-alt">
          没有邀请码？<Link href="/contact">点击联系我们</Link>
        </p>
      </div>
    </div>
  );
}
