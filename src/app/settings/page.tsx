'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import OAuthConnectionsList from './OAuthConnectionsList';

interface ProfileState {
  bio: string;
  notifyLike: boolean;
  notifyEdit: boolean;
  notifyDelete: boolean;
  notifyAdmin: boolean;
  showRecentBlogs: boolean;
  showRecentComments: boolean;
}

const EMPTY: ProfileState = {
  bio: '',
  notifyLike: true,
  notifyEdit: true,
  notifyDelete: true,
  notifyAdmin: true,
  showRecentBlogs: true,
  showRecentComments: true,
};

interface Alert {
  msg: string;
  type: 'success' | 'danger';
}

export default function SettingsPage() {
  const router = useRouter();
  const [state, setState] = useState<ProfileState>(EMPTY);
  const [savingBio, setSavingBio] = useState(false);
  const [bioAlert, setBioAlert] = useState<Alert | null>(null);
  const [privacyAlert, setPrivacyAlert] = useState<Alert | null>(null);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [passwordSubmitting, setPasswordSubmitting] = useState(false);
  const [passwordAlert, setPasswordAlert] = useState<Alert | null>(null);
  const [oauthAlert, setOauthAlert] = useState<Alert | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch('/api/users/me', { credentials: 'same-origin' });
        const data = await res.json();
        if (!alive) return;
        if (data.code === 401) {
          router.push('/login');
          return;
        }
        if (data.code === 200 && data.profile) {
          setState({
            bio: data.profile.bio ?? '',
            notifyLike: !!data.profile.notifyLike,
            notifyEdit: !!data.profile.notifyEdit,
            notifyDelete: !!data.profile.notifyDelete,
            notifyAdmin: !!data.profile.notifyAdmin,
            showRecentBlogs: !!data.profile.showRecentBlogs,
            showRecentComments: !!data.profile.showRecentComments,
          });
        }
      } catch {
        // 加载失败时保持默认值
      }
    })();
    return () => {
      alive = false;
    };
  }, [router]);

  async function saveBio() {
    const bio = state.bio.trim();
    if (bio.length > 500) {
      setBioAlert({ msg: '简介不能超过 500 字', type: 'danger' });
      return;
    }
    setSavingBio(true);
    try {
      const res = await fetch('/api/users/me', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ ...state, bio }),
      });
      const result = await res.json();
      if (res.ok && result.code === 200) setBioAlert({ msg: '资料已保存', type: 'success' });
      else setBioAlert({ msg: result.message || '保存失败', type: 'danger' });
    } catch {
      setBioAlert({ msg: '网络错误，请稍后再试', type: 'danger' });
    } finally {
      setSavingBio(false);
      setTimeout(() => setBioAlert(null), 3000);
    }
  }

  async function savePrivacy(key: 'showRecentBlogs' | 'showRecentComments', value: boolean) {
    const next = { ...state, [key]: value };
    setState(next);
    try {
      const res = await fetch('/api/users/me', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(next),
      });
      const result = await res.json();
      if (res.ok && result.code === 200) {
        setPrivacyAlert({ msg: '隐私设置已保存', type: 'success' });
      } else {
        setPrivacyAlert({ msg: result.message || '保存失败', type: 'danger' });
        setState((s) => ({ ...s, [key]: !value }));
      }
    } catch {
      setPrivacyAlert({ msg: '网络错误，请稍后再试', type: 'danger' });
      setState((s) => ({ ...s, [key]: !value }));
    } finally {
      setTimeout(() => setPrivacyAlert(null), 3000);
    }
  }

  async function submitPassword(e: React.FormEvent) {
    e.preventDefault();
    const currentPw = currentPassword.trim();
    const newPw = newPassword.trim();
    const confirmPw = confirmPassword.trim();
    if (newPw !== confirmPw) {
      setPasswordAlert({ msg: '两次输入的新密码不一致。', type: 'danger' });
      return;
    }
    setPasswordSubmitting(true);
    setPasswordAlert(null);
    let shouldReset = false;
    try {
      const res = await fetch('/api/auth/change-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          current_password: currentPw,
          new_password: newPw,
          confirm_password: confirmPw,
        }),
      });
      const result = await res.json().catch(() => ({}));
      const message = result.message || (res.ok ? '密码修改成功。' : '请求失败，请稍后再试。');
      if (res.ok && result.code === 200) {
        setPasswordAlert({ msg: message, type: 'success' });
        shouldReset = true;
        setTimeout(() => {
          router.push(result.redirect_url || '/login');
        }, 1500);
      } else {
        setPasswordAlert({ msg: message, type: 'danger' });
      }
    } catch {
      setPasswordAlert({ msg: '网络错误，请稍后再试。', type: 'danger' });
    } finally {
      setPasswordSubmitting(false);
      if (shouldReset) {
        setCurrentPassword('');
        setNewPassword('');
        setConfirmPassword('');
      }
    }
  }

  const bioAlertClass = bioAlert
    ? `settings-alert settings-alert--${bioAlert.type}`
    : 'settings-alert d-none';

  const passwordAlertClass = passwordAlert
    ? `settings-alert settings-alert--${passwordAlert.type}`
    : 'settings-alert d-none';

  const privacyAlertClass = privacyAlert
    ? `settings-alert settings-alert--${privacyAlert.type}`
    : 'settings-alert d-none';

  return (
    <div className="settings-page container">
      {/* ====== Section 1: Bio ====== */}
      <div className="settings-card">
        <div className="settings-card__header">
          <span className="icon icon-person"></span>
          <h2 className="settings-card__title">个人资料</h2>
        </div>
        <p className="settings-card__desc">编辑你的个人简介，展示在个人主页中</p>
        <div className={bioAlertClass} id="bioAlert">{bioAlert?.msg ?? ''}</div>
        <textarea
          id="editBio"
          className="settings-input settings-input--textarea"
          placeholder="写一段简介，介绍一下自己..."
          maxLength={500}
          value={state.bio}
          onChange={(e) => setState((s) => ({ ...s, bio: e.target.value }))}
        />
        <div className="settings-input__hint" id="bioCharCount">{state.bio.length} / 500</div>
        <button
          className="settings-btn settings-btn--primary"
          id="btnSaveBio"
          onClick={saveBio}
          disabled={savingBio}
        >
          {savingBio ? '保存中…' : '保存'}
        </button>
      </div>

      {/* ====== Section 2: Password ====== */}
      <div className="settings-card">
        <div className="settings-card__header">
          <span className="icon icon-gear-fill"></span>
          <h2 className="settings-card__title">修改密码</h2>
        </div>
        <p className="settings-card__desc">修改后需要重新登录</p>
        <div className={passwordAlertClass} id="passwordAlert">{passwordAlert?.msg ?? ''}</div>
        <form id="passwordForm" onSubmit={submitPassword}>
          <div className="settings-form-row">
            <div className="settings-field">
              <label htmlFor="currentPassword">原密码</label>
              <input
                type="password"
                id="currentPassword"
                className="settings-input"
                required
                autoComplete="current-password"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
              />
            </div>
          </div>
          <div className="settings-form-row">
            <div className="settings-field">
              <label htmlFor="newPassword">新密码</label>
              <input
                type="password"
                id="newPassword"
                className="settings-input"
                required
                minLength={8}
                autoComplete="new-password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
              />
            </div>
            <div className="settings-field">
              <label htmlFor="confirmPassword">确认新密码</label>
              <input
                type="password"
                id="confirmPassword"
                className="settings-input"
                required
                minLength={8}
                autoComplete="new-password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
              />
            </div>
          </div>
          <button
            type="submit"
            className="settings-btn settings-btn--primary"
            id="passwordSubmit"
            disabled={passwordSubmitting}
          >
            {passwordSubmitting ? '提交中…' : '确认修改'}
          </button>
        </form>
      </div>

      {/* ====== Section 3: Privacy ====== */}
      <div className="settings-card">
        <div className="settings-card__header">
          <span className="icon icon-gear"></span>
          <h2 className="settings-card__title">主页隐私设置</h2>
        </div>
        <p className="settings-card__desc">控制你的最近文章和评论是否在个人主页中公开展示</p>
        <div className={privacyAlertClass} id="privacyAlert">{privacyAlert?.msg ?? ''}</div>

        <div className="settings-toggle-row">
          <div className="settings-toggle-row__label">
            <span className="settings-toggle-row__title">展示最近文章</span>
            <span className="settings-toggle-row__desc">他人访问你的主页时可以看到最近发布的文章</span>
          </div>
          <label className="settings-toggle">
            <input
              type="checkbox"
              id="toggleBlogs"
              checked={state.showRecentBlogs}
              onChange={(e) => savePrivacy('showRecentBlogs', e.target.checked)}
            />
            <span className="settings-toggle__slider"></span>
          </label>
        </div>

        <div className="settings-toggle-row">
          <div className="settings-toggle-row__label">
            <span className="settings-toggle-row__title">展示最近评论</span>
            <span className="settings-toggle-row__desc">他人访问你的主页时可以看到最近发表的评论</span>
          </div>
          <label className="settings-toggle">
            <input
              type="checkbox"
              id="toggleComments"
              checked={state.showRecentComments}
              onChange={(e) => savePrivacy('showRecentComments', e.target.checked)}
            />
            <span className="settings-toggle__slider"></span>
          </label>
        </div>
      </div>

      {/* ====== Section 4: OAuth applications ====== */}
      <div className="settings-card">
        <div className="settings-card__header">
          <span className="icon icon-github"></span>
          <h2 className="settings-card__title">已绑定的应用</h2>
        </div>
        <p className="settings-card__desc">查看通过 OAuth 2.0 绑定到你账号的第三方应用，可在此解除绑定。解除后该应用的访问令牌立即失效。</p>
        {oauthAlert && (
          <div className={`settings-alert settings-alert--${oauthAlert.type}`}>
            {oauthAlert.msg}
          </div>
        )}
        <OAuthConnectionsList
          onAlert={(kind, msg) => {
            setOauthAlert({ msg, type: kind });
            setTimeout(() => setOauthAlert(null), 3000);
          }}
        />
      </div>
    </div>
  );
}