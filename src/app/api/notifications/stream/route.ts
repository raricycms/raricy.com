// ─────────────────────────────────────────────────────────────────────────────
// GET /api/notifications/stream — 顶栏指示器实时流（SSE）
//
// 一次连接覆盖该用户的两个顶栏指示器：铃铛未读数（站内通知）与「讨论」红点。
// 载荷是**增量补丁** `{ count?, chatUnread?, refresh? }`（见 topbar-bus.ts）——
// 谁的数字谁推，客户端 merge。发消息仍走各自的 POST 路由，本路由只读不写。
//
// 【响应头】全部取自 @/lib/sse 的 SSE_HEADERS —— no-transform 为什么不可省见那边的
// 文件头（漏了会被 next start 的压缩中间件攒到流结束才发，实时性归零）。
//
// 【为什么不发 id: / 不做断线补齐】讨论流需要它（消息是不可变的事件流，漏一条要补）。
// 顶栏不是：patch 里带的是**绝对值**，重连后首帧就是全量快照，天然自愈。少一套
// Last-Event-ID + backfill 的语义，也就少一处能出错的地方。
//
// 【未登录返回 401，而不是像 count 路由那样返回 {count:0}】EventSource 对非 200 响应
// 按规范 fail the connection 且不再重试 —— 这正是我们要的：会话失效（改密 / 强退 /
// 禁言递增 sessionVersion）后连接必须停掉，而不是空转重连。count 路由是普通 fetch，
// 两者契约不同是有意的。
// ─────────────────────────────────────────────────────────────────────────────

import { getCurrentUser } from '@/lib/auth';
import { getUnreadCount } from '@/lib/notification-service';
import { getChatDotFor } from '@/lib/chat-service';
import { subscribe, type TopbarSubscriber } from '@/lib/topbar-bus';
import { SSE_HEADERS, SSE_QUEUE_LIMIT, SSE_RETRY_MS, sseFrame } from '@/lib/sse';

// 必须是 nodejs：订阅注册表挂在 globalThis 上，进 Edge 运行时就是另一个 VM，
// 写路径推的帧永远到不了这里 —— 而且**静默不推送**，单测完全看不见。
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const user = await getCurrentUser();
  if (!user) return new Response('Unauthorized', { status: 401 });

  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | null = null;
  let closed = false;

  const cleanup = () => {
    if (closed) return;
    closed = true;
    unsubscribe?.();
    unsubscribe = null;
  };

  const stream = new ReadableStream<Uint8Array>(
    {
      start(controller) {
        const write = (chunk: string): boolean => {
          if (closed) return false;
          try {
            controller.enqueue(encoder.encode(chunk));
          } catch {
            return false; // 已关闭 / 已取消
          }
          // desiredSize ≤ 0 = 队列积压到 highWaterMark → 交给调用方断开重连
          return (controller.desiredSize ?? 1) > 0;
        };

        const close = () => {
          cleanup();
          try {
            controller.close();
          } catch {
            /* 已关闭 */
          }
        };

        // 首帧：重连节奏 + 注释帧（让浏览器/中间层立刻见到字节，避免被当成空响应）
        if (!write(`retry: ${SSE_RETRY_MS}\n\n: connected\n\n`)) {
          // 首帧就写不进去 = 流已经废了，别再注册订阅（否则要等 abort 才回收）
          cleanup();
          try {
            controller.close();
          } catch {
            /* 已关闭 */
          }
          return;
        }

        // 首帧快照（当前真实值）不是同步读得到的，而**先订阅**才能保证这段窗口里产生的
        // 推送不丢。两者兼顾的办法：快照写出去之前，bus 推来的帧先攒着；写完快照再按
        // 原顺序补发（它们都比快照新，正好盖在快照上面）。缓冲只存活一次库读的时间。
        let snapshotSent = false;
        const pending: string[] = [];

        const writeForBus = (chunk: string): boolean => {
          if (!snapshotSent) {
            pending.push(chunk);
            return true;
          }
          return write(chunk);
        };

        const flushPending = () => {
          snapshotSent = true; // 先置位：补发过程中若又有推送，直接写出去即可
          while (pending.length) {
            if (!write(pending.shift()!)) {
              close(); // 背压：与 bus 的处理一致 —— 断开，让 EventSource 重连
              pending.length = 0;
              return;
            }
          }
        };

        const sub: TopbarSubscriber = { userId: user.id, write: writeForBus, close };
        unsubscribe = subscribe(sub);

        // 客户端主动断开（关闭标签页 / 网络断）时 Next 会 cancel 流；这里再挂一道
        // 保险，防止某些运行时下 cancel 不被触发导致订阅泄漏。
        req.signal.addEventListener('abort', close);

        void (async () => {
          try {
            const [count, chatUnread] = await Promise.all([
              getUnreadCount(user.id),
              getChatDotFor(user.id),
            ]);
            if (closed) return;
            if (!write(sseFrame({ count, chatUnread }))) {
              close();
              return;
            }
          } catch (e) {
            // 快照失败不该断流：客户端还有首屏的一次性 fetch 与兜底轮询。
            // 但**必须**继续放行缓冲，否则攒下的推送永远发不出去。
            console.error(`[notifications-stream] 首帧快照失败（userId=${user.id}）:`, e);
          }
          flushPending();
        })();
      },
      cancel() {
        cleanup();
      },
    },
    { highWaterMark: SSE_QUEUE_LIMIT }
  );

  return new Response(stream, { headers: SSE_HEADERS });
}
