// @vitest-environment jsdom
// ─────────────────────────────────────────────────────────────────────────────
// useChatGenerations —— 生成事件临时状态的 React 薄壳
//
// 【为什么测这些】reducer 的纯逻辑已在 chat-generation-reducer.test.ts 覆盖，这里
// 只钉住只有 hook 才有的三条行为：
//   1. applyEvent 跨渲染引用稳定（ChatApp 的 SSE effect 依赖它，变一次就重连）；
//   2. onCompleted 用 ref 取最新引用：父组件换回调不丢事件、不清状态；
//   3. 150 秒无新快照的预览由 hook 定时器清掉，卸载时定时器被回收。
// ─────────────────────────────────────────────────────────────────────────────

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  useChatGenerations,
  type ChatGenerationsController,
} from '@/app/chat/useChatGenerations';
import { CHAT_GENERATION_PREVIEW_TIMEOUT_MS, CHAT_GENERATION_SWEEP_INTERVAL_MS } from '@/lib/chat-generation-reducer';
import type { ChatAuthorDTO, ChatStreamEvent } from '@/lib/chat-shared';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const AUTHOR: ChatAuthorDTO = {
  id: 'u-bot',
  username: '机器人',
  avatar_url: '/static/avatars/u-bot.png',
  frame_url: null,
  bubble_key: null,
  is_admin: false,
};

const SNAPSHOT: ChatStreamEvent = {
  type: 'generation_snapshot',
  generation_id: 'gen-1',
  channel_id: 'ch-1',
  revision: 1,
  author: AUTHOR,
  source: '第一段',
};

const TERMINAL: ChatStreamEvent = {
  type: 'generation_terminal',
  generation_id: 'gen-1',
  channel_id: 'ch-1',
  revision: 2,
  status: 'completed',
  message_id: 99,
};

interface HarnessProps {
  holder: { current: ChatGenerationsController | null };
  onCompleted: (channelId: string, messageId: number) => void;
}

function Harness({ holder, onCompleted }: HarnessProps) {
  holder.current = useChatGenerations({ onCompleted });
  return <span data-testid="preview-count">{holder.current.generations.length}</span>;
}

const roots: Root[] = [];

async function mount(el: Parameters<Root['render']>[0]) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(el);
  });
  return { root, container };
}

afterEach(async () => {
  await act(async () => {
    for (const root of roots.splice(0)) root.unmount();
  });
  document.body.innerHTML = '';
  vi.useRealTimers();
});

function makeHolder() {
  return { current: null as ChatGenerationsController | null };
}

describe('useChatGenerations', () => {
  it('生成快照进入 generations；其他事件返回 false 且不改变状态', async () => {
    const holder = makeHolder();
    const onCompleted = vi.fn();
    await mount(<Harness holder={holder} onCompleted={onCompleted} />);

    expect(holder.current!.generations).toEqual([]);

    let accepted = false;
    await act(async () => {
      accepted = holder.current!.applyEvent(SNAPSHOT);
    });
    expect(accepted).toBe(true);
    expect(holder.current!.generations).toMatchObject([
      { generationId: 'gen-1', channelId: 'ch-1', revision: 1, source: '第一段' },
    ]);

    await act(async () => {
      expect(
        holder.current!.applyEvent({
          type: 'message',
          channel_id: 'ch-1',
          message: { id: 1 } as never,
        })
      ).toBe(false);
    });
    expect(holder.current!.generations).toHaveLength(1);
    expect(onCompleted).not.toHaveBeenCalled();
  });

  it('onCompleted 换引用不丢事件：快照保留、终态用最新回调通知一次', async () => {
    const holder = makeHolder();
    const first = vi.fn();
    const second = vi.fn();
    const { root } = await mount(<Harness holder={holder} onCompleted={first} />);

    await act(async () => {
      holder.current!.applyEvent(SNAPSHOT);
    });
    const applyEventBefore = holder.current!.applyEvent;

    await act(async () => {
      root.render(<Harness holder={holder} onCompleted={second} />);
    });
    expect(holder.current!.applyEvent, 'applyEvent 必须跨渲染稳定（SSE effect 的依赖）').toBe(
      applyEventBefore
    );
    expect(holder.current!.generations, '回调换引用不能重建状态').toHaveLength(1);

    await act(async () => {
      expect(holder.current!.applyEvent(TERMINAL)).toBe(true);
    });
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledWith('ch-1', 99);
    expect(holder.current!.generations).toEqual([]);

    // 重复终态不再通知
    await act(async () => {
      expect(holder.current!.applyEvent(TERMINAL)).toBe(false);
    });
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('removeGeneration / clearChannel / clearAll 通过 hook 驱动状态，墓碑挡住迟到快照', async () => {
    const holder = makeHolder();
    await mount(<Harness holder={holder} onCompleted={() => {}} />);

    await act(async () => {
      holder.current!.applyEvent(SNAPSHOT);
      holder.current!.applyEvent({ ...SNAPSHOT, generation_id: 'gen-2', channel_id: 'ch-2' });
    });
    expect(holder.current!.generations.map((p) => p.generationId)).toEqual(['gen-1', 'gen-2']);

    await act(async () => {
      holder.current!.removeGeneration('gen-1');
    });
    expect(holder.current!.generations.map((p) => p.generationId)).toEqual(['gen-2']);

    let lateAccepted = true;
    await act(async () => {
      lateAccepted = holder.current!.applyEvent({ ...SNAPSHOT, revision: 2 });
    });
    expect(lateAccepted).toBe(false);
    expect(holder.current!.generations).toHaveLength(1);

    await act(async () => {
      holder.current!.clearChannel('ch-2');
    });
    expect(holder.current!.generations).toEqual([]);

    // gen-1 已有墓碑，不能再用它验证 clearAll；换一个新任务
    await act(async () => {
      holder.current!.applyEvent({ ...SNAPSHOT, generation_id: 'gen-3' });
    });
    expect(holder.current!.generations).toHaveLength(1);
    await act(async () => {
      holder.current!.clearAll();
    });
    expect(holder.current!.generations).toEqual([]);
    expect(document.querySelector('[data-testid="preview-count"]')!.textContent).toBe('0');
  });

  it('150 秒没有新快照的预览被定时清掉；卸载时定时器回收', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));

    const holder = makeHolder();
    const { root } = await mount(<Harness holder={holder} onCompleted={() => {}} />);

    await act(async () => {
      holder.current!.applyEvent(SNAPSHOT);
    });
    expect(holder.current!.generations).toHaveLength(1);

    // 到 150 秒整仍保留（updatedAt=0，间隔尚未「超过」150 秒）
    await act(async () => {
      vi.advanceTimersByTime(CHAT_GENERATION_PREVIEW_TIMEOUT_MS);
    });
    expect(holder.current!.generations).toHaveLength(1);

    // 再过一拍清扫（10s 节拍），超时行被清掉
    await act(async () => {
      vi.advanceTimersByTime(CHAT_GENERATION_SWEEP_INTERVAL_MS);
    });
    expect(holder.current!.generations).toEqual([]);

    await act(async () => {
      root.unmount();
    });
    roots.length = 0;
    expect(vi.getTimerCount(), '卸载后不能再留清扫定时器').toBe(0);
  });
});