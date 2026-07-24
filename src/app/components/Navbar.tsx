import Link from 'next/link';
import type { SafeUser } from '@/lib/auth';
import { hasAdminRights } from '@/lib/auth';
import LogoutLink from './LogoutLink';

// 顶栏 — Flask `base.html` 样式（site-* BEM + icon mask）
// base.js 通过 id (#userDropdownToggle, #userDropdownMenu, #themeToggle, #notificationBadge, #checkinBadge)
// 与 .open class 操纵此顶栏，故结构必须与 Flask 保持一致。
export default function Navbar({ user }: { user: SafeUser | null }) {
  return (
    <header className="site-navbar" role="navigation">
      <div className="site-container">
        <Link className="site-brand" href="/">
          <img src="/static/img/favicon.png" alt="My Icon" width={30} height={30} />
          <span>聪明山</span>
        </Link>

        <button
          className="site-navbar-toggler"
          type="button"
          aria-expanded="false"
          aria-controls="siteNavbar"
          aria-label="切换导航"
        >
          <span className="bar"></span>
          <span className="bar"></span>
          <span className="bar"></span>
        </button>

        <div className="site-navbar-collapse" id="siteNavbar">
          <ul className="site-nav">
            <li>
              <Link className="site-link" href="/game">
                玩具
              </Link>
            </li>
            <li>
              <Link className="site-link" href="/blog">
                博客
              </Link>
            </li>
            <li>
              <Link className="site-link" href="/tool">
                工具
              </Link>
            </li>
            <li>
              <Link className="site-link" href="/audit">
                日志
              </Link>
            </li>
          </ul>

          <div className="site-actions">
            <button className="theme-toggle-button" id="themeToggle" type="button" aria-label="切换明暗主题">
              <span className="icon icon-theme-toggle"></span>
            </button>

            {user ? (
              <>
                <Link className="notification-btn" href="/notifications" title="我的通知">
                  <span className="icon icon-bell-fill" aria-hidden="true"></span>
                  <span className="notification-badge" id="notificationBadge" style={{ display: 'none' }}>0</span>
                </Link>
                <Link className="checkin-indicator" href="/checkin" title="每日签到">
                  <span className="icon icon-calendar-check" aria-hidden="true"></span>
                  <span className="checkin-badge" id="checkinBadge" style={{ display: 'none' }}></span>
                </Link>
                <div className="site-user-dropdown">
                  <button
                    className="site-user-dropdown-toggle"
                    id="userDropdownToggle"
                    type="button"
                    aria-haspopup="true"
                    aria-expanded="false"
                    aria-controls="userDropdownMenu"
                  >
                    <span>{user.username}</span>
                    <span className="site-user-avatar">
                      <img src={`/api/avatar/${user.id}`} alt="avatar" />
                    </span>
                  </button>
                  <ul className="site-user-dropdown-menu" role="menu" id="userDropdownMenu" aria-labelledby="userDropdownToggle">
                    <li role="presentation" className="site-dropdown-header">用户信息</li>
                    <li role="separator" className="site-dropdown-divider"></li>
                    <li role="none">
                      <Link className="site-dropdown-item" role="menuitem" href={`/u/${user.id}`}>
                        <span className="icon icon-person" style={{ marginRight: '.5rem' }}></span>个人资料
                      </Link>
                    </li>
                    <li role="none">
                      <Link className="site-dropdown-item" role="menuitem" href="/settings">
                        <span className="icon icon-gear" style={{ marginRight: '.5rem' }}></span>账号设置
                      </Link>
                    </li>
                    <li role="none">
                      <Link className="site-dropdown-item" role="menuitem" href="/fish">
                        <span style={{ marginRight: '.5rem' }}>🐟</span>小鱼干
                      </Link>
                    </li>
                    {hasAdminRights(user) && (
                      <li role="none">
                        <Link className="site-dropdown-item" role="menuitem" href="/admin">
                          <span className="icon icon-gear-fill" style={{ marginRight: '.5rem' }}></span>管理面板
                        </Link>
                      </li>
                    )}
                    <li role="separator" className="site-dropdown-divider"></li>
                    <li role="none">
                      <LogoutLink />
                    </li>
                  </ul>
                </div>
              </>
            ) : (
              <>
                <Link className="site-login-btn" href="/login">
                  <span className="icon icon-person-circle" style={{ marginRight: 6, verticalAlign: 'middle' }}></span>登录
                </Link>
                <Link className="site-link" href="/register">注册</Link>
              </>
            )}
          </div>
        </div>
      </div>
    </header>
  );
}