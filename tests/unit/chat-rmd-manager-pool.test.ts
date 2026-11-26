// ─────────────────────────────────────────────────────────────────────────────
// chat-rmd-manager-pool.test.ts — 跨页面复用的 Manager / Worker 租约
//
// 覆盖：同 scope 复用、最后一个租约释放后 10 分钟回收、租约期间不回收、
// 换 scope 立即清空、显式 clear 的 scope 隔离。池是模块级状态，每个用例结束
// 清空，避免把 Manager 漏给下一个用例。
// ─────────────────────────────────────────────────────────────────────────────

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatCompileManager } from '@/lib/chat-rmd/types';
import {
  CHAT_RMD_MANAGER_IDLE_MS,
  acquireChatRmdManager,
  clearChatRmdManager,
  peekChatRmdManager,
} from '@/app/chat/chat-rmd-manager-pool';

function fakeManager() {
  const dispose = vi.fn();
  const manager = {
    subscribe: vi.fn(() => () => {}),
    dispose,
    warmup: vi.fn(),
  } as unknown as ChatCompileManager;
  return { manager, dispose };
}

beforeEach(() => {
  vi.useFakeTimers();
  clearChatRmdManager();
});

afterEach(() => {
  clearChatRmdManager();
  vi.useRealTimers();
});

describe('chat-rmd-manager-pool', () => {
  it('同一 viewerScope 复用 Manager，最后一个租约释放后才开始计时', () => {
    const first = fakeManager();
    const unused = fakeManager();
    const lease1 = acquireChatRmdManager('viewer-a', () => first.manager);
    const lease2 = acquireChatRmdManager('viewer-a', () => unused.manager);

    expect(lease1.manager).toBe(first.manager);
    expect(lease2.manager).toBe(first.manager);
    expect(peekChatRmdManager('viewer-a')).toBe(first.manager);

    lease1.release();
    vi.advanceTimersByTime(CHAT_RMD_MANAGER_IDLE_MS - 1);
    expect(first.dispose).not.toHaveBeenCalled();

    // 还在第二个租约里，超时不会回收。
    vi.advanceTimersByTime(CHAT_RMD_MANAGER_IDLE_MS * 2);
    expect(first.dispose).not.toHaveBeenCalled();

    lease2.release();
    vi.advanceTimersByTime(CHAT_RMD_MANAGER_IDLE_MS - 1);
    expect(first.dispose).not.toHaveBeenCalled();

    // 到期前重新进入聊天：取消回收，继续用同一个 Manager。
    const lease3 = acquireChatRmdManager('viewer-a', () => unused.manager);
    expect(lease3.manager).toBe(first.manager);
    expect(peekChatRmdManager('viewer-a')).toBe(first.manager);
    lease3.release();

    vi.advanceTimersByTime(CHAT_RMD_MANAGER_IDLE_MS);
    expect(first.dispose).toHaveBeenCalledTimes(1);
    expect(peekChatRmdManager('viewer-a')).toBeNull();

    const next = fakeManager();
    const lease4 = acquireChatRmdManager('viewer-a', () => next.manager);
    expect(lease4.manager).toBe(next.manager);
    lease4.release();
  });

  it('换 viewerScope 立即清空旧 Manager，旧租约释放不误伤新池', () => {
    const old = fakeManager();
    const next = fakeManager();
    const oldLease = acquireChatRmdManager('viewer-a', () => old.manager);
    const nextLease = acquireChatRmdManager('viewer-b', () => next.manager);

    expect(old.dispose).toHaveBeenCalledTimes(1);
    expect(peekChatRmdManager('viewer-a')).toBeNull();
    expect(peekChatRmdManager('viewer-b')).toBe(next.manager);

    oldLease.release();
    expect(next.dispose).not.toHaveBeenCalled();
    nextLease.release();
    vi.advanceTimersByTime(CHAT_RMD_MANAGER_IDLE_MS);
    expect(next.dispose).toHaveBeenCalledTimes(1);
  });

  it('显式 clear 只清对应 scope，清空后迟到的 release 是 no-op', () => {
    const old = fakeManager();
    const next = fakeManager();
    const lease = acquireChatRmdManager('viewer-a', () => old.manager);

    clearChatRmdManager('viewer-b');
    expect(old.dispose).not.toHaveBeenCalled();

    clearChatRmdManager('viewer-a');
    expect(old.dispose).toHaveBeenCalledTimes(1);
    lease.release();
    vi.advanceTimersByTime(CHAT_RMD_MANAGER_IDLE_MS);
    expect(old.dispose).toHaveBeenCalledTimes(1);

    const nextLease = acquireChatRmdManager('viewer-a', () => next.manager);
    expect(nextLease.manager).toBe(next.manager);
    nextLease.release();
  });

  it('不传 scope 的 clear（登出）清掉任意 viewerScope', () => {
    const manager = fakeManager();
    acquireChatRmdManager('viewer-a', () => manager.manager);
    clearChatRmdManager();
    expect(manager.dispose).toHaveBeenCalledTimes(1);
    expect(peekChatRmdManager('viewer-a')).toBeNull();
  });
});