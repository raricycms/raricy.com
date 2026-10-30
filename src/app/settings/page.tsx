'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import OAuthConnectionsList from './OAuthConnectionsList';
import FramePanel from './FramePanel';
import BubblePanel from './BubblePanel';
import FocusPanel from './FocusPanel';
import AddToHomeScreenGuide from '../components/AddToHomeScreenGuide';

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

  const focusAlertClass = focusAlert
    ? `settings-alert settings-alert--${focusAlert.type}`
    : 'settings-alert d-none';

  return (
    <div className="settings-page container">
      <h1 className="page-title">设置</h1>
      <nav className="settings-nav" aria-label="设置分组"><a href="/settings#profile">资料</a><a href="/settings#preferences">浏览偏好</a><a href="/settings#appearance">外观</a><a href="/settings#security">安全与应用</a><a href="/settings#developer">开发接入</a></nav>
      <section className="settings-section" id="profile" aria-labelledby="profile-heading"><h2 className="settings-section__title" id="profile-heading">个人资料</h2>
      {/* ====== Section 1: Bio ====== */}
      <div className="settings-card">
        <div className="settings-card__header">
          <span className="icon icon-person"></span>
          <h3 className="settings-card__title">个人简介</h3>
        </div>
        <div className={bioAlertClass} id="bioAlert">{bioAlert?.msg ?? ''}</div>
        <textarea
          id="editBio"
          className="settings-input settings-input--textarea"
          placeholder="写一段简介，介绍一下自己..."
          maxLength={500}
          value={state.bio}
          onChange={(e) => setState((s) => ({ ...s, bio: e.target.value }))}
        />
        <div className="settings-input__hint numeric" id="bioCharCount">{state.bio.length} / 500</div>
        <button
          className="settings-btn settings-btn--primary"
          id="btnSaveBio"
          onClick={saveBio}
          disabled={savingBio}
        >
          {savingBio ? '保存中…' : '保存'}
        </button>
      </div>

      {/* ====== Section 3: Privacy ====== */}
      <div className="settings-card">
        <div className="settings-card__header">
          <span className="icon icon-gear"></span>
          <h3 className="settings-card__title">主页隐私设置</h3>
        </div>
        <p className="settings-card__desc">主页内容由你在主页上自行布置；下面两项控制默认展示与资料接口</p>
        <div className={privacyAlertClass} id="privacyAlert">{privacyAlert?.msg ?? ''}</div>

        <div className="settings-toggle-row">
          <div className="settings-toggle-row__label">
            <span className="settings-toggle-row__title">默认展示最近文章</span>
            <span className="settings-toggle-row__desc">还没布置主页时，自动展示最近三篇对外可读的文章；关掉后默认为空。亲手加的文章块不受影响</span>
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
            <span className="settings-toggle-row__title">在资料接口中提供最近评论</span>
            <span className="settings-toggle-row__desc">评论不会出现在个人主页（保护匿名评论者）；关闭后，第三方应用读取资料时也拿不到最近评论</span>
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

      </section>
      <section className="settings-section" id="preferences" aria-labelledby="preferences-heading"><h2 className="settings-section__title" id="preferences-heading">浏览偏好</h2>
      {/* ====== Section 3.5: 专注模式（id 供 /blog 横幅深链跳转） ====== */}
      <div className="settings-card" id="focus-mode">
        <div className="settings-card__header">
          <span className="icon icon-controller"></span>
          <h3 className="settings-card__title">专注模式</h3>
        </div>
        <div className={focusAlertClass} id="focusAlert">{focusAlert?.msg ?? ''}</div>
        <FocusPanel
          onAlert={(kind, msg) => {
            setFocusAlert({ msg, type: kind });
            setTimeout(() => setFocusAlert(null), 3000);
          }}
        />
      </div>

      {/* ====== Section 6: 添加到主屏幕（独立窗口下整张卡片自隐） ====== */}
      <AddToHomeScreenGuide />
      </section>
      <section className="settings-section" id="appearance" aria-labelledby="appearance-heading"><h2 className="settings-section__title" id="appearance-heading">外观</h2>
      {/* ====== Section 3b: 头像框 ====== */}
      {/* id 给深链用（/u/[id] 的「换个头像框」按钮指过来），与 #focus-mode 同款 */}
      <div className="settings-card" id="avatar-frame">
        <div className="settings-card__header">
          <span className="icon icon-person"></span>
          <h3 className="settings-card__title">头像框</h3>
        </div>
        <p className="settings-card__desc"><a className="frame-panel__hint-link" href="/fish/shop?category=frame#shop">去商城选头像框</a></p>
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
      <div className="settings-card" id="chat-bubble">
        <div className="settings-card__header">
          <span className="icon icon-chat-dots_new"></span>
          <h3 className="settings-card__title">聊天气泡</h3>
        </div>
        <p className="settings-card__desc">选择会同时影响历史消息。<a className="frame-panel__hint-link" href="/fish/shop?category=bubble#shop">去商城选气泡</a></p>
        {state.id && <BubblePanel />}
      </div>

      </section>
      <section className="settings-section" id="security" aria-labelledby="security-heading"><h2 className="settings-section__title" id="security-heading">安全与应用</h2>
      {/* ====== Section 2: Password ====== */}
      <div className="settings-card">
        <div className="settings-card__header">
          <span className="icon icon-gear-fill"></span>
          <h3 className="settings-card__title">修改密码</h3>
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

      <div className="settings-card">
        <div className="settings-card__header">
          <span className="icon icon-github"></span>
          <h3 className="settings-card__title">已绑定的应用</h3>
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

      </section>
      <section className="settings-section" id="developer" aria-labelledby="developer-heading"><h2 className="settings-section__title" id="developer-heading">开发接入</h2>
      {/* ====== Section 5: 鱼干接口（机器人接入） ====== */}
      <div className="settings-card">
        <div className="settings-card__header">
          <span className="icon icon-fish"></span>
          <h3 className="settings-card__title">鱼干接口</h3>
        </div>
        <p className="settings-card__desc">
          给站外机器人 / 银行签发只读凭据：只能查余额与流水，不能转账，可单独吊销。
        </p>
        <Link href="/fish/api" className="settings-btn">
          管理鱼干接口凭据
        </Link>
      </div>

      </section>
    </div>
  );
}
