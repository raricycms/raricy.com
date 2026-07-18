'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import TurnstileWidget from '@/app/components/TurnstileWidget';

function showToast(msg: string, type: string) {
  const w = window as unknown as { showToast?: (m: string, t: string) => void };
  if (w.showToast) w.showToast(msg, type);
}

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

  // 对齐 Flask register.html：用 setCustomValidity 让「两次密码不一致」走浏览器原生校验气泡，
  // 在两个密码框 input 时实时更新。
  function validatePassword() {
    if (!confirmPasswordRef.current) return;
    const pw = passwordRef.current?.value ?? '';
    const cpw = confirmPasswordRef.current.value;
    confirmPasswordRef.current.setCustomValidity(pw !== cpw ? '两次输入的密码不一致' : '');
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    // 对齐 Flask：先跑原生表单校验（含 required 的用户协议勾选、密码一致性），不通过则弹原生气泡。
    const form = formRef.current;
    if (form && !form.checkValidity()) {
      form.reportValidity();
      return;
    }
    setLoading(true);
    try {
      // Turnstile：启用时把 widget 回调拿到的 token 一并提交（禁用时 token 为空、服务端放行）。
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
        // 对齐 Flask register.html：注册成功后提示并跳转到登录页（约 1.8s 后）
        showToast(data.message || '注册成功！正在跳转到登录页面...', 'success');
        setTimeout(() => {
          router.push('/login');
        }, 1800);
      } else {
        showToast(data.message || '注册失败，请检查输入信息', 'error');
        // 对齐 Flask：邀请码相关错误时聚焦邀请码输入框。
        if (data.field === 'invite_code') inviteCodeRef.current?.focus();
      }
    } catch {
      showToast('网络错误', 'error');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="auth-wrap">
      <div className="card auth-card">
        <div className="auth-head">
          <h1>用户注册</h1>
          <p>请填写以下信息完成注册</p>
        </div>

        <form id="registerForm" ref={formRef} onSubmit={submit}>
          <div className="field">
            <label htmlFor="inviteCode">
              邀请码 <span className="opt">(可选)</span>
            </label>
            <input
              ref={inviteCodeRef}
              className="input"
              type="text"
              id="inviteCode"
              name="invite_code"
              placeholder="请输入邀请码（可选）"
              value={inviteCode}
              onChange={(e) => setInviteCode(e.target.value)}
            />
            <div className="field-hint">
              邀请码也可以在之后填写。如果你需要邀请码，可以去
              <a href="/contact" target="_blank">
                这里
              </a>
              获取。
            </div>
          </div>
          <div className="field">
            <label htmlFor="username">
              用户名 <span className="req">*</span>
            </label>
            <input
              className="input"
              type="text"
              id="username"
              name="username"
              placeholder="请输入用户名"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
              minLength={3}
              maxLength={20}
            />
          </div>
          <div className="field">
            <label htmlFor="email">
              邮箱 <span className="req">*</span>
            </label>
            <input
              className="input"
              type="email"
              id="email"
              name="email"
              placeholder="请输入邮箱地址"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </div>
          <div className="field">
            <label htmlFor="password">
              密码 <span className="req">*</span>
            </label>
            <input
              ref={passwordRef}
              className="input"
              type="password"
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
          </div>
          <div className="field">
            <label htmlFor="confirmPassword">
              确认密码 <span className="req">*</span>
            </label>
            <input
              ref={confirmPasswordRef}
              className="input"
              type="password"
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
          </div>

          <TurnstileWidget onToken={setTurnstileToken} />

          <div className="field">
            <label className="check-row">
              <input
                type="checkbox"
                id="agreeTerms"
                checked={agreeTerms}
                onChange={(e) => setAgreeTerms(e.target.checked)}
                required
              />
              <span>
                我已阅读并同意{' '}
                <a href="/terms" target="_blank">
                  用户协议
                </a>{' '}
                和{' '}
                <a href="/privacy" target="_blank">
                  隐私政策
                </a>
              </span>
            </label>
          </div>

          <button
            type="submit"
            className="btn btn--primary btn--full"
            id="submitBtn"
            disabled={loading}
            style={{ marginTop: 8 }}
          >
            <span id="submitText" style={{ display: loading ? 'none' : 'inline' }}>
              立即注册
            </span>
            <span id="loadingText" style={{ display: loading ? 'inline' : 'none' }}>
              注册中…
            </span>
          </button>
        </form>

        <p className="auth-alt">
          已有账号？<Link href="/login">立即登录</Link>
        </p>
      </div>
    </div>
  );
}
