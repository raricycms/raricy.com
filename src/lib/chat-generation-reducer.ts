// ─────────────────────────────────────────────────────────────────────────────
// chat-generation-reducer.ts — 讨论流「生成中临时预览」的纯状态机（零 React / 零 DOM）
//
// 【职责】把 SSE 的 generation_snapshot / generation_terminal 折叠成一份可渲染状态：
//   · previews：未终止任务的完整累计正文，按首次出现顺序；
//   · tombstones：有界终态墓碑（上限 256，淘汰最旧），阻止迟到快照复活已终止任务。
// 正式 messages 由 ChatApp 自己维护；这里绝不能拿负数 id 伪造 ChatMessageDTO。
//
// 【接受规则】snapshot 必须有正安全整数 revision、非空 generation/channel id、完整
// author；首次到达任意 revision 都接受，之后只有 revision 严格变大才接受，已进墓碑
// （终态 / 正式消息已交接）一律拒绝。terminal 必须带终态 status，同一任务先到先赢；
// completed 带合法 message_id 时给出 completed 通知。任何不合法事件返回 accepted=
// false 且不改变状态，绝不抛异常。
//
// 【超时】预览超过 CHAT_GENERATION_PREVIEW_TIMEOUT_MS 没有新快照由
// pruneStaleChatGenerationPreviews 清掉（useChatGenerations 定时调用；纯函数便于测试）。
// 正文只活在本页内存，不写 localStorage / IndexedDB —— 私聊内容不落客户端存储。
//
// 【改动注意】事件形状以 src/lib/chat-shared.ts 为准（冻结协议），状态 / 错误标识见
// chat-generation-shared.ts，服务端发布在 src/lib/chat/generations.ts。改这里同步
// tests/unit/chat-generation-reducer.test.ts 与 useChatGenerations.ts。
// 设计背景：docs/plan/chat-reactive-streaming-design.md §7。
// ─────────────────────────────────────────────────────────────────────────────

import {
  isTerminalChatGenerationStatus,
  type ChatGenerationErrorCode,
  type ChatGenerationTerminalStatus,
} from './chat-generation-shared';
import type { ChatAuthorDTO } from './chat-shared';

/** 终态墓碑上限：超出后淘汰最旧，避免长时间挂机累积。 */
export const CHAT_GENERATION_TOMBSTONE_LIMIT = 256;

/** PRD §7：超过 150 秒没有新快照的临时行由客户端超时清掉。 */
export const CHAT_GENERATION_PREVIEW_TIMEOUT_MS = 150_000;

/** hook 内清扫定时器的节拍（超时判定按 updatedAt，不要求精确到毫秒）。 */
export const CHAT_GENERATION_SWEEP_INTERVAL_MS = 10_000;

/** 一条生成中的临时预览：完整累计正文，绝不是 ChatMessageDTO。 */
export interface ChatGenerationPreview {
  generationId: string;
  channelId: string;
  revision: number;
  author: ChatAuthorDTO;
  source: string;
  /** 最后一次收到快照的本地单调时间（Date.now），用于客户端超时清理。 */
  updatedAt: number;
}

/**
 * 终态墓碑：只记任务身份与终态，不保留 source（失败终态不能展示正文）。
 * `channelId` 为空串 = 通过正式消息学习到的 id（从未见过该任务的快照/终态）。
 */
export interface ChatGenerationTombstone {
  generationId: string;
  channelId: string;
  revision: number;
  status: ChatGenerationTerminalStatus;
  messageId?: number;
  error?: ChatGenerationErrorCode;
}

export interface ChatGenerationState {
  previews: ChatGenerationPreview[];
  /** 旧 → 新；超上限时从头部淘汰。 */
  tombstones: ChatGenerationTombstone[];
}

export const EMPTY_CHAT_GENERATION_STATE: ChatGenerationState = { previews: [], tombstones: [] };

/** terminal.completed 且带 message_id 时的交接通知（hook 转给 ChatApp 触发补拉）。 */
export interface ChatGenerationCompletedNotice {
  channelId: string;
  messageId: number;
}

