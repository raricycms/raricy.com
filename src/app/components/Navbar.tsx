import Link from 'next/link';
import type { SafeUser } from '@/lib/auth';
import { hasAdminRights, isCoreUser } from '@/lib/auth';
import LogoutLink from './LogoutLink';
import NavLink from './NavLink';

// 顶栏 — 站点顶部导航（site-* BEM 类 + 图标 mask 着色）
// base.js 通过 id (#userDropdownToggle, #userDropdownMenu, #themeToggle, #notificationBadge,
// #checkinBadge, #chatUnreadDot) 与 .open class 操纵此顶栏，故这些 id / class 改不得。
export default function Navbar({ user }: { user: SafeUser | null }) {
  /**
   * 「博客」指向哪 —— **按档位分流**：core+ 去站内全量 `/blog`，其余去对外公开列表
   * `/explore`。
   *
   * ⚠️ 这**不是**「把入口藏起来」，别把它当成自相矛盾改回去。CLAUDE.md 与下面
   * 「讨论」那段的「入口不跟着藏」，说的是**不要因为档位不够就把入口藏掉**
   * （那种「入口有、门禁却不认」才是自相矛盾）。这里入口照旧对所有人渲染，只是
   * 通向两个都能打开的列表 —— 访客点进去不再是一张登录页。
   *
   * 相关钉子：tests/e2e/access-control.spec.ts 的「入口保留」组，以及
   * tests/e2e/explore.spec.ts 里对这两条去向的断言。
   */
  const blogHref = isCoreUser(user) ? '/blog' : '/explore';

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
          {/* 条目顺序对齐首页的三张卡（故事 → 博客 → 工具）。 */}
          <ul className="site-nav">
            <li>
              <NavLink className="site-link" href="/story">
                故事
              </NavLink>
            </li>
            <li>
              <NavLink className="site-link" href={blogHref}>
                博客
              </NavLink>
            </li>
            <li>
              <NavLink className="site-link" href="/tool">
                工具
              </NavLink>
            </li>
            <li>
              <NavLink className="site-link" href="/audit">
                日志
              </NavLink>
            </li>
            {/* 讨论：**入口对所有人保留**，哪怕点进去是 403（匿名 → 跳登录）。
                站长明确要过这一条，别再按「入口与门禁同档」把它藏起来 ——
                那条例外只适用于「入口有、门禁却不认」的自相矛盾（如 /admin/users
                的侧栏），不适用于「功能存在但你需要更高权限」这种正常阶梯。
                门禁本身在 /chat（core+）与 requireChatUser，不在这里。 */}
            <li>
              <NavLink className="site-link" href="/chat">
                讨论
                {/* 讨论未读红点（私聊有未读 / 大区被 @）：base.js 按
                    /api/notifications/count 的 chatUnread 字段开关。
                    不放铃铛上——铃铛数字必须等于通知列表的条目数。 */}
                <span className="site-link__dot" id="chatUnreadDot" style={{ display: 'none' }} />
              </NavLink>
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
                        <span className="icon icon-fish" style={{ marginRight: '.5rem' }} aria-hidden="true"></span>小鱼干
                      </Link>
                    </li>
                    {/* 「我的收藏夹」原先挂在这里 —— 它是「创建/改名/删除/导出/导入」的
                        唯一管理页，曾经只能靠手敲 URL 到达。现按站长的要求挪到
                        `/tool` 的「站务工具」区（与云剪贴板 / 投票箱并列），
                        那里才是「站内工具」的入口所在，下拉菜单只留账号类入口。
                        口径不变：**不对档位设条件**（core 以下点了是就地 403），
                        与顶栏「讨论」同一条口径 —— 入口不跟着藏。 */}
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