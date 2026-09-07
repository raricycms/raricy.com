// ─────────────────────────────────────────────────────────────────────────────
// blog-sort-pref.ts — 博客列表排序偏好的存储键（零依赖，server/client 共用）
//
// 排序偏好存两处，职责不同：
//  - localStorage（LS_KEY）：长命记忆 + 旧访客迁移源。key 必须保持 'blog.sort'
//    不动 —— 迁移 effect 靠它读取存量值（对齐 chat.sidebarCollapsed 点号命名）。
//  - cookie（COOKIE_NAME）：SSR 可见的镜像，让 /blog 首屏直接按偏好直出排序，
//    消除「先按发布时间、水合后再翻成更新时间」的跳变。站点 cookie 惯例是
//    下划线（raricy_session）。非 httpOnly：客户端 effect 要读它判断迁移分支。
//
// 本模块只导字面量，可被服务端页面与客户端组件同时 import，不会把任何
// server-only 依赖拖进客户端包。
// ─────────────────────────────────────────────────────────────────────────────

export const LS_KEY = 'blog.sort';
export const COOKIE_NAME = 'blog_sort';
/** 一年。Safari ITP 对脚本写入的 cookie 可能压短到 ~7 天，到期后 LS 迁移自愈。 */
export const COOKIE_MAX_AGE = 60 * 60 * 24 * 365;