export interface ChatGenerationApplyResult {
  state: ChatGenerationState;
  /** 是否被接受 / 改变了状态。其他事件类型、非法事件、重复终态均为 false。 */
  accepted: boolean;
  completed?: ChatGenerationCompletedNotice;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isPositiveSafeInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * 只校验渲染真正依赖的必需字段。逐字段过一遍的原因是 DTO 经过 JSON 传输，
 * 缺 avatar_url / frame_url 会让预览行静默渲染坏，而不是 throw 出来。
 */
function isChatAuthor(value: unknown): value is ChatAuthorDTO {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === 'string' &&
    typeof value.username === 'string' &&
    typeof value.avatar_url === 'string' &&
    (value.frame_url === null || typeof value.frame_url === 'string') &&
    (value.bubble_key === null || typeof value.bubble_key === 'string') &&
    typeof value.is_admin === 'boolean'
  );
}

function withoutPreviewAt(previews: ChatGenerationPreview[], index: number): ChatGenerationPreview[] {
  return [...previews.slice(0, index), ...previews.slice(index + 1)];
}

function withTombstone(
  tombstones: ChatGenerationTombstone[],
  tombstone: ChatGenerationTombstone
): ChatGenerationTombstone[] {
  const next = [...tombstones, tombstone];
  return next.length > CHAT_GENERATION_TOMBSTONE_LIMIT
    ? next.slice(next.length - CHAT_GENERATION_TOMBSTONE_LIMIT)
    : next;
}

function findTombstone(
  tombstones: ChatGenerationTombstone[],
  generationId: string
): ChatGenerationTombstone | undefined {
  return tombstones.find((t) => t.generationId === generationId);
}

interface SnapshotFields {
  generationId: string;
  channelId: string;
  revision: number;
  author: ChatAuthorDTO;
  source: string;
}

function readSnapshot(event: Record<string, unknown>): SnapshotFields | null {
  const generationId = asNonEmptyString(event.generation_id);
  const channelId = asNonEmptyString(event.channel_id);
  const revision = event.revision;
  const author = event.author;
  const source = event.source;
  if (
    !generationId ||
    !channelId ||
    !isPositiveSafeInt(revision) ||
    typeof source !== 'string' ||
    !isChatAuthor(author)
  ) {
    return null;
  }
  return { generationId, channelId, revision, author, source };
}

interface TerminalFields {
  generationId: string;
  channelId: string;
  revision: number;
  status: ChatGenerationTerminalStatus;
  messageId?: number;
  error?: ChatGenerationErrorCode;
}

function readTerminal(event: Record<string, unknown>): TerminalFields | null {
  const generationId = asNonEmptyString(event.generation_id);
  const channelId = asNonEmptyString(event.channel_id);
  const revision = event.revision;
  const status = event.status;
  if (
    !generationId ||
    !channelId ||
    !isPositiveSafeInt(revision) ||
    typeof status !== 'string' ||
    !isTerminalChatGenerationStatus(status)
  ) {
    return null;
  }

  // 可选字段出现时必须是预期形状：协议外的 null 视为「未提供」。
  let messageId: number | undefined;
  const rawMessageId = event.message_id;
  if (rawMessageId !== undefined && rawMessageId !== null) {
    if (!isPositiveSafeInt(rawMessageId)) return null;
    messageId = rawMessageId;
  }
  let error: ChatGenerationErrorCode | undefined;
  const rawError = event.error;
  if (rawError !== undefined && rawError !== null) {
    if (typeof rawError !== 'string') return null;
    error = rawError as ChatGenerationErrorCode;
  }

  return { generationId, channelId, revision, status, messageId, error };
}

function applySnapshot(state: ChatGenerationState, fields: SnapshotFields, now: number): ChatGenerationApplyResult {
  const { generationId, channelId, revision, author, source } = fields;

  // 墓碑判据优先于 revision：终态任务即使来了更大的 revision 也不能复活。
  if (findTombstone(state.tombstones, generationId)) {
    return { state, accepted: false };
  }

  const index = state.previews.findIndex((p) => p.generationId === generationId);
  if (index < 0) {
    // 首次到达：生成中途 / 丢帧后重新接上，任意 revision 都接受。
    const preview: ChatGenerationPreview = {
      generationId,
      channelId,
      revision,
      author,
      source,
      updatedAt: now,
    };
    return {
      state: { ...state, previews: [...state.previews, preview] },
      accepted: true,
    };
  }

  const current = state.previews[index];
  // generation id 全局唯一且频道不可变；同一任务换频道是非法帧。
  if (current.channelId !== channelId || revision <= current.revision) {
    return { state, accepted: false };
  }

  const next = state.previews.slice();
  next[index] = { ...current, revision, author, source, updatedAt: now };
  return { state: { ...state, previews: next }, accepted: true };
}

