import type { Metadata } from 'next';
import Script from 'next/script';
// Flask 项目的 SCSS 编译产物（src/styles-scss/ → src/styles-scss/compiled/flask.css）
// 重新编译：npm run build:css（一次性）/ dev:css（监听）
import '@/styles-scss/compiled/flask.css';
import Navbar from './components/Navbar';
import Footer from './components/Footer';
import FooterGate from './components/FooterGate';
import NotificationHeartbeat from './components/NotificationHeartbeat';
import FrameBuster from './components/FrameBuster';
import { getCurrentUser } from '@/lib/auth';

export const metadata: Metadata = {
  title: '聪明山',
  description: '我们总将找到答案',
  icons: { icon: [{ url: '/static/img/favicon.png', type: 'image/png' }] },
};

// 防闪烁：CSS 加载前按 localStorage/系统偏好设 data-theme（对齐原 Flask base.html 内联脚本）。
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
        {/* base.js 依赖这些 meta（对齐 Flask base.html 的服务端数据契约） */}
        <meta name="user-authenticated" content={user ? 'true' : 'false'} />
        {user && <meta name="notification-api-url" content="/api/notifications/count" />}
        {user && <meta name="checkin-api-url" content="/api/checkin" />}
        {user && <meta name="logout-url" content="/api/auth/logout" />}
        <script dangerouslySetInnerHTML={{ __html: noFlashScript }} />
      </head>
      <body>
        <Navbar user={user} />
        {/* 切页/bfcache 恢复时即时刷新顶栏未读数（20s 周期心跳在 base.js） */}
        <NotificationHeartbeat />
        <main>{children}</main>
        {/* /chat 是满屏工作台，不渲染页脚（见 FooterGate） */}
        <FooterGate>
          <Footer />
        </FooterGate>
        {/* 被跨站 iframe 嵌入时弹出居中提示框（同站嵌入 / 正常访问不渲染） */}
        <FrameBuster />
        {/* Flask 顶栏交互脚本：主题旋转切换 / 用户下拉 / 移动端折叠 / toast */}
        <Script src="/static/js/core/base.js" strategy="afterInteractive" />
      </body>
    </html>
  );
}
