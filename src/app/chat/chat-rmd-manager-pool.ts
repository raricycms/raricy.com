// ─────────────────────────────────────────────────────────────────────────────
// chat-rmd-manager-pool.ts — 跨页面复用的聊天 RMD Manager / Worker 池
//
// 客户端路由离开聊天页后不立刻 dispose Manager（连带 Worker 与 final 文档 LRU），
// 最后一个租约释放后保留 10 分钟；下次进入聊天页直接复用。超过 10 分钟没有租约
// 才终止 Worker 并清空缓存。
//
// 【租约】路由切换时新旧页面可能短暂同时挂载，所以按租约计数：只有最后一个
// release 才开始计时。clear 会无条件 dispose；旧租约随后的 release 因 Manager
// 已不在池中而变成 no-op，不会误清新实例。
//
// 【登录状态】池以 viewerScope 为界。换账号（或显式 clear）立即 dispose，绝不把
// 上一个查看者的编译结果、私聊正文或引用缓存留给下一个人。
// ─────────────────────────────────────────────────────────────────────────────

import { createChatCompileManager } from '@/lib/chat-rmd/compile-manager';
import type { ChatCompileManager } from '@/lib/chat-rmd/types';

/** 最后一个租约释放后，Worker 与本地编译缓存的保留时长。 */
export const CHAT_RMD_MANAGER_IDLE_MS = 10 * 60 * 1_000;

export type ChatRmdManagerFactory = () => ChatCompileManager;

interface PoolEntry {
  viewerScope: string;
  manager: ChatCompileManager;
  leases: number;
  timer: ReturnType<typeof setTimeout> | null;
}

let entry: PoolEntry | null = null;

export interface ChatRmdManagerLease {
  readonly manager: ChatCompileManager;
  readonly viewerScope: string;
  release(): void;
}

function disposeEntry(): void {
  const current = entry;
  if (!current) return;
  entry = null;
  if (current.timer !== null) clearTimeout(current.timer);
  current.manager.dispose();
}

/**
 * 取一个租约。同一 viewerScope 复用现有 Manager；换 scope 先清空旧池。
 * 调用方必须在页面卸载 / scope 切换时 release。
 */
export function acquireChatRmdManager(
  viewerScope: string,
  factory: ChatRmdManagerFactory = createChatCompileManager
): ChatRmdManagerLease {
  if (entry && entry.viewerScope !== viewerScope) disposeEntry();
  if (!entry) {
    entry = { viewerScope, manager: factory(), leases: 0, timer: null };
  }
  if (entry.timer !== null) {
    clearTimeout(entry.timer);
    entry.timer = null;
  }

  entry.leases += 1;
  const current = entry;
  const manager = current.manager;
  let active = true;

  return {
    manager,
    viewerScope,
    release() {
      if (!active) return;
      active = false;
      // 池已被 clear / 换 scope / 超时回收：这份租约已经失效。
      if (!entry || entry !== current) return;
      current.leases = Math.max(0, current.leases - 1);
      if (current.leases > 0 || current.timer !== null) return;
      current.timer = setTimeout(() => {
        current.timer = null;
        if (entry === current && current.leases === 0) disposeEntry();
      }, CHAT_RMD_MANAGER_IDLE_MS);
    },
  };
}

/** 不建租约、不延长寿命；只用于首帧判断池里是否已有同 scope 的 Manager。 */
export function peekChatRmdManager(viewerScope: string): ChatCompileManager | null {
  if (!entry || entry.viewerScope !== viewerScope) return null;
  return entry.manager;
}

/**
 * 立即清空。不传 viewerScope 清全部（登出 / 会话失效）；传了就只清对应作用域，
 * 防止旧页面的延迟清理误伤新账号。
 */
export function clearChatRmdManager(viewerScope?: string): void {
  if (!entry) return;
  if (viewerScope !== undefined && entry.viewerScope !== viewerScope) return;
  disposeEntry();
}