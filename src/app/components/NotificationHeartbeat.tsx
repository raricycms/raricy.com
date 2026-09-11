'use client';

import { useEffect, useRef } from 'react';
import { usePathname } from 'next/navigation';

declare global {
  interface Window {
    // base.js 暴露的徽标刷新入口（/static/js/core/base.js）
    updateNotificationCount?: () => void;
  }
}

// 顶栏两个提示（铃铛数字 +「聊天」红点）「心跳」的换页即时刷新半边：
// root layout 在 Next 客户端路由切换（soft navigation）时不重挂载，base.js 又由
// <Script strategy="afterInteractive"> 加载、只在整页加载时执行一次 —— 两者都感知
// 不到路由变化。这里用 usePathname 监听切页，路由提交后立刻通知 base.js 拉一次
// 最新未读数；20s 周期轮询的兜底半边在 base.js 的 startNotificationHeartbeat 里。
export default function NotificationHeartbeat() {
  const pathname = usePathname();
  const mounted = useRef(false);

  useEffect(() => {
    if (!mounted.current) {
      // 首次挂载 = 整页加载：base.js 的 initSiteChrome 已经刷过一次，不重复请求
      mounted.current = true;
      return;
    }
    // 客户端路由切换：新页面渲染完成，立即刷新顶栏未读数
    window.updateNotificationCount?.();
  }, [pathname]);

  // bfcache 前进/后退恢复页面：期间文档被冻结、脚本与定时器都不跑，恢复瞬间
  // 补刷一次，避免恢复后还要等下一轮心跳才看到新数字。
  useEffect(() => {
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted) window.updateNotificationCount?.();
    };
    window.addEventListener('pageshow', onPageShow);
    return () => window.removeEventListener('pageshow', onPageShow);
  }, []);

  return null;
}
