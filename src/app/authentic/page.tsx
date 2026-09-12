'use client';

import { useState } from 'react';
import Link from 'next/link';

// 邀请码认证页，对齐 app/templates/auth/authentic.html。
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
    <div className="auth-page">
      <div className="container">
        <div className="register-container">
          <div className="register-header">
            <h2>
              <span className="icon icon-add" aria-hidden="true"></span> 邀请码验证
            </h2>
          </div>

          <form id="authentic-form" onSubmit={submit}>
            <div className="form-group">
              <label htmlFor="authentic_code">
                邀请码{' '}
                <span className="text-danger">*</span>
              </label>
              <input
                type="text"
                className="form-control"
                id="authentic_code"
                name="authentic_code"
                placeholder="请输入您的邀请码"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                required
              />
              <div className="invalid-feedback">
                请输入有效的邀请码
              </div>
            </div>
            <p style={{ textAlign: 'center', marginBottom: '1rem' }}>
              没有邀请码？
              <Link href="/contact" className="text-primary">点击联系我们</Link>
            </p>
            <button
              type="submit"
              className="button button-primary"
              style={{ width: '100%' }}
              id="submitBtn"
              disabled={loading}
            >
              <span style={{ display: loading ? 'none' : 'inline' }} id="submitText">
                立即验证
              </span>
              <span
                style={{ display: loading ? 'inline' : 'none' }}
                id="loadingText"
              >
                验证中…
              </span>
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}