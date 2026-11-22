// ─────────────────────────────────────────────────────────────────────────────
// chat-generation-shared.ts — 机器人生成任务的跨端协议（零运行时依赖）
//
// 服务端 generation 服务、SSE 客户端与站外机器人文档共用这一份状态与错误标识。
// 这里只放类型、稳定字符串与纯判定函数；任务对象、计时器与广播都留在主站服务端
// （src/lib/chat/generations.ts），不要从这里 import 任何有副作用的模块。
//
// 状态机（docs/plan/chat-reactive-streaming-design.md §6）：
//   active → finalizing → completed
//      │          ├────→ failed
//      │          └────→ commit_unknown
//      ├────→ cancelled
//      └────→ expired
//
// ⚠️ 这些字符串是对外契约（机器人按它分支），改名等于破坏协议。新增状态/错误
// 只能追加，并同步 docs/bot/chat-bot.md 与路由测试。
// ─────────────────────────────────────────────────────────────────────────────

import type { ChatMessageDTO } from './chat-shared';

export type ChatGenerationStatus =
  | 'active'
  | 'finalizing'
  | 'completed'
  | 'failed'
  | 'commit_unknown'
  | 'cancelled'
  | 'expired';

export type ChatGenerationTerminalStatus = Exclude<ChatGenerationStatus, 'active' | 'finalizing'>;

const TERMINAL_STATUSES: ReadonlySet<string> = new Set<ChatGenerationTerminalStatus>([
  'completed',
  'failed',
  'commit_unknown',
  'cancelled',
  'expired',
]);

export function isTerminalChatGenerationStatus(status: string): status is ChatGenerationTerminalStatus {
  return TERMINAL_STATUSES.has(status);
}

/**
 * 稳定的机器可读错误标识。HTTP 状态由路由按场景映射，不写进这个联合 ——
 * 同一个 `conflict` 在创建重放、分块跳号与 finalizing 取消里都是 409。
 */
export type ChatGenerationErrorCode =
  /** 请求形状不合法（缺字段、seq 非正安全整数、delta 空串等）。 */
  | 'invalid_request'
  /** 未登录 / 会话失效。 */
  | 'unauthorized'
  /** 已登录但失权：非作者、禁言、core 以下、频道不可访问。 */
  | 'forbidden'
  /** 任务不存在或已超出回执保留期。 */
  | 'not_found'
  /** 序号/元数据/状态冲突（跳号、异内容重放、重复创建不同参数、取消 finalizing）。 */
  | 'conflict'
  /** 任务仍有过期回执：状态已知为 expired，但请求本身不再可用。 */
  | 'gone'
  /** 请求体或累计正文超过预算。 */
  | 'too_large'
  /** 创建/提交限频。 */
  | 'rate_limited'
  /** 全站活动任务已满。 */
  | 'capacity'
  /** 完成时正文为空（未提交任何分块）。 */
  | 'empty'
  /** 完成时正文超过 CHAT_TEXT_MAX。 */
  | 'too_long'
  /** 完成时 reply_to 指向的消息已失效。 */
  | 'reply_invalid'
  /** 正式发送内核拒绝（失权 / 禁言等），可带现有提示语义。 */
  | 'send_forbidden'
  /** 正式发送的分钟/日配额耗尽（继承 chatMinute/chatDaily）。 */
  | 'send_rate_limited'
  /** 写库结果未知；首版不自动重发。 */
  | 'commit_unknown';

export interface ChatGenerationCreateInput {
  /** 客户端生成的 UUID；与 channel 一起构成幂等键。 */
  client_request_id: string;
  /** 可选：完成后作为正式消息的引用回复目标。 */
  reply_to?: number | null;
}

export interface ChatGenerationCreateResult {
  generation_id: string;
  /** 下一个待提交序号（新任务为 1；创建重放返回任务当前值）。 */
  next_seq: number;
  idle_timeout_ms: number;
  max_duration_ms: number;
}

export interface ChatGenerationChunkInput {
  /** 从 1 开始的正安全整数。 */
  seq: number;
  /** 非空增量文本。 */
  delta: string;
}

export interface ChatGenerationChunkResult {
  /** 本次确认的序号（重放旧序号时是原始确认值）。 */
  accepted_seq: number;
  next_seq: number;
  revision: number;
}

export interface ChatGenerationCompleteInput {
  /** 必须与最后接受的序号一致；未提交片段的任务用 0。 */
  last_seq: number;
}

export interface ChatGenerationCompleteResult {
  status: ChatGenerationTerminalStatus;
  /** completed 必有；其余终态没有。 */
  message_id?: number;
  /** 正式消息 DTO；只在本次请求真正完成发布时返回，重放只给 id。 */
  chat_message?: ChatMessageDTO;
  error?: ChatGenerationErrorCode;
  /** 仅 commit_unknown 等不可重试终态显式给 false。 */
  retryable?: boolean;
}

export interface ChatGenerationCancelResult {
  status: ChatGenerationTerminalStatus;
  error?: ChatGenerationErrorCode;
}

export interface ChatGenerationStatusResult {
  status: ChatGenerationStatus;
  next_seq: number;
  revision: number;
  message_id?: number;
  error?: ChatGenerationErrorCode;
}