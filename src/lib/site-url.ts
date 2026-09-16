// ─────────────────────────────────────────────────────────────────────────────
// site-url.ts — 站点对外地址的**唯一**解析处
//
// 解析链：SITE_URL → ALLOWED_ORIGINS 第一项 → ''（相对路径）。
//
// 【为什么必须是服务端专用变量】SITE_URL 没有 NEXT_PUBLIC_ 前缀，不会内联进客户端
// 包。要用它的地方（OAuth userinfo 的绝对 avatar_url、画报里二维码的前缀）都在服务端，
// 把结果当 prop 往下传即可 —— 不要为了「前端也能读」去加 NEXT_PUBLIC_SITE_URL，
// 那会凭空多出第二个真相源（sitemap.ts / robots.ts 已经在读它了）。
//
// 历史：这段逻辑原先内联在 oauth.ts 的 siteOrigin() 里。画报也要拼绝对 URL，
// 于是搬到这里 —— 两条用途共用一份，别再各写一遍回退链。
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 站点 origin（形如 `https://raricy.com`，**不含**尾部斜杠与路径）。
 * 解析失败或未配置 → console.warn + 返回 ''（调用方自行决定退化行为：
 * avatar_url 退化为相对路径、画报直接 503）。
 */
export function siteOrigin(): string {
  const fromSite = (process.env.SITE_URL || '').trim().replace(/\/+$/, '');
  if (fromSite) {
    try {
      return new URL(fromSite).origin;
    } catch {
      console.warn('[site-url] SITE_URL 不是合法 URL：', process.env.SITE_URL);
    }
  }
  const allowed = (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)[0];
  if (allowed) {
    try {
      return new URL(allowed.startsWith('http') ? allowed : `https://${allowed}`).origin;
    } catch {
      /* fallthrough */
    }
  }
  console.warn('[site-url] SITE_URL 与 ALLOWED_ORIGINS 均未配置，绝对 URL 将退化为相对路径');
  return '';
}

/**
 * 拼绝对 URL：`absoluteUrl('/u/abc')` → `https://raricy.com/u/abc`。
 * 站点 origin 未知时返回**相对路径**（调用方若拿它去做二维码，必须先检查
 * siteOrigin() 是否为空 —— 相对路径的二维码是废码）。
 */
export function absoluteUrl(pathname: string): string {
  const origin = siteOrigin();
  const p = pathname.startsWith('/') ? pathname : `/${pathname}`;
  return origin ? `${origin}${p}` : p;
}