function applyTerminal(state: ChatGenerationState, fields: TerminalFields): ChatGenerationApplyResult {
  const { generationId, channelId, revision, status, messageId, error } = fields;

  const existing = findTombstone(state.tombstones, generationId);
  if (existing) {
    // 先到先赢：重复终态不改状态；若预览因故还在（理论上不可能），顺手清掉。
    const index = state.previews.findIndex((p) => p.generationId === generationId);
    if (index < 0) return { state, accepted: false };
    return {
      state: { ...state, previews: withoutPreviewAt(state.previews, index) },
      accepted: true,
    };
  }

  const index = state.previews.findIndex((p) => p.generationId === generationId);
  const previews = index < 0 ? state.previews : withoutPreviewAt(state.previews, index);

  const tombstone: ChatGenerationTombstone = {
    generationId,
    channelId,
    revision,
    status,
    ...(messageId != null ? { messageId } : {}),
    ...(error != null ? { error } : {}),
  };

  const completed: ChatGenerationCompletedNotice | undefined =
    status === 'completed' && messageId != null ? { channelId, messageId } : undefined;

  return {
    state: { previews, tombstones: withTombstone(state.tombstones, tombstone) },
    accepted: true,
    ...(completed ? { completed } : {}),
  };
}

/**
 * 处理一帧 SSE 事件。只认 `generation_snapshot` / `generation_terminal`；
 * 其他类型与非法形状一律 `accepted: false`，状态对象保持同一引用。
 */
export function applyChatGenerationEvent(
  state: ChatGenerationState,
  event: unknown,
  now: number
): ChatGenerationApplyResult {
  if (!isRecord(event)) return { state, accepted: false };
  const type = event.type;

  if (type === 'generation_snapshot') {
    const fields = readSnapshot(event);
    return fields ? applySnapshot(state, fields, now) : { state, accepted: false };
  }
  if (type === 'generation_terminal') {
    const fields = readTerminal(event);
    return fields ? applyTerminal(state, fields) : { state, accepted: false };
  }
  return { state, accepted: false };
}

/**
 * 正式消息带 generation_id 时调用：移除对应临时预览并记录终态墓碑。
 * 若该任务已有终态墓碑，保持第一条终态（正式消息并不改变墓碑判据）。
 */
export function removeChatGenerationPreview(
  state: ChatGenerationState,
  generationId: string
): ChatGenerationState {
  const id = asNonEmptyString(generationId);
  if (!id) return state;

  const index = state.previews.findIndex((p) => p.generationId === id);
  const previews = index < 0 ? state.previews : withoutPreviewAt(state.previews, index);

  if (findTombstone(state.tombstones, id)) {
    return previews === state.previews ? state : { ...state, previews };
  }

  const preview = index < 0 ? undefined : state.previews[index];
  const tombstone: ChatGenerationTombstone = {
    generationId: id,
    // 从未见过快照/终态时频道未知；这类墓碑只挡迟到快照，不参与按频道清理。
    channelId: preview?.channelId ?? '',
    revision: preview?.revision ?? 0,
    status: 'completed',
  };
  return { previews, tombstones: withTombstone(state.tombstones, tombstone) };
}

/** 切频道 / 断线 / resync 时清理该频道的预览与墓碑；其他频道不动。 */
export function clearChatGenerationChannel(
  state: ChatGenerationState,
  channelId: string
): ChatGenerationState {
  if (typeof channelId !== 'string' || channelId.length === 0) return state;

  const previews = state.previews.filter((p) => p.channelId !== channelId);
  const tombstones = state.tombstones.filter((t) => t.channelId !== channelId);
  if (previews.length === state.previews.length && tombstones.length === state.tombstones.length) {
    return state;
  }
  return { previews, tombstones };
}

/**
 * 清掉超过 idleMs 没有新快照的临时预览。墓碑不影响：超时只是不再显示，
 * 之后若又收到活动任务的新快照可以重新出现（服务端仍会为该任务发帧）。
 */
export function pruneStaleChatGenerationPreviews(
  state: ChatGenerationState,
  now: number,
  idleMs: number = CHAT_GENERATION_PREVIEW_TIMEOUT_MS
): ChatGenerationState {
  if (state.previews.length === 0) return state;
  const previews = state.previews.filter((p) => now - p.updatedAt <= idleMs);
  return previews.length === state.previews.length ? state : { ...state, previews };
}