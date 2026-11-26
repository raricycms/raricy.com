// ─────────────────────────────────────────────────────────────────────────────
// generations.ts — 机器人生成任务（R2）：内存状态、分块校验、完成发布与终态回执
//
// 【职责】参考 docs/plan/chat-reactive-streaming-design.md §5/§6：
//   • 活动任务与终态回执**只在内存**（挂 globalThis，重启即失效；不写库、不加表）；
//   • 分块只做序号/预算校验与快照广播，不产生任何消息副作用；
//   • 唯一正式发送出口是 ./messages 的 sendMessage（complete 时调用一次）；
//   • 终态回执保存 last_seq / status / error / message_id / HTTP 状态与响应体，
//     供重复 complete、cancel 与 GET 在保留期内做稳定重放。
//
// 【并发纪律】鉴权与频道访问检查可以 await；状态判定、容量登记、seq 追加、
// active→finalizing 切换与终态转换都必须落在**同步临界段**（检查后不允许再有
// await），否则并发 complete / cancel / 清扫会把旧快照当现状。complete 的发布
// Promise 登记在同一临界段里，同参数并发共用结果。
//
// 【时间】空闲/总时长与快照节流用单调时钟（performance.now()），**不读库内墙上
// 时间**。测试通过 __setChatGenerationClockForTest 注入，不暴露到 HTTP。
//
// 【资源】终态立即释放累计正文与片段；回执有界（15 分钟 / 4096 条，超容量先淘汰
// 最旧）；单个共享清扫定时器（unref，可释放），每次操作前补查。
//
// 改动注意：序列化给客户端的 DTO 与 SSE 事件类型来自 chat-generation-shared /
// chat-shared（冻结协议）。不要在本文件另写 prisma.chatMessage.create，也不要绕开
// sendMessage 发 @ 通知或改读游标。
// ─────────────────────────────────────────────────────────────────────────────

import { randomUUID } from 'node:crypto';
import { hasAdminRights, type SafeUser } from '../auth';
import { avatarUrl } from '../avatar-refs';
import { bubbleKeyFor } from '../bubble-service';
import {
  CHAT_FOCUS_BLOCKED_TITLE,
  CHAT_LOBBY_ID,
  CHAT_TEXT_MAX,
  type ChatAuthorDTO,
  type ChatMessageDTO,
  type ChatStreamGenerationSnapshotEvent,
  type ChatStreamGenerationTerminalEvent,
} from '../chat-shared';
import {
  type ChatGenerationCancelResult,
  type ChatGenerationChunkResult,
  type ChatGenerationCompleteResult,
  type ChatGenerationCreateResult,
  type ChatGenerationErrorCode,
  type ChatGenerationStatus,
  type ChatGenerationStatusResult,
  type ChatGenerationTerminalStatus,
} from '../chat-generation-shared';
import { publishToAll, publishToUsers } from '../chat-bus';
import { prisma } from '../db';
import { frameUrlFor } from '../frame-service';
import { apiErr } from '../format';
import { isRateLimited, rateLimit, RULES } from '../rate-limit';
import { canAccessChannel } from './channels';
import { CHAT_KIND_DIRECT, CHAT_KIND_LOBBY } from './constants';
import { sendMessage, type SendMessageResult } from './messages';

// ── 预算（方案初值，改数值 = 改协议契约，需同步 docs）────────────────────────

/** 单个任务允许的活动空闲时间（最后接受片段起算）。 */
export const CHAT_GENERATION_IDLE_TIMEOUT_MS = 120_000;
/** 单个任务总时长（从创建起算；complete 必须在此之前开始）。 */
export const CHAT_GENERATION_MAX_DURATION_MS = 600_000;
/** 全站同时存在的活动任务（含 finalizing）上限。 */
export const CHAT_GENERATION_MAX_ACTIVE_TASKS = 32;
/** 每作者同时存在的活动任务（含 finalizing）上限。 */
export const CHAT_GENERATION_MAX_ACTIVE_PER_AUTHOR = 1;
/** 每任务最多接受的片段数。 */
export const CHAT_GENERATION_MAX_CHUNKS = 512;
/** 单片段最多 UTF-16 字符单位（不含 HTTP 包装）。 */
export const CHAT_GENERATION_MAX_CHUNK_CHARS = 1024;
/** 终态回执保留上限（毫秒）。 */
export const CHAT_GENERATION_RECEIPT_TTL_MS = 15 * 60 * 1000;
/** 终态回执全站条数上限（超出提前淘汰最旧）。 */
export const CHAT_GENERATION_MAX_RECEIPTS = 4096;
/** 生成路由读取请求体的字节上限（片段契约 8 KiB，其余接口同口径）。 */
export const CHAT_GENERATION_ROUTE_MAX_BODY_BYTES = 8 * 1024;
/** 快照广播的最小间隔（每任务最多约 5 帧/秒，合并为最新完整快照）。 */
const SNAPSHOT_INTERVAL_MS = 200;
/** 过期清扫节拍；每次操作前还会同步补查一次。 */
const SWEEP_INTERVAL_MS = 15_000;
/** client_request_id 的宽松上限（UUID 远小于它）。 */
const CLIENT_REQUEST_ID_MAX = 128;

// ── 内存状态（globalThis：dev 热更新/模块重求值不丢已建立的任务）──────────────

interface GenerationTask {
  id: string;
  authorId: string;
  channelId: string;
  /** 'lobby' | 'direct'（创建时由 canAccessChannel 判出） */
  channelKind: string;
  /** direct：创建时取到的成员（含作者本人）；lobby 为 null（走广播） */
  recipients: string[] | null;
  clientRequestId: string;
  replyTo: number | null;
  /** 与正式消息相同展示字段的作者快照（快照事件用） */
  author: ChatAuthorDTO;
  status: ChatGenerationStatus; // active | finalizing（终态会从 tasks 移除）
  nextSeq: number;
  revision: number;
  /** 累计未 trim 正文（终态立即释放） */
  source: string;
  /** 已接受片段（下标 seq-1，重放比对用；终态立即释放） */
  chunks: string[];
  createdAt: number;
  lastActivityAt: number;
  lastSnapshotAt: number;
  snapshotTimer: ReturnType<typeof setTimeout> | null;
  finalizePromise: Promise<CompleteOutcome> | null;
  /** complete 进入 finalizing 时记录的序号（不同 last_seq 拒绝） */
  finalizeLastSeq: number | null;
  /** onPersisted 同步回执：写库成功即记录，后续失败按已提交处理 */
  messageId: number | null;
}

