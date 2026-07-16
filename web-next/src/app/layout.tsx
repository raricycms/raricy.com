import type { Metadata } from 'next';
import Script from 'next/script';
import './rebuild.css';
import Navbar from './components/Navbar';
import Footer from './components/Footer';
import { getCurrentUser } from '@/lib/auth';

export const metadata: Metadata = {
  title: '聪明山',
  description: '我们总将找到答案',
  icons: { icon: [{ url: '/static/img/favicon.png', type: 'image/png' }] },
};

// 防闪烁：CSS 加载前按 localStorage/系统偏好设 data-theme（对齐原 base.html 内联脚本）
const noFlashScript = `(function(){try{var t=localStorage.getItem('theme');if(t!=='light'&&t!=='dark'){t=(window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)').matches)?'dark':'light';}document.documentElement.setAttribute('data-theme',t);var tc=document.querySelector('meta[name="theme-color"]');if(tc)tc.setAttribute('content',t==='dark'?'#131517':'#FBFBFD');}catch(e){}})();`;

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const user = await getCurrentUser();

  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <head>
        <meta name="theme-color" content="#FBFBFD" />
        {/* base.js 依赖这些 meta（对齐原 base.html 的服务端数据契约） */}
        <meta name="user-authenticated" content={user ? 'true' : 'false'} />
        {user && <meta name="notification-api-url" content="/api/notifications/count" />}
        {user && <meta name="checkin-api-url" content="/api/checkin" />}
        {user && <meta name="logout-url" content="/api/auth/logout" />}
        <script dangerouslySetInnerHTML={{ __html: noFlashScript }} />
        {/* 原站部分页面(照片墙/剪贴板/故事/图床/投票)在 rebuild.css 之外叠加的
            页面级样式表；已命名空间化，全局加载无冲突（含旧令牌→新令牌桥接）。*/}
        <link rel="stylesheet" href="/static/css/legacy.css" />
      </head>
      <body>
        <Navbar user={user} />
        <main>{children}</main>
        <Footer />
        {/* 原站的顶栏交互脚本：主题旋转切换 / 用户下拉 / 移动端折叠 / toast */}
        <Script src="/static/js/core/base.js" strategy="afterInteractive" />
      </body>
    </html>
  );
}
