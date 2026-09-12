// ─────────────────────────────────────────────────────────────────────────────
// atamas-pref.ts — Atamas 页主题/语言偏好的 cookie 镜像键（零依赖，server/client 共用）
//
// Atamas 页自己的 .light-mode class 与文案语言由 React state 渲染，layout 的
// no-flash 内联脚本只救 documentElement[data-theme]，救不了这层 —— SSR 首帧永远
// 默认亮色 + 英文，暗色/中文用户水合后才翻（页面背景 + 文案双闪）。
// 与 blog/chat 同模型：cookie 作为 SSR 可见镜像，让 /game/atamas 首屏直出。
//  - COOKIE_THEME：镜像站点主题（值 light|dark）。公共脚本 base.js 在每次页面
//    加载解析出 data-theme 时同步（对齐其 localStorage 'theme' 语义），
//    Atamas 页内切换按钮也即时补写。
//  - COOKIE_LANG：镜像 atamas_lang（用户显式选择时由 setCurrentLang 单点写）。
//    非 httpOnly、SameSite=Lax，无追踪用途（对齐 blog_sort 的刻意选择）。
// ─────────────────────────────────────────────────────────────────────────────

export const THEME_COOKIE = 'theme';
export const LANG_COOKIE = 'atamas_lang';
/** 一年。Safari ITP 可能压短，页面加载时 base.js 每次都会重新镜像，可自愈。 */
export const COOKIE_MAX_AGE = 60 * 60 * 24 * 365;
