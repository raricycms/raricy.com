import type { Metadata } from 'next';
import Script from 'next/script';
// 全站样式：SCSS 入口，由 Next 自己编译（sassOptions 见 next.config.mjs）。
// 改 SCSS 直接生效，dev 下走 HMR，不需要任何手工编译步骤。
// ⚠️ 别把它改名成 main.module.scss —— `.module.` 后缀会让 Next 按 CSS Modules
//    处理、把全站类名哈希化，样式整体失效。
import '@/styles-scss/main.scss';
import Navbar from './components/Navbar';
import Footer from './components/Footer';
import FooterGate from './components/FooterGate';
import NotificationHeartbeat from './components/NotificationHeartbeat';
import FrameBuster from './components/FrameBuster';
import { getCurrentUser, isCoreUser } from '@/lib/auth';
import { frameUrlFor } from '@/lib/frame-service';
import { siteBaseUrl } from '@/lib/site-url';

export const metadata: Metadata = {
  title: '聪明山',
  description: '我们总将找到答案',
  icons: { icon: [{ url: '/static/img/favicon.png', type: 'image/png' }] },
  // 相对 OG 图 URL（`images: [{ url: '/api/og/blog/...' }]`）必须有基准才拼得出绝对地址，
  // 否则分享卡片抓不到图。
  // ⚠️ siteBaseUrl() **永不抛**（解析失败回退正式域名）—— 这一行在模块作用域执行，
  //    抛一次就是全站 500。改它之前先确认这个性质还在。
  metadataBase: new URL(siteBaseUrl()),
};

// 防闪烁：CSS 加载前按 localStorage/系统偏好设 data-theme（内联脚本，随 <head> 同步执行）。
// 顺带给 <html> 打上 .js：给「只有 JS 能接管的状态」一个判别位 —— 例如 /blog 侧栏在
// ≤992px 下要按折叠渲染（见 _menu.scss 末尾），但那只在 JS 会接管折叠时才成立；
// 禁用 JS 时目录必须保持展开可点，不能被折叠态误伤。脚本同步执行于 <head>，
// 早于首帧绘制，故不会自己造成闪烁。
const noFlashScript = `(function(){document.documentElement.classList.add('js');try{var t=localStorage.getItem('theme');if(t!=='light'&&t!=='dark'){t=(window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)').matches)?'dark':'light';}document.documentElement.setAttribute('data-theme',t);}catch(e){}})();`;

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const user = await getCurrentUser();

  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <head>
        {/* base.js 依赖这些 meta（服务端数据契约） */}
        <meta name="user-authenticated" content={user ? 'true' : 'false'} />
        {user && <meta name="notification-api-url" content="/api/notifications/count" />}
        {/* 顶栏实时流。与上面那条分工不同：这条推**增量补丁**（实时值），上面那条是
            **兜底快照**（首屏 / 切页 / 流没连上时）。两条都要留着 —— 见 base.js
            scheduleHeartbeat 的注释。
            只判 user 不判 core：铃铛人人都有，红点由服务端快照里的闸门给 false
            （对齐 count 路由；讨论入口也正是对所有登录用户保留的）。 */}
        {user && <meta name="notification-stream-url" content="/api/notifications/stream" />}
        {/* 签到是 core+ 档：非核心用户不给这个 meta，base.js 就不会去轮询、
            也不会点亮一个骗人的「可签到」徽标（它只看 checked_in 字段，
            403 响应里没有该字段 → 会被当成「没签到」而常亮）。
            入口本身仍留在顶栏，点进去是 403 —— 与讨论、博客同一种待遇。 */}
        {isCoreUser(user) && <meta name="checkin-api-url" content="/api/checkin" />}
        {user && <meta name="logout-url" content="/api/auth/logout" />}
        <script dangerouslySetInnerHTML={{ __html: noFlashScript }} />
      </head>
      <body>
        <Navbar user={user} frameUrl={frameUrlFor(user)} />
        {/* 切页/bfcache 恢复时即时刷新顶栏未读数（实时值走 SSE，两档兜底轮询在 base.js） */}
        <NotificationHeartbeat />
        <main>{children}</main>
        {/* /chat 是满屏工作台，不渲染页脚（见 FooterGate） */}
        <FooterGate>
          <Footer />
        </FooterGate>
        {/* 被跨站 iframe 嵌入时弹出居中提示框（同站嵌入 / 正常访问不渲染） */}
        <FrameBuster />
        {/* 顶栏交互脚本：主题旋转切换 / 用户下拉 / 移动端折叠 / toast */}
        <Script src="/static/js/core/base.js" strategy="afterInteractive" />
      </body>
    </html>
  );
}
