// ─────────────────────────────────────────────────────────────────────────────
// GET /api/game/gomoku/rooms/:code/stream — 对局实时流（SSE）
//
// 单向推送足够：走子仍走 POST /api/game/gomoku/rooms/:code/moves，白拿 CSRF 同源
// 校验、限频与鉴权。开 WebSocket 需要自定义 server，会顶掉 next start 与 systemd
// unit（详见 docs/architecture.md 的取舍）。棋是回合制，SSE 的延迟完全够用。
//
// 【响应头】全部取自 @/lib/sse 的 SSE_HEADERS —— 那边的文件头记着 no-transform
// 为什么不可省。**本路由不要手写响应头。**
//
// 【断线补齐就是「一连上推一次全量状态」】不需要 Last-Event-ID、环形缓冲或 resync：
// 每帧都是完整状态，客户端按 revision 丢弃过期的即可。见 gomoku-shared.ts 文件头。
//
// 【鉴权在每次建立连接时重做】所以封禁/降权/专注模式变更后只要踢掉旧连接
// （game-bus.kickViewer / user-service），重连就会重新判定 —— 拿 403 时
// EventSource 按规范直接 fail 且不再重试。
// ─────────────────────────────────────────────────────────────────────────────

import { apiErr } from '@/lib/format';
import { canSubscribe, subscribe } from '@/lib/game-bus';
import { getSnapshot, refreshPresence } from '@/lib/gomoku-room';
import { normalizeRoomCode, type GomokuStreamEvent } from '@/lib/gomoku-shared';
import { SSE_HEADERS, SSE_QUEUE_LIMIT, SSE_RETRY_MS, sseFrame } from '@/lib/sse';
import { requireGameUser, roomErrorResponse } from '../../../_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request, ctx: { params: Promise<{ code: string }> }) {
  const user = await requireGameUser();
  if (user instanceof Response) return user;

  const { code: raw } = await ctx.params;
  const code = normalizeRoomCode(raw);
  if (!code) return apiErr(404, '房间不存在或已过期');

  // 房间不存在就别建流了 —— 建完再关掉只会让 EventSource 反复重连。
  const snapshot = getSnapshot(code, user.id);
  if (!snapshot.ok) return roomErrorResponse(snapshot.error);

  // 并发上限在建流**之前**判：等 subscribe 返回 null 时流已经建好，
  // 那时只能关掉流让客户端打转，回不了 429。
  if (!canSubscribe(user.id)) {
    return apiErr(429, '连接数过多，请关掉多余的标签页再试');
  }

  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | null = null;
  let closed = false;

  const cleanup = () => {
    if (closed) return;
    closed = true;
    unsubscribe?.();
    unsubscribe = null;
    // 断开后重算在线状态并把「已掉线」广播出去（对手据此显示并计时判胜）。
    // 必须在 unsubscribe **之后**调 —— 那时 connectionsIn 才数得准。
    refreshPresence(code, user.id);
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

        const closeStream = () => {
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
          closeStream();
          return;
        }

        const off = subscribe({
          roomCode: code,
          viewerId: user.id,
          write,
          close: () => {
            cleanup();
            closeStream();
          },
        });
        if (!off) {
          // 上面已用 canSubscribe 拦过，走到这里说明是并发竞态 —— 同样收摊。
          cleanup();
          closeStream();
          return;
        }
        unsubscribe = off;

        // 一连上就推当前全量状态：这就是断线补齐（见文件头）。
        write(sseFrame<GomokuStreamEvent>({ type: 'state', view: snapshot.value.view }));

        // 订阅**之后**才刷新在线状态：早于订阅会数到 0，把刚连上的自己判成掉线。
        refreshPresence(code, user.id);

        // 客户端主动断开（关标签页 / 网络断）时 Next 会 cancel 流；这里再挂一道
        // 保险，防止某些运行时下 cancel 不被触发导致订阅泄漏。
        req.signal.addEventListener('abort', () => {
          cleanup();
          closeStream();
        });
      },
      cancel() {
        cleanup();
      },
    },
    { highWaterMark: SSE_QUEUE_LIMIT }
  );

  return new Response(stream, { headers: SSE_HEADERS });
}
