import { SESSION_COOKIE } from '@/lib/session';
import { cookies } from 'next/headers';

// POST /api/auth/logout — 登出的**唯一**入口（base.js 的 window.logout / LogoutLink 组件）。
//
// 【为什么只有 POST，连 Flask 的 GET 都不保留】
// 清会话是状态变更，而 GET 会被**别人**发起：浏览器预取、爬虫、第三方页面上的
// <img src="…/logout">。本站刻意允许被 iframe 嵌入，这个面是真实可达的。
// 真出过事：403 页曾挂一个 <Link href="/logout">，Next 在生产环境会预取视口内的
// 链接 —— 于是「看一眼 403 页」就等于「被登出」，用户只看到自己莫名其妙掉了线。
// CSRF 中间件（src/middleware.ts）拦的也是写请求，GET 登出等于自己开在墙外。
export async function POST() {
  const store = await cookies();
  store.delete(SESSION_COOKIE);
  return Response.json({ code: 200, message: '已退出登录' });
}