interface TerminalReceipt {
  generationId: string;
  authorId: string;
  channelId: string;
  clientRequestId: string;
  replyTo: number | null;
  /** 最后接受的序号（未提交片段 = 0） */
  lastSeq: number;
  nextSeq: number;
  revision: number;
  status: ChatGenerationTerminalStatus;
  error?: ChatGenerationErrorCode;
  messageId?: number;
  /** 重复 complete 要原样返回的 HTTP 状态 / 提示 / 结果（不含 chat_message） */
  httpStatus: number;
  message: string;
  result: ChatGenerationCompleteResult;
  savedAt: number;
}

interface GenerationsState {
  tasks: Map<string, GenerationTask>;
  /** authorId → generationId（active/finalizing 期间占用每作者名额） */
  authorActive: Map<string, string>;
  /** 插入序即淘汰序（最旧在前） */
  receipts: Map<string, TerminalReceipt>;
  /** `${authorId}\0${channelId}\0${clientRequestId}` → generationId（含回执期） */
  idempotency: Map<string, string>;
  sweepTimer: ReturnType<typeof setInterval> | null;
}

const globalForGenerations = globalThis as unknown as { __chatGenerations?: GenerationsState };
const state: GenerationsState = (globalForGenerations.__chatGenerations ??= {
  tasks: new Map(),
  authorActive: new Map(),
  receipts: new Map(),
  idempotency: new Map(),
  sweepTimer: null,
});

/** 单调时钟；测试可替换（不通过 HTTP 暴露）。 */
let monoNow: () => number = () => performance.now();

/** 仅供测试：替换单调时钟（超时与快照节流都读它），传 null 复位。 */
export function __setChatGenerationClockForTest(fn: (() => number) | null): void {
  monoNow = fn ?? (() => performance.now());
}

/** 仅供测试：清空任务、回执、幂等映射与定时器，并复位注入时钟。 */
export function __resetChatGenerations(): void {
  for (const task of state.tasks.values()) {
    if (task.snapshotTimer) clearTimeout(task.snapshotTimer);
  }
  state.tasks.clear();
  state.authorActive.clear();
  state.receipts.clear();
  state.idempotency.clear();
  if (state.sweepTimer) {
    clearInterval(state.sweepTimer);
    state.sweepTimer = null;
  }
  __setChatGenerationClockForTest(null);
}

// ── 对外结果形状 ─────────────────────────────────────────────────────────────

/** 生成接口的统一失败形状；路由按 status/error 组响应信封。 */
export interface ChatGenerationFailure {
  ok: false;
  status: number;
  error: ChatGenerationErrorCode;
  message: string;
  /** 冲突时带 next_seq / status 等辅助字段 */
  extra?: Record<string, unknown>;
}

export type CreateGenerationOutcome =
  | { ok: true; result: ChatGenerationCreateResult }
  | ChatGenerationFailure;

export type ChunkGenerationOutcome =
  | { ok: true; result: ChatGenerationChunkResult }
  | ChatGenerationFailure;

export type CompleteOutcome =
  | { ok: true; httpStatus: number; message: string; result: ChatGenerationCompleteResult }
  | ChatGenerationFailure;

export type CancelGenerationOutcome =
  | { ok: true; result: ChatGenerationCancelResult }
  | ChatGenerationFailure;

export type GetGenerationOutcome =
  | { ok: true; result: ChatGenerationStatusResult }
  | ChatGenerationFailure;

function failure(
  status: number,
  error: ChatGenerationErrorCode,
  message: string,
  extra?: Record<string, unknown>
): ChatGenerationFailure {
  return extra ? { ok: false, status, error, message, extra } : { ok: false, status, error, message };
}

const CAPACITY_MESSAGE = '同时进行的生成任务已达上限，请稍后再试';
const CREATE_RATE_MESSAGE = '创建生成任务过于频繁，请稍后再试';
const CHUNK_RATE_MESSAGE = '提交生成片段过于频繁，请稍后再试';
const FINALIZE_WARN_AFTER_MS = 30_000;

// ── 小工具 ───────────────────────────────────────────────────────────────────

function idemKey(authorId: string, channelId: string, clientRequestId: string): string {
  return `${authorId}\u0000${channelId}\u0000${clientRequestId}`;
}

/** 与 messages.ts 的 authorOf 同一字段口径（生成快照的 author 必须与正式消息一致）。 */
function authorDtoOf(row: {
  id: string;
  username: string;
  role: string;
  archivedAt: Date | null;
  equippedFrameKey: string | null;
  equippedFrameExpiresAt: Date | null;
  equippedBubbleKey: string | null;
  equippedBubbleExpiresAt: Date | null;
}): ChatAuthorDTO {
  if (row.archivedAt) {
    return {
      id: '',
      username: '已删除用户',
      avatar_url: avatarUrl('deleted'),
      frame_url: null,
      bubble_key: null,
      is_admin: false,
    };
  }
  return {
    id: row.id,
    username: row.username,
    avatar_url: avatarUrl(row.id),
    frame_url: frameUrlFor(row),
    bubble_key: bubbleKeyFor(row),
    is_admin: hasAdminRights(row),
  };
}

function createResult(generationId: string, nextSeq: number): ChatGenerationCreateResult {
  return {
    generation_id: generationId,
    next_seq: nextSeq,
    idle_timeout_ms: CHAT_GENERATION_IDLE_TIMEOUT_MS,
    max_duration_ms: CHAT_GENERATION_MAX_DURATION_MS,
  };
}

// ── 清扫 / 回执 ──────────────────────────────────────────────────────────────

