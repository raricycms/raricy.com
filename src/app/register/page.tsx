'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import TurnstileWidget from '@/app/components/TurnstileWidget';

function showToast(msg: string, type: string) {
  const w = window as unknown as { showToast?: (m: string, t: string) => void };
  if (w.showToast) w.showToast(msg, type);
}

// 注册页 — Flask BEM
export default function RegisterPage() {
  const router = useRouter();
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  const [agreeTerms, setAgreeTerms] = useState(false);
  const [turnstileToken, setTurnstileToken] = useState('');
  const [loading, setLoading] = useState(false);

  const formRef = useRef<HTMLFormElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const confirmPasswordRef = useRef<HTMLInputElement>(null);
  const inviteCodeRef = useRef<HTMLInputElement>(null);

  function validatePassword() {
    if (!confirmPasswordRef.current) return;
    const pw = passwordRef.current?.value ?? '';
    const cpw = confirmPasswordRef.current.value;
    confirmPasswordRef.current.setCustomValidity(pw !== cpw ? '两次输入的密码不一致' : '');
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const form = formRef.current;
    if (form && !form.checkValidity()) {
      form.reportValidity();
      return;
    }
    setLoading(true);
    try {
      const res = await fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          username,
          email,
          password,
          invite_code: inviteCode || undefined,
          turnstileToken: turnstileToken || undefined,
        }),
      });
      const data = await res.json();
      if (data.code === 200) {
        showToast(data.message || '注册成功！正在跳转到登录页面...', 'success');
        setTimeout(() => {
          router.push('/login');
        }, 1800);
      } else {
        showToast(data.message || '注册失败，请检查输入信息', 'error');
        if (data.field === 'invite_code') inviteCodeRef.current?.focus();
      }
    } catch {
      showToast('网络错误', 'error');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="auth-page">
      <div className="container">
        <div className="register-container">
          <div className="register-header">
            <h2>
              <span className="icon icon-add" aria-hidden="true"></span> 用户注册
            </h2>
            <p className="text-muted">请填写以下信息完成注册</p>
          </div>

          <form id="registerForm" ref={formRef} onSubmit={submit}>
            <div className="form-group">
              <label htmlFor="inviteCode" className="form-label">
                邀请码{' '}
                <span className="text-muted">(可选)</span>
              </label>
              <input
                ref={inviteCodeRef}
                type="text"
                className="form-control"
                id="inviteCode"
                name="invite_code"
                placeholder="请输入邀请码（可选）"
                value={inviteCode}
                onChange={(e) => setInviteCode(e.target.value)}
              />
              <div className="form-text">
                邀请码也可以在之后填写。如果你需要邀请码，可以去
                <a href="/contact" target="_blank">这里</a>获取。
              </div>
              <div className="invalid-feedback">
                请输入有效的邀请码
              </div>
            </div>

            <div className="form-group">
              <label htmlFor="username" className="form-label">
                <span className="icon icon-person" aria-hidden="true"></span> 用户名{' '}
                <span className="text-danger">*</span>
              </label>
              <input
                type="text"
                className="form-control"
                id="username"
                name="username"
                placeholder="请输入用户名"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                required
                minLength={3}
                maxLength={20}
              />
              <div className="invalid-feedback">
                用户名长度应在3-20个字符之间
              </div>
            </div>

            <div className="form-group">
              <label htmlFor="email" className="form-label">
                <span className="icon icon-envelope" aria-hidden="true"></span> 邮箱{' '}
                <span className="text-danger">*</span>
              </label>
              <input
                type="email"
                className="form-control"
                id="email"
                name="email"
                placeholder="请输入邮箱地址"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
              <div className="invalid-feedback">
                请输入有效的邮箱地址
              </div>
            </div>

            <div className="form-group">
              <label htmlFor="password" className="form-label">
                密码{' '}
                <span className="text-danger">*</span>
              </label>
              <input
                ref={passwordRef}
                type="password"
                className="form-control"
                id="password"
                name="password"
                placeholder="请输入密码"
                value={password}
                onChange={(e) => {
                  setPassword(e.target.value);
                  validatePassword();
                }}
                required
                minLength={6}
              />
              <div className="invalid-feedback">
                密码长度至少6个字符
              </div>
            </div>

            <div className="form-group">
              <label htmlFor="confirmPassword" className="form-label">
                确认密码{' '}
                <span className="text-danger">*</span>
              </label>
              <input
                ref={confirmPasswordRef}
                type="password"
                className="form-control"
                id="confirmPassword"
                name="confirm_password"
                placeholder="请再次输入密码"
                value={confirmPassword}
                onChange={(e) => {
                  setConfirmPassword(e.target.value);
                  validatePassword();
                }}
                required
              />
              <div className="invalid-feedback">
                两次输入的密码不一致
              </div>
            </div>

            <TurnstileWidget onToken={setTurnstileToken} />

            <div className="form-group">
              <div className="form-check">
                <input
                  className="form-check-input"
                  type="checkbox"
                  id="agreeTerms"
                  checked={agreeTerms}
                  onChange={(e) => setAgreeTerms(e.target.checked)}
                  required
                />
                <label className="form-check-label" htmlFor="agreeTerms">
                  我已阅读并同意{' '}
                  <Link href="/terms" target="_blank">用户协议</Link> 和{' '}
                  <Link href="/privacy" target="_blank">隐私政策</Link>
                </label>
                <div className="invalid-feedback">
                  请同意用户协议和隐私政策
                </div>
              </div>
            </div>

            <button
              type="submit"
              className="button button-primary"
              style={{ width: '100%', marginTop: 20 }}
              id="submitBtn"
              disabled={loading}
            >
              {loading ? (
                <span>注册中…</span>
              ) : (
                <span>
                  <span className="icon icon-add" aria-hidden="true"></span> 立即注册
                </span>
              )}
            </button>
          </form>

          <div className="login-link">
            <p className="text-muted">
              已有账号？{' '}
              <Link href="/login" className="text-primary">立即登录</Link>
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}