// ─────────────────────────────────────────────────────────────────────────────
// GET /api/chat/stream — 聊天实时流（SSE）
//
// 一次连接覆盖该用户的全部可见频道：大区广播 + 私聊点对点（见 chat-bus.ts）。
// 发消息仍走 POST /api/chat/channels/:id/messages —— 单向推送足够，且限频/校验
// 那一整套逻辑一行不用改。
//
// 【响应头】全部取自 @/lib/sse 的 SSE_HEADERS —— 那边的文件头记着 no-transform
// 为什么不可省（next start 的压缩中间件会把事件攒到流结束才发，实测 +1241ms
// 一次性到达，实时性归零）。**本路由不要手写响应头。**
//
// 【断线补齐】浏览器 EventSource 重连时会带 Last-Event-ID（即最后一帧的 id:），
// 服务端据此把漏掉的消息补发；积压超过窗口则发 resync 让客户端整页重拉。
// 鉴权在**每次建立连接**时重做（requireChatUser），所以封禁/降权/专注模式变更后
// 只要把旧连接踢掉（chat-bus.kickUser），新连接就会重新判定。
// ─────────────────────────────────────────────────────────────────────────────

import { requireChatUser } from '../_auth';
import { subscribe, type ChatSubscriber } from '@/lib/chat-bus';
import { SSE_HEADERS, SSE_QUEUE_LIMIT, SSE_RETRY_MS, sseFrame } from '@/lib/sse';
import { listMessagesSince } from '@/lib/chat-service';
import type { ChatStreamEvent } from '@/lib/chat-shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** 单次断线补齐上限：超过就让客户端整页重拉，避免一次灌爆内存。 */
const BACKFILL_LIMIT = 100;

export async function GET(req: Request) {
  const user = await requireChatUser();
  if (user instanceof Response) return user;

  const encoder = new TextEncoder();
  const rawLastEventId = Number(req.headers.get('last-event-id'));
  const lastEventId = Number.isInteger(rawLastEventId) && rawLastEventId > 0 ? rawLastEventId : 0;

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
          // desiredSize ≤ 0 = 队列积压到 highWaterMark → 交给 bus 断开重连
          return (controller.desiredSize ?? 1) > 0;
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

        const sub: ChatSubscriber = {
          userId: user.id,
          focusMode: user.focusMode ?? false,
          write,
          close: () => {
            cleanup();
            try {
              controller.close();
            } catch {
              /* 已关闭 */
            }
          },
        };
        unsubscribe = subscribe(sub);

        // 客户端主动断开（关闭标签页 / 网络断）时 Next 会 cancel 流；这里再挂一道
        // 保险，防止某些运行时下 cancel 不被触发导致订阅泄漏。
        req.signal.addEventListener('abort', () => {
          cleanup();
          try {
            controller.close();
          } catch {
            /* 已关闭 */
          }
        });

        // 断线补齐（不阻塞首帧：上面已经 write 过，浏览器可以先进入 open 状态）
        if (lastEventId > 0) {
          void backfill(user.id, lastEventId, write);
        }
      },
      cancel() {
        cleanup();
      },
    },
    { highWaterMark: SSE_QUEUE_LIMIT }
  );

  return new Response(stream, { headers: SSE_HEADERS });
}

/** 补齐断线期间漏掉的消息；积压超窗口则发 resync 让客户端整页重拉。 */
async function backfill(
  userId: string,
  afterId: number,
  write: (chunk: string) => boolean
): Promise<void> {
  try {
    const { messages, more } = await listMessagesSince(userId, afterId, BACKFILL_LIMIT);
    for (const m of messages) {
      if (!write(sseFrame({ type: 'message', channel_id: m.channel_id, message: m }, m.id))) return;
    }
    if (more) {
      write(sseFrame({ type: 'resync' } satisfies ChatStreamEvent));
    }
  } catch (e) {
    // 补齐失败不该断流：让客户端自己重拉一次（比静默漏消息好）
    console.error(`[chat-stream] 断线补齐失败（userId=${userId}, afterId=${afterId}）:`, e);
    write(sseFrame({ type: 'resync' } satisfies ChatStreamEvent));
  }
}