function ensureSweepTimer(): void {
  if (state.sweepTimer) return;
  state.sweepTimer = setInterval(() => sweep(), SWEEP_INTERVAL_MS);
  (state.sweepTimer as unknown as { unref?: () => void }).unref?.();
}

function stopSweepTimerIfIdle(): void {
  if (!state.sweepTimer) return;
  if (state.tasks.size > 0 || state.receipts.size > 0) return;
  clearInterval(state.sweepTimer);
  state.sweepTimer = null;
}

/**
 * 活动任务在 `now` 是否已越过空闲或总时长截止点（与 sweep 同一口径）。
 *
 * 清扫与操作前的补查之外，**异步鉴权返回后还要再判一次**：鉴权可以 await，
 * 期间任务可能正好越过截止点，而共享清扫未必已经跑过。不复查就会让一个慢鉴权
 * 把分块续期、或让 complete 取得提交权。
 */
function isTaskDeadlinePassed(task: GenerationTask, now: number): boolean {
  return (
    now - task.createdAt >= CHAT_GENERATION_MAX_DURATION_MS ||
    now - task.lastActivityAt >= CHAT_GENERATION_IDLE_TIMEOUT_MS
  );
}

/**
 * 过期清扫。finalizing **不参与**超时判定：发布已经取得唯一提交权，
 * 不能因为总时长到点把任务释放或恢复成 active。
 */
function sweep(): void {
  const now = monoNow();
  for (const task of [...state.tasks.values()]) {
    if (task.status !== 'active') continue;
    if (isTaskDeadlinePassed(task, now)) expireTask(task);
  }
  for (const [id, receipt] of [...state.receipts]) {
    if (now - receipt.savedAt >= CHAT_GENERATION_RECEIPT_TTL_MS) dropReceipt(id);
  }
  stopSweepTimerIfIdle();
}

function dropReceipt(generationId: string): void {
  const receipt = state.receipts.get(generationId);
  if (!receipt) return;
  state.receipts.delete(generationId);
  const key = idemKey(receipt.authorId, receipt.channelId, receipt.clientRequestId);
  if (state.idempotency.get(key) === generationId) state.idempotency.delete(key);
}

function putReceipt(task: GenerationTask, revision: number, write: TerminalPayload, now: number): void {
  const receipt: TerminalReceipt = {
    generationId: task.id,
    authorId: task.authorId,
    channelId: task.channelId,
    clientRequestId: task.clientRequestId,
    replyTo: task.replyTo,
    lastSeq: task.nextSeq - 1,
    nextSeq: task.nextSeq,
    revision,
    status: write.status,
    error: write.error,
    messageId: write.messageId,
    httpStatus: write.httpStatus,
    message: write.message,
    result: write.result,
    savedAt: now,
  };
  state.receipts.set(task.id, receipt);
  // 超容量提前淘汰最旧（Map 迭代序 = 插入序）
  while (state.receipts.size > CHAT_GENERATION_MAX_RECEIPTS) {
    const oldest = state.receipts.keys().next();
    if (oldest.done) break;
    dropReceipt(oldest.value);
  }
}

interface TerminalPayload {
  status: ChatGenerationTerminalStatus;
  error?: ChatGenerationErrorCode;
  messageId?: number;
  httpStatus: number;
  message: string;
  /** 重复 complete 重放的结果体（不含 chat_message） */
  result: ChatGenerationCompleteResult;
}

/**
 * 终态转换的唯一出口：同步完成状态、释放缓冲、登记回执（先回执再广播）、
 * 移除活动名额并广播 generation_terminal。
 */
function finishTerminal(task: GenerationTask, payload: TerminalPayload): void {
  const now = monoNow();
  const revision = task.revision + 1;
  task.status = payload.status;
  if (task.snapshotTimer) {
    clearTimeout(task.snapshotTimer);
    task.snapshotTimer = null;
  }
  // 终态释放正文与片段；回执只留元数据、序号指纹与正式消息 id。
  task.source = '';
  task.chunks = [];
  state.tasks.delete(task.id);
  if (state.authorActive.get(task.authorId) === task.id) state.authorActive.delete(task.authorId);
  putReceipt(task, revision, payload, now);
  broadcastTerminal(task, revision, payload);
  stopSweepTimerIfIdle();
}

function expireTask(task: GenerationTask): void {
  finishTerminal(task, {
    status: 'expired',
    httpStatus: 410,
    message: '生成任务已过期',
    result: { status: 'expired' },
  });
}

/**
 * 失权（生产者不再是频道成员 / 大区被专注屏蔽）：停止接收、清空缓冲并广播终态。
 *
 * ⚠️ finalizing 绝不能在这里终结：发布已经取得唯一提交权，`sendMessage` 自身会做
 * 最终权限判定。此时若先广播 failed、又释放每作者名额，作者可以另建第二个任务并发
 * 发布；而原 Promise 拿到 message_id 后还会把回执覆盖成 completed（同一任务两个终态）。
 * 所以 finalizing 只拒绝本次请求，等唯一发送内核给出结论。
 */
function failLostAccess(task: GenerationTask): void {
  if (task.status === 'finalizing') return;
  finishTerminal(task, {
    status: 'failed',
    error: 'forbidden',
    httpStatus: 403,
    message: '无权继续该生成任务',
    result: { status: 'failed', error: 'forbidden' },
  });
}

// ── 广播 ─────────────────────────────────────────────────────────────────────

function broadcastEvent(task: GenerationTask, event: ChatStreamGenerationSnapshotEvent | ChatStreamGenerationTerminalEvent): void {
  try {
    if (task.channelKind === CHAT_KIND_LOBBY) {
      // 大区：全部在线连接，专注屏蔽大区的连接跳过（与正式消息同口径）。
      // 不传 SSE id：生成事件不占消息游标。
      publishToAll(event, undefined, { skipLobbyBlocked: true });
    } else if (task.recipients) {
      publishToUsers(task.recipients, event);
    }
  } catch (e) {
    // 广播失败不影响任务状态（客户端可靠下一次快照或正式消息补齐）
    console.error(`[chat-generations] 生成事件广播失败（id=${task.id}）:`, e);
  }
}

