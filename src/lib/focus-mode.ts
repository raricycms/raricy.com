// ─────────────────────────────────────────────────────────────────────────────
// focus-mode.ts — 专注模式共享字面量（零依赖，server/client 均可 import）
//
// 专注模式是账号级偏好（DB users.focus_mode），不需要 cookie 镜像 —— 消费页
// 服务端本就 getCurrentUser。这里只放跨端文案/路径常量，避免各处字符串漂移：
// 禁用入口的 hover title、服务端 403 message、设置页锚点 href。
// ─────────────────────────────────────────────────────────────────────────────

/** 专注模式下禁用入口的统一 hover 提示（原生 title）。 */
export const FOCUS_MODE_BLOCKED_TITLE = '已开启专注模式，无法使用该功能';

/** 设置页专注模式卡片的锚点（横幅「此处」/ 玩具锁屏「前往设置」/ 聊天空态同源）。 */
export const FOCUS_MODE_SETTINGS_HREF = '/settings#focus-mode';
