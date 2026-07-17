// ─────────────────────────────────────────────────────────────────────────────
// safe-url.ts —— 登录回跳地址的安全校验（对齐 Flask app/web/auth/sign_in.py:12 is_safe_url）
//
// 单独成文件而不是放进 guard.ts：guard.ts 会连带拉进 getCurrentUser → cookies()，
// 那是服务端专用的；而登录页是 'use client'，import 它会把服务端代码打进客户端包。
// 这里只放纯函数，两侧都能安全引用。
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 校验登录后回跳地址是否安全。
 *
 * ★ 这是开放重定向的经典入口 ★ —— 攻击者构造 /login?next=https://evil.com，
 * 用户在**我们自己的**登录页输完密码后被弹去钓鱼站，浏览器地址栏一路都是可信域名。
 * 故只放行「站内绝对路径」，其余一律回首页。
 */
export function safeNextPath(next: string | null | undefined): string {
  if (!next) return '/';
  // 必须是站内绝对路径。挡掉 https://evil.com 与相对路径。
  if (!next.startsWith('/')) return '/';
  // 协议相对 URL：//evil.com 会被浏览器当成跨站跳转。
  if (next.startsWith('//')) return '/';
  // /\evil.com —— 部分浏览器把反斜杠按 / 解析，等价于协议相对 URL。
  if (next.includes('\\')) return '/';
  // 回跳到接口没有意义，用户只会看到一坨 JSON。
  if (next.startsWith('/api/')) return '/';
  return next;
}

/** 拼出带回跳的登录地址：/login?next=<当前路径>（对齐 Flask-Login 的 login_view 行为）。 */
export function loginUrlWithNext(currentPath: string): string {
  const safe = safeNextPath(currentPath);
  return safe === '/' ? '/login' : `/login?next=${encodeURIComponent(safe)}`;
}