function broadcastSnapshot(task: GenerationTask): void {
  if (state.tasks.get(task.id) !== task) return; // 已终态：禁止再发快照
  task.lastSnapshotAt = monoNow();
  broadcastEvent(task, {
    type: 'generation_snapshot',
    generation_id: task.id,
    channel_id: task.channelId,
    revision: task.revision,
    author: task.author,
    source: task.source,
  });
}

/** 合并计时器：最多约 5 帧/秒，只发最新完整快照。 */
function scheduleSnapshot(task: GenerationTask): void {
  if (state.tasks.get(task.id) !== task) return;
  if (task.snapshotTimer) return;
  const wait = task.lastSnapshotAt === Number.NEGATIVE_INFINITY
    ? 0
    : SNAPSHOT_INTERVAL_MS - (monoNow() - task.lastSnapshotAt);
  if (wait <= 0) {
    broadcastSnapshot(task);
    return;
  }
  task.snapshotTimer = setTimeout(() => {
    task.snapshotTimer = null;
    broadcastSnapshot(task);
  }, wait);
  (task.snapshotTimer as unknown as { unref?: () => void }).unref?.();
}

function broadcastTerminal(task: GenerationTask, revision: number, payload: TerminalPayload): void {
  broadcastEvent(task, {
    type: 'generation_terminal',
    generation_id: task.id,
    channel_id: task.channelId,
    revision,
    status: payload.status,
    ...(payload.messageId != null ? { message_id: payload.messageId } : {}),
    ...(payload.error ? { error: payload.error } : {}),
  });
}

// ── 创建 ─────────────────────────────────────────────────────────────────────

/**
 * 创建生成任务。
 *
 * 顺序（方案 §5/§6）：鉴权后先查重（幂等键 + 规范化元数据），再判每作者/全站
 * 活动名额与创建限频；全部通过后在同步临界段重查这些条件并登记任务。
 */
export async function createGeneration(params: {
  authorId: string;
  channelId: string;
  lobbyBlocked: boolean;
  /** 请求体原值；形状校验在服务内完成（路由不替它做判断） */
  clientRequestId: unknown;
  replyTo: unknown;
}): Promise<CreateGenerationOutcome> {
  sweep();

  if (
    typeof params.clientRequestId !== 'string' ||
    params.clientRequestId.length === 0 ||
    params.clientRequestId.length > CLIENT_REQUEST_ID_MAX
  ) {
    return failure(400, 'invalid_request', 'client_request_id 必须是 1-128 字符的字符串');
  }
  let replyTo: number | null = null;
  if (params.replyTo !== undefined && params.replyTo !== null) {
    if (
      typeof params.replyTo !== 'number' ||
      !Number.isSafeInteger(params.replyTo) ||
      params.replyTo <= 0
    ) {
      return failure(400, 'invalid_request', 'reply_to 必须是正整数');
    }
    replyTo = params.replyTo;
  }
  const clientRequestId = params.clientRequestId;

  const access = await canAccessChannel(params.channelId, params.authorId, params.lobbyBlocked);
  if (!access.kind) return failure(404, 'not_found', '频道不存在');
  if (!access.allowed) {
    return failure(
      403,
      'forbidden',
      params.lobbyBlocked && params.channelId === CHAT_LOBBY_ID
        ? CHAT_FOCUS_BLOCKED_TITLE
        : '无权在该会话发言'
    );
  }

  // 幂等查重：活动任务与终态回执都映射回同一个 generation_id；
  // 规范化元数据（reply_to）不一致视为冲突。
  const key = idemKey(params.authorId, params.channelId, clientRequestId);
  const replay = lookupIdempotent(key, replyTo);
  if (replay) return replay;

  if (state.authorActive.has(params.authorId)) {
    return failure(503, 'capacity', CAPACITY_MESSAGE);
  }
  if (state.tasks.size >= CHAT_GENERATION_MAX_ACTIVE_TASKS) {
    return failure(503, 'capacity', CAPACITY_MESSAGE);
  }
  // 早期只做**不扣配额**的快速 429：真正的扣减必须与任务登记同处一个同步临界段，
  // 否则同一个 client_request_id 的并发重试会在查重之前各扣一次（见下方临界段）。
  if (isRateLimited(`chatgen:create:${params.authorId}`, RULES.chatGenerationCreateMinute)) {
    return failure(429, 'rate_limited', CREATE_RATE_MESSAGE);
  }

  // 作者 DTO 与私聊收件人：一次取齐（快照事件要用与正式消息一致的 author 字段）。
  const authorRow = await prisma.user.findUnique({
    where: { id: params.authorId },
    select: {
      id: true,
      username: true,
      role: true,
      archivedAt: true,
      equippedFrameKey: true,
      equippedFrameExpiresAt: true,
      equippedBubbleKey: true,
      equippedBubbleExpiresAt: true,
    },
  });
  if (!authorRow) return failure(403, 'forbidden', '无权使用讨论');
  let recipients: string[] | null = null;
  if (access.kind === CHAT_KIND_DIRECT) {
    // 私聊成员在频道创建后不再变化（没有移除成员的口子），创建时取一次即可。
    const members = await prisma.chatMember.findMany({
      where: { channelId: params.channelId },
      select: { userId: true },
    });
    recipients = members.map((m) => m.userId);
  }

  // ── 同步临界段：重查幂等 / 名额 / 创建配额后再登记 ──
  const replayAfterAwait = lookupIdempotent(key, replyTo);
  if (replayAfterAwait) return replayAfterAwait;
  if (state.authorActive.has(params.authorId)) {
    return failure(503, 'capacity', CAPACITY_MESSAGE);
  }
  if (state.tasks.size >= CHAT_GENERATION_MAX_ACTIVE_TASKS) {
    return failure(503, 'capacity', CAPACITY_MESSAGE);
  }
  // 创建配额只在**真正登记新任务**时扣一次：同 key 的并发重试已在上面的
  // replayAfterAwait 命中回执并直接返回，不会再消耗配额。扣减与登记之间不能有
  // await，否则并发请求仍能穿过这里各扣一次。
  const limiter = rateLimit(`chatgen:create:${params.authorId}`, RULES.chatGenerationCreateMinute);
  if (!limiter.allowed) return failure(429, 'rate_limited', CREATE_RATE_MESSAGE);

  const now = monoNow();
  const task: GenerationTask = {
    id: randomUUID(),
    authorId: params.authorId,
    channelId: params.channelId,
    channelKind: access.kind,
    recipients,
    clientRequestId,
    replyTo,
    author: authorDtoOf(authorRow),
    status: 'active',
    nextSeq: 1,
    revision: 0,
    source: '',
    chunks: [],
    createdAt: now,
    lastActivityAt: now,
    lastSnapshotAt: Number.NEGATIVE_INFINITY,
    snapshotTimer: null,
    finalizePromise: null,
    finalizeLastSeq: null,
    messageId: null,
  };
  state.tasks.set(task.id, task);
  state.authorActive.set(params.authorId, task.id);
  state.idempotency.set(key, task.id);
  ensureSweepTimer();
  return { ok: true, result: createResult(task.id, task.nextSeq) };
}

