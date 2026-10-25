// ─────────────────────────────────────────────────────────────────────────────
// http-cache.ts — 原始字节路由（图床 / 音频床）共用的**条件请求**词汇
//
// 【为什么需要它】两条 raw 路由把「字节」和「这个字节还在不在」混在同一个 URL 上：
// 上传定稿后内容不再变，但**软删会把它变成 404**。所以它们不能学静态素材发
// `immutable, max-age=31536000` —— 浏览器一年不回来问，一张被删掉的图/录音在
// 已经看过的访客屏幕上会一直活着（线上真发生过：图床删了图，访客的博客里却
// 还看得见，因为浏览器压根没回源）。
//
// 现行口径是 `public, no-cache` + **弱 ETag**：每次用之前回来问一句，
// 没变就 304（零字节），删了就 404。代价是每次浏览一张图多一次条件请求，
// 换来的是「删了就是删了」。
//
// 本文件只放**纯函数 / 常量**：不碰 fs、不造 Response —— 具体 header 组合与
// 状态码由各路由自己决定（音频那条还要与 Range 交互，见它的文件头）。
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 公开字节（图床 / 音频）的 `Cache-Control`。
 *
 * `public` 允许中间缓存（反代 / CDN）存；`no-cache` 要求**每次使用前验证**。
 * 别把它改成 `max-age=…`：那就又回到了「删图后访客还能看一段时间」——
 * 只是窗口短一点而已。也别加 `immutable`（见文件头）。
 */
export const PUBLIC_BYTES_CACHE_CONTROL = 'public, no-cache';

/**
 * 私有字节的 `Cache-Control`。
 *
 * 私有档的授权是**逐请求**判的（作者 / 管理员），一旦进共享缓存，
 * 缓存命中就会绕过鉴权直接下发给无权者。所以只能 `private, no-store`。
 */
export const PRIVATE_BYTES_CACHE_CONTROL = 'private, no-store';

/**
 * 由文件元信息构造**弱** ETag。
 *
 * 为什么用 `size + mtime` 而不是只用 id：id 确实按上传定稿，但运维习惯是
 * 「往 `instance/images|audio/` 里拷文件」—— 只看 id 的话，换过的文件会让
 * 浏览器永远拿 304，人却看着旧内容，且不报任何错。mtime 截到毫秒。
 *
 * 为什么是弱验证器（`W/`）：`size + mtime` 只保证「内容变了它就变」，
 * 不保证「没变就一定没改」（毫秒级碰撞理论上存在）。弱 ETag 只能用于
 * 缓存验证（`If-None-Match`），不能用于 `If-Range` 断点续传 —— 本站也从不发
 * `If-Range`，所以这条限制正好落在空处。
 */
export function weakFileEtag(stat: { size: number; mtimeMs: number }): string {
  return `W/"${stat.size}-${Math.floor(stat.mtimeMs)}"`;
}

/**
 * `If-None-Match` 是否命中（**弱比较**，RFC 9110 §13.1.2）。
 *
 * 支持 `*` 与逗号分隔的列表；比较时忽略 `W/` 前缀 —— 弱比较的规则就是
 * 「不管强/弱，只要 opaque-tag 相同就算命中」，所以我们发出的弱 ETag 与客户端
 * 回显的任何一个都能对上。
 *
 * ⚠️ 我们的 ETag 里没有逗号（只有数字与 `-`），所以按 `,` 切分不会切坏。
 * 换成含逗号的 ETag 之前先回来改这里。
 */
export function ifNoneMatchMatches(header: string | null, etag: string): boolean {
  if (!header) return false;
  const bare = stripWeak(etag);
  return header
    .split(',')
    .map((tag) => tag.trim())
    .some((tag) => tag === '*' || stripWeak(tag) === bare);
}

function stripWeak(tag: string): string {
  return tag.replace(/^W\//i, '');
}
