'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import OAuthConnectionsList from './OAuthConnectionsList';
import FramePanel from './FramePanel';

interface ProfileState {
  /** 自己的 id：装备面板要拿它把框预览叠在**本人头像**上。 */
  id: string;
  bio: string;
  notifyLike: boolean;
  notifyEdit: boolean;
  notifyDelete: boolean;
  notifyAdmin: boolean;
  showRecentBlogs: boolean;
  showRecentComments: boolean;
  focusMode: boolean;
}

const EMPTY: ProfileState = {
  id: '',
  bio: '',
  notifyLike: true,
  notifyEdit: true,
  notifyDelete: true,
  notifyAdmin: true,
  showRecentBlogs: true,
  showRecentComments: true,
  focusMode: false,
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
  const [frameAlert, setFrameAlert] = useState<Alert | null>(null);
  const [focusAlert, setFocusAlert] = useState<Alert | null>(null);
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
            id: data.profile.id ?? '',
            bio: data.profile.bio ?? '',
            notifyLike: !!data.profile.notifyLike,
            notifyEdit: !!data.profile.notifyEdit,
            notifyDelete: !!data.profile.notifyDelete,
            notifyAdmin: !!data.profile.notifyAdmin,
            showRecentBlogs: !!data.profile.showRecentBlogs,
            showRecentComments: !!data.profile.showRecentComments,
            focusMode: !!data.profile.focusMode,
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

  async function saveFocus(value: boolean) {
    setState((s) => ({ ...s, focusMode: value }));
    try {
      // 只发单字段：updateOwnProfile 按白名单逐字段打补丁，整包旧 state 反而可能
      // 携带过期值（PATCH 是幂等的，只传本次变更即可）。
      const res = await fetch('/api/users/me', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ focusMode: value }),
      });
      const result = await res.json();
      if (res.ok && result.code === 200) {
        setFocusAlert({ msg: '专注模式设置已保存', type: 'success' });
        // 保存后刷新 RSC 树：/blog、/chat 等服务端页面按 users.focus_mode 渲染，
        // 而软导航不会重跑 root layout。
        router.refresh();
      } else {
        setFocusAlert({ msg: result.message || '保存失败', type: 'danger' });
        setState((s) => ({ ...s, focusMode: !value }));
      }
    } catch {
      setFocusAlert({ msg: '网络错误，请稍后再试', type: 'danger' });
      setState((s) => ({ ...s, focusMode: !value }));
    } finally {
      setTimeout(() => setFocusAlert(null), 3000);
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

  const focusAlertClass = focusAlert
    ? `settings-alert settings-alert--${focusAlert.type}`
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

      {/* ====== Section 3.5: 专注模式（id 供 /blog 横幅深链跳转） ====== */}
      <div className="settings-card" id="focus-mode">
        <div className="settings-card__header">
          <span className="icon icon-controller"></span>
          <h2 className="settings-card__title">专注模式</h2>
        </div>
        <p className="settings-card__desc">
          屏蔽干扰源，专心阅读。开启后：博客列表与侧栏将隐藏站长标记为「专注隐藏」的栏目及其文章；
          讨论大区（讨论室）不可进入。随时可在此关闭。
        </p>
        <div className={focusAlertClass} id="focusAlert">{focusAlert?.msg ?? ''}</div>

        <div className="settings-toggle-row">
          <div className="settings-toggle-row__label">
            <span className="settings-toggle-row__title">专注模式</span>
            <span className="settings-toggle-row__desc">隐藏「专注隐藏」栏目，禁用讨论大区</span>
          </div>
          <label className="settings-toggle">
            <input
              type="checkbox"
              id="toggleFocus"
              checked={state.focusMode}
              onChange={(e) => saveFocus(e.target.checked)}
            />
            <span className="settings-toggle__slider"></span>
          </label>
        </div>
      </div>

      {/* ====== Section 3b: 头像框 ====== */}
      {/* id 给深链用（/u/[id] 的「换个头像框」按钮指过来），与 #focus-mode 同款 */}
      <div className="settings-card" id="avatar-frame">
        <div className="settings-card__header">
          <span className="icon icon-person"></span>
          <h2 className="settings-card__title">头像框</h2>
        </div>
        <p className="settings-card__desc">
          戴上站长发给你的头像框，它会显示在顶栏、评论区、讨论区与你的个人主页。
          限时的头像框到期后会自动消失，不需要手动摘。
        </p>
        {frameAlert && (
          <div className={`settings-alert settings-alert--${frameAlert.type}`}>
            {frameAlert.msg}
          </div>
        )}
        {/* 等 profile 到了再渲染 —— 面板要用 id 画预览，空 id 会画出一张不属于任何人的
            identicon（而它看起来「也像个头像」，没人会发现是错的） */}
        {state.id && (
          <FramePanel
            userId={state.id}
            onAlert={(kind, msg) => {
              setFrameAlert({ msg, type: kind });
              setTimeout(() => setFrameAlert(null), 3000);
            }}
          />
        )}
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

      {/* ====== Section 5: 鱼干接口（机器人接入） ====== */}
      <div className="settings-card">
        <div className="settings-card__header">
          <span className="icon icon-fish"></span>
          <h2 className="settings-card__title">鱼干接口</h2>
        </div>
        <p className="settings-card__desc">
          给站外机器人 / 银行签发只读凭据：只能查余额与流水，不能转账，可单独吊销。
        </p>
        <Link href="/fish/api" className="settings-btn">
          管理鱼干接口凭据
        </Link>
      </div>
    </div>
  );
}