/** 幂等键命中时的返回；映射已失效（回执被淘汰）则清掉并返回 null。 */
function lookupIdempotent(key: string, replyTo: number | null): CreateGenerationOutcome | null {
  const generationId = state.idempotency.get(key);
  if (!generationId) return null;
  const task = state.tasks.get(generationId);
  if (task) {
    if (task.replyTo !== replyTo) return failure(409, 'conflict', 'client_request_id 已用于不同的生成参数');
    return { ok: true, result: createResult(task.id, task.nextSeq) };
  }
  const receipt = state.receipts.get(generationId);
  if (receipt) {
    if (receipt.replyTo !== replyTo) return failure(409, 'conflict', 'client_request_id 已用于不同的生成参数');
    return { ok: true, result: createResult(receipt.generationId, receipt.nextSeq) };
  }
  state.idempotency.delete(key);
  return null;
}

// ── 分块 ─────────────────────────────────────────────────────────────────────

/**
 * 旧序号重放的确认结果（不回写、不续命、不广播）。
 *
 * 返回**该片段被接受时的原结果**：每个新片段使 next_seq = seq+1、revision = seq
 * （初始 revision 为 0）。不返回任务当前值 —— 否则调用方可能把「已经前进到的位置」
 * 当成这次重放的确认，进而跳过尚未确认的片段；要拿当前值应查 GET。
 */
function replayChunkResult(_task: GenerationTask, seq: number): ChunkGenerationOutcome {
  return {
    ok: true,
    result: { accepted_seq: seq, next_seq: seq + 1, revision: seq },
  };
}

function chunkConflict(task: GenerationTask, message: string): ChatGenerationFailure {
  return failure(409, 'conflict', message, { next_seq: task.nextSeq });
}

/** 终态 / 已不在活动表时的分块拒绝：expired → 410，其余终态 → 409。 */
function chunkRejectionForReceipt(receipt: TerminalReceipt): ChatGenerationFailure {
  if (receipt.status === 'expired') {
    return failure(410, 'gone', '生成任务已过期', { next_seq: receipt.nextSeq });
  }
  return failure(409, 'conflict', '生成任务已结束', {
    next_seq: receipt.nextSeq,
    status: receipt.status,
  });
}

export async function appendGenerationChunk(params: {
  authorId: string;
  generationId: string;
  lobbyBlocked: boolean;
  seq: unknown;
  delta: unknown;
}): Promise<ChunkGenerationOutcome> {
  sweep();

  const task = state.tasks.get(params.generationId);
  if (!task) {
    const receipt = state.receipts.get(params.generationId);
    if (!receipt) return failure(404, 'not_found', '生成任务不存在');
    if (receipt.authorId !== params.authorId) return failure(403, 'forbidden', '无权操作该生成任务');
    return chunkRejectionForReceipt(receipt);
  }
  if (task.authorId !== params.authorId) return failure(403, 'forbidden', '无权操作该生成任务');

  // 每次操作重验生产者对频道的访问权；失权任务立即终止并清空缓冲。
  const access = await canAccessChannel(task.channelId, params.authorId, params.lobbyBlocked);
  if (!access.allowed || !access.kind) {
    const live = state.tasks.get(params.generationId);
    if (live) failLostAccess(live);
    return failure(403, 'forbidden', '无权继续该生成任务');
  }

  if (typeof params.seq !== 'number' || !Number.isSafeInteger(params.seq) || params.seq <= 0) {
    return failure(400, 'invalid_request', 'seq 必须是正整数');
  }
  if (typeof params.delta !== 'string' || params.delta.length === 0) {
    return failure(400, 'invalid_request', 'delta 必须是非空字符串');
  }
  const seq = params.seq;
  const delta = params.delta;

  const limiter = rateLimit(`chatgen:chunk:${params.authorId}`, RULES.chatGenerationChunkMinute);
  if (!limiter.allowed) return failure(429, 'rate_limited', CHUNK_RATE_MESSAGE);

  // ── 同步临界段：await 之后重取，避免把鉴权时的旧快照当现状 ──
  const current = state.tasks.get(params.generationId);
  if (current !== task) {
    const receipt = state.receipts.get(params.generationId);
    if (!receipt) return failure(404, 'not_found', '生成任务不存在');
    return chunkRejectionForReceipt(receipt);
  }
  // 鉴权 await 期间越过截止点：按时过期终结并拒绝，**不得**继续走 seq 追加 ——
  // 否则一个慢鉴权就能让分块续期（lastActivityAt）把任务无限续命。
  // finalizing 已有唯一提交权，不在这里终结（交给 finalize 的结论）。
  if (task.status === 'active' && isTaskDeadlinePassed(task, monoNow())) {
    expireTask(task);
    return failure(410, 'gone', '生成任务已过期', { next_seq: task.nextSeq });
  }
  if (task.status === 'finalizing') {
    return chunkConflict(task, '生成任务正在完成，不能再提交片段');
  }

  if (seq < task.nextSeq) {
    // 重放：同内容返回原确认（不追加、不续命、不广播）；异内容视为冲突。
    if (task.chunks[seq - 1] === delta) return replayChunkResult(task, seq);
    return chunkConflict(task, '序号与已接受内容不一致');
  }
  if (seq > task.nextSeq) return chunkConflict(task, '序号跳跃，请按 next_seq 继续');

  // 预算：片段数、单片段长度、累计未 trim 正文（每次接收前检查）。
  if (task.chunks.length >= CHAT_GENERATION_MAX_CHUNKS) {
    return failure(413, 'too_large', '生成片段数量已达上限');
  }
  if (delta.length > CHAT_GENERATION_MAX_CHUNK_CHARS) {
    return failure(413, 'too_large', `单个片段不能超过 ${CHAT_GENERATION_MAX_CHUNK_CHARS} 字符`);
  }
  if (task.source.length + delta.length > CHAT_TEXT_MAX) {
    return failure(413, 'too_large', `生成正文不能超过 ${CHAT_TEXT_MAX} 字`);
  }

  task.chunks.push(delta);
  task.source += delta;
  task.nextSeq = seq + 1;
  task.revision += 1;
  task.lastActivityAt = monoNow(); // 只有新片段被接受才续期
  scheduleSnapshot(task);
  return {
    ok: true,
    result: { accepted_seq: seq, next_seq: task.nextSeq, revision: task.revision },
  };
}

