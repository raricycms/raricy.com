import Link from 'next/link';
import type { SafeUser } from '@/lib/auth';
import { hasAdminRights } from '@/lib/auth';

// 顶栏：严格对齐原 base.html 的 .site-navbar 结构与类名（交互由 base.js 接管）。
export default function Navbar({ user }: { user: SafeUser | null }) {
  return (
    <header className="site-navbar" role="navigation">
      <div className="nav-inner">
        <Link className="site-brand" href="/">
          <img src="/static/img/favicon.png" alt="聪明山" />
          <span>聪明山</span>
        </Link>

        <button
          className="site-navbar-toggler"
          type="button"
          aria-expanded="false"
          aria-label="切换菜单"
        >
          <span className="bar"></span>
          <span className="bar"></span>
          <span className="bar"></span>
        </button>

        <div className="nav-collapse">
          <nav className="nav-links">
            <Link className="nav-link" href="/game">
              玩具
            </Link>
            <Link className="nav-link" href="/blog">
              博客
            </Link>
            <Link className="nav-link" href="/tool">
              工具
            </Link>
            <Link className="nav-link" href="/audit">
              日志
            </Link>
          </nav>

          <div className="nav-actions">
            <button className="icon-btn" id="themeToggle" type="button" aria-label="切换明暗主题">
              <span className="icon icon-theme-toggle"></span>
            </button>

            {user ? (
              <>
                <Link className="icon-btn notification-btn" href="/notifications" title="我的通知">
                  <span className="icon icon-bell-fill"></span>
                  <span className="notification-badge" id="notificationBadge">
                    0
                  </span>
                </Link>
                <Link className="icon-btn checkin-indicator" href="/checkin" title="每日签到">
                  <span className="icon icon-calendar-check"></span>
                  <span className="checkin-badge" id="checkinBadge"></span>
                </Link>
                <div className="site-user-dropdown">
                  <button
                    className="site-user-dropdown-toggle"
                    id="userDropdownToggle"
                    type="button"
                    aria-haspopup="true"
                    aria-expanded="false"
                  >
                    <span>{user.username}</span>
                    <span className="site-user-avatar">
                      <img src={`/api/avatar/${user.id}`} alt="头像" />
                    </span>
                  </button>
                  <ul className="site-user-dropdown-menu" role="menu" id="userDropdownMenu">
                    <li className="site-dropdown-header">{user.username}</li>
                    <li className="site-dropdown-divider"></li>
                    <li>
                      <Link className="site-dropdown-item" href={`/u/${user.id}`}>
                        <span className="icon icon-person"></span>个人资料
                      </Link>
                    </li>
                    <li>
                      <Link className="site-dropdown-item" href="/settings">
                        <span className="icon icon-gear"></span>账号设置
                      </Link>
                    </li>
                    <li>
                      <Link className="site-dropdown-item" href="/fish">
                        <span>🐟</span>小鱼干
                      </Link>
                    </li>
                    {hasAdminRights(user) && (
                      <li>
                        <Link className="site-dropdown-item" href="/admin">
                          <span className="icon icon-gear-fill"></span>管理面板
                        </Link>
                      </li>
                    )}
                    <li className="site-dropdown-divider"></li>
                    <li>
                      {/* 无 JS 依赖：GET /logout 清除会话并重定向 */}
                      <a className="site-dropdown-item site-text-danger" href="/logout">
                        <span className="icon icon-box-arrow-right"></span>退出登录
                      </a>
                    </li>
                  </ul>
                </div>
              </>
            ) : (
              <>
                <Link className="nav-login" href="/login">
                  <span className="icon icon-person-circle"></span>登录
                </Link>
                <Link className="nav-register" href="/register">
                  注册
                </Link>
              </>
            )}
          </div>
        </div>
      </div>
    </header>
  );
}
