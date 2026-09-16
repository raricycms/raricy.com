// ─────────────────────────────────────────────────────────────────────────────
// sse.ts — SSE 传输契约的唯一出处（响应头 + 帧格式 + 重连/背压常量）
//
// 【为什么要有这个模块】next start 默认挂压缩中间件
// （node_modules/next/dist/server/lib/router-server.js:110，除非 next.config 里
// compress:false）。实测：裸 text/event-stream 会被 gzip 并**攒到流结束才发**
// （4 条事件在 +1241ms 一次性到达），实时性归零；带上 Cache-Control: no-transform
// 后 compression 跳过压缩，事件逐条实时到达（+311/+604/+904/+1205ms）。
//
// 这个坑**单测完全看不见、构建也不报错** —— 所以响应头必须是常量、由所有 SSE 路由
// 复用，而不是每个路由凭记忆手写一份。改本文件等于改全站所有 SSE 流的行为。
//
// 现有消费者：api/chat/stream/route.ts（讨论）、api/notifications/stream/route.ts（顶栏指示器）。
// 新增 SSE 路由请直接 import 这里的常量，不要手抄。
// ─────────────────────────────────────────────────────────────────────────────

/** SSE 响应头。`no-transform` 不可省 —— 理由见文件头。 */
export const SSE_HEADERS = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  // no-transform 必须保留：它让 next start 的压缩中间件跳过本响应（见文件头注释）
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive',
  // nginx 侧禁缓冲（无 nginx 时该头无副作用）
  'X-Accel-Buffering': 'no',
} as const;

/** 浏览器重连间隔（毫秒）；作为 `retry:` 首帧下发给 EventSource。 */
export const SSE_RETRY_MS = 3000;

/** 背压阈值：积压这么多帧还没被消费，说明客户端已经卡死 → 断开重连。 */
export const SSE_QUEUE_LIMIT = 512;

/**
 * 心跳间隔：防中间设备（反代 / NAT / 运营商）把空闲长连接掐掉。
 *
 * 两条流（讨论 `chat-bus.ts`、顶栏 `topbar-bus.ts`）共用这一个值 —— 各自持有一个
 * 定时器，但间隔必须一致：它是对「反代多久掐空闲连接」这一个事实的编码，不该有两份。
 * nginx 的 `proxy_read_timeout` 默认 60s，25s 留了一倍余量。
 */
export const SSE_HEARTBEAT_MS = 25_000;

/**
 * 组装一帧 SSE。id 只给需要断线补齐的事件用（浏览器靠它回传 Last-Event-ID）。
 *
 * 泛型于事件类型：调用方传自己的联合类型，帧格式完全一致 ——
 * 订阅注册表因生命周期不同而各自实现（见 chat-bus.ts 的文件头）。
 */
export function sseFrame<T>(event: T, id?: number): string {
  const idLine = id != null ? `id: ${id}\n` : '';
  return `${idLine}data: ${JSON.stringify(event)}\n\n`;
}