// ── 完成（唯一正式发布路径）──────────────────────────────────────────────────

/** sendMessage 的可证明未写入失败 → 生成终态错误码与 HTTP 状态。 */
function mapSendFailure(res: Extract<SendMessageResult, { ok: false }>): {
  error: ChatGenerationErrorCode;
  httpStatus: number;
  message: string;
} {
  switch (res.error) {
    case 'rateLimited':
      return { error: 'send_rate_limited', httpStatus: 429, message: res.message };
    case 'forbidden':
      return { error: 'send_forbidden', httpStatus: 403, message: res.message };
    case 'notFound':
      return { error: 'not_found', httpStatus: 404, message: res.message };
    case 'empty':
      return { error: 'empty', httpStatus: 400, message: res.message };
    case 'tooLong':
      return { error: 'too_long', httpStatus: 400, message: res.message };
    case 'replyInvalid':
      return { error: 'reply_invalid', httpStatus: 400, message: res.message };
    default:
      // imageInvalid / blogInvalid / patInvalid / captionTooLong 不会出现在纯文本生成里
      return { error: 'invalid_request', httpStatus: 400, message: res.message };
  }
}

/**
 * 冻结源码、调用唯一发送内核并落入终态。
 *
 * onPersisted 在 create 成功后同步记录 message_id；从此开始任何 DTO / 广播 /
 * 通知失败都按 completed 处理（客户端可用消息 id 读回）。抛错且没有 message_id
 * → commit_unknown：无法证明未提交，**不恢复 active、不自动重发**。
 */
async function runFinalize(task: GenerationTask, content: string, lobbyBlocked: boolean): Promise<CompleteOutcome> {
  let send: SendMessageResult | null = null;
  let thrown: unknown = null;
  try {
    send = await sendMessage({
      channelId: task.channelId,
      authorId: task.authorId,
      content,
      replyTo: task.replyTo,
      lobbyBlocked,
      // 内部回执：写库成功后、任何后续 await 之前同步调用（见 messages.ts）。
      onPersisted: (messageId) => {
        task.messageId = messageId;
      },
      // 正式 message 事件外层带 generation_id（不写库），客户端据此移除临时预览。
      broadcastGenerationId: task.id,
    });
  } catch (e) {
    thrown = e;
  }

  if (task.messageId != null) {
    const messageId = task.messageId;
    const dto: ChatMessageDTO | undefined = send && send.ok ? send.message : undefined;
    const message = '发送成功';
    finishTerminal(task, {
      status: 'completed',
      messageId,
      httpStatus: 200,
      message,
      result: { status: 'completed', message_id: messageId },
    });
    return {
      ok: true,
      httpStatus: 200,
      message,
      result: {
        status: 'completed',
        message_id: messageId,
        ...(dto ? { chat_message: dto } : {}),
      },
    };
  }

  if (thrown || (send && send.ok)) {
    // 写库抛错且无法确认是否提交；或 sendMessage 返回成功但内部回执没有登记
    // （理论上不可达，onPersisted 是纯赋值）。两种都说明消息可能已经落库，
    // 必须归入 commit_unknown —— 判 failed 会诱导调用方重发一条重复消息。
    const message = '消息写入结果未知，请先核对频道消息再决定是否重发';
    finishTerminal(task, {
      status: 'commit_unknown',
      error: 'commit_unknown',
      httpStatus: 500,
      message,
      result: { status: 'commit_unknown', error: 'commit_unknown', retryable: false },
    });
    return {
      ok: true,
      httpStatus: 500,
      message,
      result: { status: 'commit_unknown', error: 'commit_unknown', retryable: false },
    };
  }

  // sendMessage 返回的失败都能证明没有写入 → 归入 failed。
  const failureInfo = mapSendFailure(send as Extract<SendMessageResult, { ok: false }>);
  finishTerminal(task, {
    status: 'failed',
    error: failureInfo.error,
    httpStatus: failureInfo.httpStatus,
    message: failureInfo.message,
    result: { status: 'failed', error: failureInfo.error },
  });
  return {
    ok: true,
    httpStatus: failureInfo.httpStatus,
    message: failureInfo.message,
    result: { status: 'failed', error: failureInfo.error },
  };
}

/** 终态回执对于 complete 的重放（completed / failed / commit_unknown 共用）。 */
function replayComplete(receipt: TerminalReceipt): CompleteOutcome {
  return { ok: true, httpStatus: receipt.httpStatus, message: receipt.message, result: receipt.result };
}

