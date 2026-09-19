// ─────────────────────────────────────────────────────────────────────────────
// request-ip.ts — 取真实客户端 IP（反代 / Cloudflare 之后）
//
// 【为什么抽成一个文件】登录限频与鱼干市场的「无状态单次发包」限频都要它。
// 两处各写一份的必然结果是 drift（一边优先 cf-connecting-ip、另一边优先
// X-Forwarded-For），同一台机器就会在两条路径上落进两个桶 —— 撞库成本直接砍半。
//
// 【优先级】先 cf-connecting-ip（本站走 Cloudflare，由 CF 覆写，客户端伪造不了），
// 再 X-Forwarded-For 的第一个（nginx 透传，可由客户端伪造，属兜底）。
// 两者都没有（直连 / 本地开发）返回 undefined —— 调用方据此**跳过 IP 维度**，
// 不要拿 'unknown' 之类占位串当 IP：那会把所有直连用户并进同一个桶，
// 一个人刷满就把别人全挡在门外。
//
// 【形参是 { headers: Headers }，不是 Request】见下面函数的 JSDoc —— 为的是让
// route handler 与**页面 / 服务端组件**能共用同一份实现。别在页面侧另抄一份。
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 取客户端 IP。取不到（含头存在但值为空）返回 undefined —— **不是**占位串。
 *
 * 形参刻意写成 `{ headers: Headers }` 而不是 `Request`：`Request` 结构上就满足它，
 * 所以 route handler 的调用点一行都不用改；而**页面 / 服务端组件**里拿不到 Request
 * 对象（那边只有 `await headers()`），于是也能喂进来 ——
 *
 *   route：clientIp(req)
 *   页面 ：clientIp({ headers: await headers() })
 *
 * 这是刻意的：页面侧若因为「参数类型不匹配」另写一份，就正好落进文件头警告的那个
 * drift（一边优先 cf-connecting-ip、另一边优先 X-Forwarded-For —— 同一台机器在
 * 两条路径上落进两个桶，撞库成本直接砍半）。
 */
export function clientIp(req: { headers: Headers }): string | undefined {
  // ⚠️ 两级都必须把**空串**当成「取不到」，所以判的是 truthy 而不是 `??`。
  // `??` 只认 null/undefined，而 `''.split(',')[0].trim()` 是 `''` —— 一个用 `??`
  // 串起来的实现会让所有「头存在但值为空」的请求落进同一个 '' 桶，那正是文件头警告的
  // 「一个人刷满就把别人全挡在门外」。（原来就是这么写的，2026-09 被用例逮到。）
  const cf = req.headers.get('cf-connecting-ip')?.trim();
  if (cf) return cf;
  const xff = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  return xff || undefined;
}
