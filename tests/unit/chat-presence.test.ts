// ─────────────────────────────────────────────────────────────────────────────
// chat-presence.ts —— 「谁正在看哪个会话」
//
// 【为什么测这些】它决定「被 @ 时要不要发通知」，而判错的**两个方向不对称**：
//   • 判宽了（过期了 / 连接断了还算在看）→ 那条 @ 根本不产生，人永远不知道有人叫他；
//   • 判严了（明明在看却当成没看）→ 通知照常发，退化成加这个模块之前的行为。
// 所以下面每条的重点都是「什么情况下**必须**判为没在看」，别为了少打扰把口子开大。
//
// 三条判据（报到过 + 没过期 + 有讨论流连接）各测一条，外加「离开不用客户端报」
// 那条最要紧的：连接一断立刻不算 —— 那是关页面 / 切后台的唯一信号。
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  reportViewing,
  isViewingChannel,
  VIEWING_TTL_MS,
  __resetChatPresence,
} from '@/lib/chat-presence';
import { subscribe, onlineConnections, __resetChatBus, type ChatSubscriber } from '@/lib/chat-bus';

/** 模拟「这个人开着 /chat 页」：讨论流连着（客户端切后台会自己关掉它）。 */
function connect(userId: string): () => void {
  const sub: ChatSubscriber = {
    userId,
    focusMode: false,
    write: () => true,
    close: () => {},
  };
  return subscribe(sub);
}

beforeEach(() => {
  __resetChatPresence();
  __resetChatBus();
});

afterEach(() => {
  vi.useRealTimers();
  __resetChatPresence();
  __resetChatBus();
});

describe('chat-presence：三条判据', () => {
  it('报到过 + 没过期 + 连接活着 → 在看', () => {
    const off = connect('u-a');
    reportViewing('u-a', 'lobby');
    expect(isViewingChannel('u-a', 'lobby')).toBe(true);
    off();
  });

  it('没报到过 → 没在看（失败方向是照常发通知）', () => {
    const off = connect('u-a');
    expect(isViewingChannel('u-a', 'lobby')).toBe(false);
    off();
  });

  it('报到的是别的会话 → 没在看（切到私聊后大区的 @ 该发还得发）', () => {
    const off = connect('u-a');
    reportViewing('u-a', 'd_other');
    expect(isViewingChannel('u-a', 'lobby')).toBe(false);
    off();
  });

  it('连接断了（关页面 / 切后台）→ 立刻不算在看，不必等 TTL', () => {
    const off = connect('u-a');
    reportViewing('u-a', 'lobby');
    expect(isViewingChannel('u-a', 'lobby')).toBe(true);

    off();
    expect(isViewingChannel('u-a', 'lobby')).toBe(false);
  });

  it('超过 TTL → 没在看；再报到一次又算（客户端每 60s 续期）', () => {
    vi.useFakeTimers();
    const off = connect('u-a');
    reportViewing('u-a', 'lobby');

    vi.advanceTimersByTime(VIEWING_TTL_MS + 1);
    expect(isViewingChannel('u-a', 'lobby')).toBe(false);

    reportViewing('u-a', 'lobby');
    expect(isViewingChannel('u-a', 'lobby')).toBe(true);
    off();
  });

  it('TTL 边界内仍然算在看（续期间隔与 TTL 之间留了余量）', () => {
    vi.useFakeTimers();
    const off = connect('u-a');
    reportViewing('u-a', 'lobby');

    vi.advanceTimersByTime(VIEWING_TTL_MS - 1);
    expect(isViewingChannel('u-a', 'lobby')).toBe(true);
    off();
  });

  it('只看该用户自己的报到（别人的报到不会把我也判成在看）', () => {
    const off = connect('u-a');
    const offB = connect('u-b');
    reportViewing('u-b', 'lobby');
    expect(isViewingChannel('u-a', 'lobby')).toBe(false);
    expect(isViewingChannel('u-b', 'lobby')).toBe(true);
    off();
    offB();
    expect(onlineConnections()).toBe(0);
  });
});