export async function completeGeneration(params: {
  authorId: string;
  generationId: string;
  lobbyBlocked: boolean;
  lastSeq: unknown;
}): Promise<CompleteOutcome> {
  sweep();

  // last_seq 的形状先判：它同时参与「同参数并发共用结果」与回执重放比对。
  if (
    typeof params.lastSeq !== 'number' ||
    !Number.isSafeInteger(params.lastSeq) ||
    params.lastSeq < 0
  ) {
    return failure(400, 'invalid_request', 'last_seq 必须是非负整数');
  }
  const lastSeq = params.lastSeq;

  const task = state.tasks.get(params.generationId);
  if (!task) {
    const receipt = state.receipts.get(params.generationId);
    if (!receipt) return failure(404, 'not_found', '生成任务不存在');
    if (receipt.authorId !== params.authorId) return failure(403, 'forbidden', '无权操作该生成任务');
    // 终态重放同样重验频道访问：不能把已失权会话的 message_id 回给生产者。
    const receiptAccess = await canAccessChannel(receipt.channelId, params.authorId, params.lobbyBlocked);
    if (!receiptAccess.allowed || !receiptAccess.kind) {
      return failure(403, 'forbidden', '无权查看该生成任务');
    }
    const liveReceipt = state.receipts.get(params.generationId);
    if (!liveReceipt) return failure(404, 'not_found', '生成任务不存在');
    if (liveReceipt.status === 'expired') return failure(410, 'gone', '生成任务已过期');
    if (liveReceipt.status === 'cancelled') {
      return failure(409, 'conflict', '生成任务已取消', { status: 'cancelled' });
    }
    if (lastSeq !== liveReceipt.lastSeq) {
      return failure(409, 'conflict', 'last_seq 与已接受序号不一致', {
        next_seq: liveReceipt.nextSeq,
        status: liveReceipt.status,
      });
    }
    return replayComplete(liveReceipt);
  }
  if (task.authorId !== params.authorId) return failure(403, 'forbidden', '无权操作该生成任务');

  // complete 再判频道与回复目标：频道访问在这一步之前失败时不再进入发送内核。
  const access = await canAccessChannel(task.channelId, params.authorId, params.lobbyBlocked);
  if (!access.allowed || !access.kind) {
    const live = state.tasks.get(params.generationId);
    if (live) failLostAccess(live);
    return failure(403, 'forbidden', '无权继续该生成任务');
  }

  // ── 同步临界段：active → finalizing 原子切换并登记同一个 Promise ──
  const current = state.tasks.get(params.generationId);
  if (current !== task) {
    const receipt = state.receipts.get(params.generationId);
    if (!receipt) return failure(404, 'not_found', '生成任务不存在');
    if (receipt.status === 'expired') return failure(410, 'gone', '生成任务已过期');
    if (receipt.status === 'cancelled') {
      return failure(409, 'conflict', '生成任务已取消', { status: 'cancelled' });
    }
    if (lastSeq !== receipt.lastSeq) {
      return failure(409, 'conflict', 'last_seq 与已接受序号不一致', {
        next_seq: receipt.nextSeq,
        status: receipt.status,
      });
    }
    return replayComplete(receipt);
  }

  // 鉴权 await 期间越过截止点：active 任务不再取得提交权（不落库、不发正式消息）。
  // 与 chunk 同口径原地过期；finalizing 跳过（已有唯一提交权，等发送内核结论）。
  if (task.status === 'active' && isTaskDeadlinePassed(task, monoNow())) {
    expireTask(task);
    return failure(410, 'gone', '生成任务已过期');
  }

  if (task.status === 'finalizing') {
    if (task.finalizeLastSeq !== lastSeq || !task.finalizePromise) {
      return failure(409, 'conflict', '生成任务正在完成', { next_seq: task.nextSeq });
    }
    return task.finalizePromise;
  }

  if (lastSeq !== task.nextSeq - 1) {
    return failure(409, 'conflict', 'last_seq 与最后接受的序号不一致', {
      next_seq: task.nextSeq,
    });
  }

  // 冻结源码后立即登记提交权；此后不再接受 chunk / cancel。
  task.status = 'finalizing';
  task.finalizeLastSeq = lastSeq;
  const finalizePromise = runFinalize(task, task.source, params.lobbyBlocked);
  task.finalizePromise = finalizePromise;
  const watchdog = setTimeout(() => {
    if (task.status === 'finalizing') {
      console.error(
        `[chat-generations] finalizing 超过 ${FINALIZE_WARN_AFTER_MS}ms（id=${task.id}）`
      );
    }
  }, FINALIZE_WARN_AFTER_MS);
  void finalizePromise.then(
    () => clearTimeout(watchdog),
    () => clearTimeout(watchdog)
  );
  return task.finalizePromise;
}

// ── 取消 / 状态 ──────────────────────────────────────────────────────────────

function receiptTerminalResult(receipt: TerminalReceipt): ChatGenerationCancelResult {
  return {
    status: receipt.status,
    ...(receipt.error ? { error: receipt.error } : {}),
  };
}

