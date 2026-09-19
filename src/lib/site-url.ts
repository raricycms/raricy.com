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

/** 兜底域名。只在配置全空时用 —— 见 siteBaseUrl 的注释。 */
const FALLBACK_SITE = 'https://raricy.com';

/**
 * 按解析链算出配置里的 origin，**不告警**。配置不全时返回 ''。
 *
 * 抽出来是为了让 `siteOrigin()`（要告警）与 `siteBaseUrl()`（不许告警地兜底）
 * 共用同一条链，而不是各写一遍回退顺序。
 */
function configuredOrigin(): string {
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
  return '';
}

/**
 * 站点 origin（形如 `https://raricy.com`，**不含**尾部斜杠与路径）。
 * 解析失败或未配置 → console.warn + 返回 ''（调用方自行决定退化行为：
 * avatar_url 退化为相对路径、画报直接 503）。
 */
export function siteOrigin(): string {
  const origin = configuredOrigin();
  if (origin) return origin;
  console.warn('[site-url] SITE_URL 与 ALLOWED_ORIGINS 均未配置，绝对 URL 将退化为相对路径');
  return '';
}

/**
 * 站点对外地址 —— **永远给得出绝对地址**。供 metadataBase / sitemap / robots / OG 图用。
 *
 * 【为什么不复用 siteOrigin()】那一个的契约是「配置不全就返回 ''」，因为画报**必须**
 * 在拼不出绝对 URL 时拒绝出图（一张扫不开的二维码比报错更糟）。这里是反过来的：
 * metadataBase 拿到空串会让 Next 拿 localhost 当基准，sitemap 更会吐出相对路径 ——
 * 所以兜底到正式域名是**对的**。两者的失败方向相反，别合并成一个函数。
 *
 * 【为什么是历史变量 NEXT_PUBLIC_SITE_URL】sitemap.ts 与 robots.ts 此前各自手抄了一份
 * `process.env.NEXT_PUBLIC_SITE_URL || 'https://raricy.com'`。把它并进这条链、且排在
 * SITE_URL 之后，是为了**不改变这两个文件既有的输出**；两者现在都改成 import 本函数。
 * **不要再新增任何 NEXT_PUBLIC_ 变量** —— 那正是第二个真相源的来源。
 *
 * 【为什么永不抛】它会被 layout.tsx 在模块作用域里 `new URL()`。任何一步解析失败都
 * 回退兜底域名，绝不把异常放到模块顶层（那是全站 500）。
 */
export function siteBaseUrl(): string {
  const configured = configuredOrigin();
  if (configured) return configured;
  const legacy = (process.env.NEXT_PUBLIC_SITE_URL || '').trim();
  if (legacy) {
    try {
      return new URL(legacy).origin;
    } catch {
      /* fallthrough */
    }
  }
  return FALLBACK_SITE;
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
