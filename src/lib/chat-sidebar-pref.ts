// ─────────────────────────────────────────────────────────────────────────────
// chat-sidebar-pref.ts — 聊天侧栏折叠偏好的存储键（零依赖，server/client 共用）
//
// 折叠偏好存两处，职责不同（对齐 blog-sort-pref 的镜像模型）：
//  - localStorage（LS_KEY）：长命记忆 + 存量迁移源。key 保持 'chat.sidebarCollapsed'
//    不动 —— 迁移 effect 靠它读取存量值，取值 '1'=折叠 / '0'=展开。
//  - cookie（COOKIE_NAME）：SSR 可见镜像，让 /chat 首屏直接按偏好渲染折叠态，
//    消除「SSR 展开 → 水合后 280px↔60px 折叠」的布局跳变。只存 '1'（折叠），
//    展开态不存值（与「默认展开」的最小化一致）。非 httpOnly：客户端 effect
//    要读它判断迁移分支（对齐 blog_sort 的刻意选择）。
// ─────────────────────────────────────────────────────────────────────────────

export const LS_KEY = 'chat.sidebarCollapsed';
export const COOKIE_NAME = 'chat_sidebar_collapsed';
/** 一年。Safari ITP 可能压短，到期后由 LS 迁移 effect 自愈。 */
export const COOKIE_MAX_AGE = 60 * 60 * 24 * 365;