export async function cancelGeneration(params: {
  authorId: string;
  generationId: string;
  lobbyBlocked: boolean;
}): Promise<CancelGenerationOutcome> {
  sweep();

  const task = state.tasks.get(params.generationId);
  if (!task) {
    const receipt = state.receipts.get(params.generationId);
    if (!receipt) return failure(404, 'not_found', '生成任务不存在');
    if (receipt.authorId !== params.authorId) return failure(403, 'forbidden', '无权操作该生成任务');
    const receiptAccess = await canAccessChannel(receipt.channelId, params.authorId, params.lobbyBlocked);
    if (!receiptAccess.allowed || !receiptAccess.kind) {
      return failure(403, 'forbidden', '无权查看该生成任务');
    }
    const liveReceipt = state.receipts.get(params.generationId);
    if (!liveReceipt) return failure(404, 'not_found', '生成任务不存在');
    if (liveReceipt.status === 'expired') return failure(410, 'gone', '生成任务已过期');
    return { ok: true, result: receiptTerminalResult(liveReceipt) };
  }
  if (task.authorId !== params.authorId) return failure(403, 'forbidden', '无权操作该生成任务');

  const access = await canAccessChannel(task.channelId, params.authorId, params.lobbyBlocked);
  if (!access.allowed || !access.kind) {
    const live = state.tasks.get(params.generationId);
    if (live) failLostAccess(live);
    return failure(403, 'forbidden', '无权继续该生成任务');
  }

  const current = state.tasks.get(params.generationId);
  if (current !== task) {
    const receipt = state.receipts.get(params.generationId);
    if (!receipt) return failure(404, 'not_found', '生成任务不存在');
    if (receipt.status === 'expired') return failure(410, 'gone', '生成任务已过期');
    return { ok: true, result: receiptTerminalResult(receipt) };
  }
  if (task.status === 'finalizing') {
    return failure(409, 'conflict', '生成任务正在完成，无法取消', { next_seq: task.nextSeq });
  }

  finishTerminal(task, {
    status: 'cancelled',
    httpStatus: 200,
    message: '已取消',
    result: { status: 'cancelled' },
  });
  return { ok: true, result: { status: 'cancelled' } };
}

export async function getGeneration(params: {
  authorId: string;
  generationId: string;
  lobbyBlocked: boolean;
}): Promise<GetGenerationOutcome> {
  sweep();

  const task = state.tasks.get(params.generationId);
  if (!task) {
    const receipt = state.receipts.get(params.generationId);
    if (!receipt) return failure(404, 'not_found', '生成任务不存在');
    if (receipt.authorId !== params.authorId) return failure(403, 'forbidden', '无权操作该生成任务');
    const access = await canAccessChannel(receipt.channelId, params.authorId, params.lobbyBlocked);
    if (!access.allowed || !access.kind) return failure(403, 'forbidden', '无权查看该生成任务');
    const live = state.receipts.get(params.generationId);
    if (!live) return failure(404, 'not_found', '生成任务不存在');
    return {
      ok: true,
      result: {
        status: live.status,
        next_seq: live.nextSeq,
        revision: live.revision,
        ...(live.messageId != null ? { message_id: live.messageId } : {}),
        ...(live.error ? { error: live.error } : {}),
      },
    };
  }
  if (task.authorId !== params.authorId) return failure(403, 'forbidden', '无权操作该生成任务');

  const access = await canAccessChannel(task.channelId, params.authorId, params.lobbyBlocked);
  if (!access.allowed || !access.kind) {
    const currentTask = state.tasks.get(params.generationId);
    if (currentTask) failLostAccess(currentTask);
    return failure(403, 'forbidden', '无权继续该生成任务');
  }

  const current = state.tasks.get(params.generationId);
  if (current !== task) {
    const receipt = state.receipts.get(params.generationId);
    if (!receipt) return failure(404, 'not_found', '生成任务不存在');
    return {
      ok: true,
      result: {
        status: receipt.status,
        next_seq: receipt.nextSeq,
        revision: receipt.revision,
        ...(receipt.messageId != null ? { message_id: receipt.messageId } : {}),
        ...(receipt.error ? { error: receipt.error } : {}),
      },
    };
  }

  return {
    ok: true,
    result: {
      status: task.status,
      next_seq: task.nextSeq,
      revision: task.revision,
    },
  };
}

// ── 路由公用（HTTP 信封辅助，只在生成接口使用）────────────────────────────────

/**
 * 在有界字节数内读取并解析 JSON。**在读取完整 JSON 之前**按累计字节数截断，
 * 不信任 Content-Length（慢速/伪造长度不能绕过 8 KiB 预算）。
 */
export async function readJsonBodyLimited(
  req: Request,
  maxBytes: number
): Promise<
  | { ok: true; value: unknown }
  | { ok: false; reason: 'too_large' | 'invalid_request' }
> {
  const body = req.body;
  if (!body) return { ok: true, value: undefined };

  const reader = body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        void reader.cancel().catch(() => {});
        return { ok: false, reason: 'too_large' };
      }
      parts.push(value);
    }
  } catch {
    return { ok: false, reason: 'invalid_request' };
  }

  if (parts.length === 0) return { ok: true, value: undefined };
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  try {
    const text = new TextDecoder().decode(bytes);
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, reason: 'invalid_request' };
  }
}

/**
 * requireChatUser 的 401/403 响应没有稳定的 error 字段（它是全站共用的）；
 * 生成接口契约要求错误响应带 error，这里重包一层并保留原提示文案。
 */
export async function chatGenerationAuthFailure(res: Response): Promise<Response> {
  let message = res.status === 401 ? '请先登录' : '无权使用该功能';
  try {
    const body = (await res.json()) as { message?: unknown };
    if (typeof body.message === 'string' && body.message) message = body.message;
  } catch {
    /* 响应体异常时用兜底文案 */
  }
  const error: ChatGenerationErrorCode = res.status === 401 ? 'unauthorized' : 'forbidden';
  return apiErr(res.status === 401 ? 401 : 403, message, { error });
}

/**
 * 读体窗口的二次鉴权（create / complete / chunks / cancel 共用；GET 无 body 不需要）。
 *
 * 首次 requireChatUser 之后到读完请求体之间，会话可能失效，或账号被禁言 / 降权 /
 * 屏蔽大区。读体完成后必须复核，不能拿首次的 user 快照继续操作任务：
 *   · 复核失败（401/403）→ 用 chatGenerationAuthFailure 重包，保持稳定 error 字段；
 *   · 复核通过但不是同一个人 → 403 forbidden（不能拿新账号去操作别人的任务）；
 *   · 通过时返回**复核后的用户**：authorId 与大区专注判定都必须用它，而不是旧快照。
 */
export async function revalidateGenerationAuthor(
  initialUserId: string,
  recheck: () => Promise<SafeUser | Response>
): Promise<SafeUser | Response> {
  const current = await recheck();
  if (current instanceof Response) return chatGenerationAuthFailure(current);
  if (current.id !== initialUserId) {
    return apiErr(403, '无权操作该生成任务', { error: 'forbidden' });
  }
  return current;
}
