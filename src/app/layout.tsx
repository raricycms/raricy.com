import type { Metadata } from 'next';
import Script from 'next/script';
// Flask 项目的 SCSS 编译产物（src/styles-scss/ → src/styles-scss/compiled/flask.css）
// 重新编译：npm run build:css（一次性）/ dev:css（监听）
import '@/styles-scss/compiled/flask.css';
import Navbar from './components/Navbar';
import Footer from './components/Footer';
import { getCurrentUser } from '@/lib/auth';

export const metadata: Metadata = {
  title: '聪明山',
  description: '我们总将找到答案',
  icons: { icon: [{ url: '/static/img/favicon.png', type: 'image/png' }] },
};

// 防闪烁：CSS 加载前按 localStorage/系统偏好设 data-theme（对齐原 Flask base.html 内联脚本）
const noFlashScript = `(function(){try{var t=localStorage.getItem('theme');if(t!=='light'&&t!=='dark'){t=(window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)').matches)?'dark':'light';}document.documentElement.setAttribute('data-theme',t);}catch(e){}})();`;

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
        <main>{children}</main>
        <Footer />
        {/* Flask 顶栏交互脚本：主题旋转切换 / 用户下拉 / 移动端折叠 / toast */}
        <Script src="/static/js/core/base.js" strategy="afterInteractive" />
      </body>
    </html>
  );
}
