// chat-generation-reducer.ts —— 讨论流生成事件的客户端临时状态机
//
// 【为什么测这些】临时预览是「不落库、只活在内存」的一条旁路，规则写错不会报错：
//   · 快照按 revision 合并 —— 乱序 / 重复帧不能把正文改回旧版本；
//   · 终态墓碑 —— 迟到快照不能复活已终止或已交接给正式消息的气泡；
//   · 非法事件必须拒绝且不抛异常 —— 事件来自 JSON，形状不可信；
//   · 墓碑有界、超时清理 —— 挂机不能无限累积。
// 正式 messages 不归这里管；这里只断言 reducer 的纯状态转移。

import { describe, expect, it } from 'vitest';
import type { ChatAuthorDTO, ChatStreamEvent } from '@/lib/chat-shared';
import {
  CHAT_GENERATION_PREVIEW_TIMEOUT_MS,
  CHAT_GENERATION_TOMBSTONE_LIMIT,
  EMPTY_CHAT_GENERATION_STATE,
  applyChatGenerationEvent,
  clearChatGenerationChannel,
  pruneStaleChatGenerationPreviews,
  removeChatGenerationPreview,
  type ChatGenerationState,
} from '@/lib/chat-generation-reducer';

const AUTHOR: ChatAuthorDTO = {
  id: 'u-bot',
  username: '机器人',
  avatar_url: '/static/avatars/u-bot.png',
  frame_url: null,
  bubble_key: null,
  is_admin: false,
};

function snapshot(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'generation_snapshot',
    generation_id: 'gen-1',
    channel_id: 'ch-1',
    revision: 1,
    author: AUTHOR,
    source: '第一段',
    ...overrides,
  };
}

function terminal(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'generation_terminal',
    generation_id: 'gen-1',
    channel_id: 'ch-1',
    revision: 2,
    status: 'completed',
    message_id: 99,
    ...overrides,
  };
}

/** 连续喂事件的小 runner：断言时只看最终状态与每一步的 accepted。 */
function feed(state: ChatGenerationState, event: unknown, now = 0) {
  return applyChatGenerationEvent(state, event, now);
}

describe('chat-generation-reducer：snapshot 的接受与 revision 合并', () => {
  it('首次到达任意 revision 都接受，并保留完整字段与 updatedAt', () => {
    const r = feed(EMPTY_CHAT_GENERATION_STATE, snapshot({ revision: 7 }), 1234);
    expect(r.accepted).toBe(true);
    expect(r.state.previews).toEqual([
      {
        generationId: 'gen-1',
        channelId: 'ch-1',
        revision: 7,
        author: AUTHOR,
        source: '第一段',
        updatedAt: 1234,
      },
    ]);
    expect(r.completed).toBeUndefined();
  });

  it('只有 revision 严格变大才替换正文；相同 / 更小 revision 原样拒绝（状态同一引用）', () => {
    const first = feed(EMPTY_CHAT_GENERATION_STATE, snapshot({ revision: 2, source: '旧' }), 100);
    const same = feed(first.state, snapshot({ revision: 2, source: '重复' }), 200);
    expect(same.accepted).toBe(false);
    expect(same.state).toBe(first.state);

    const lower = feed(first.state, snapshot({ revision: 1, source: '更旧' }), 300);
    expect(lower.accepted).toBe(false);
    expect(lower.state).toBe(first.state);

    const higher = feed(first.state, snapshot({ revision: 3, source: '新' }), 400);
    expect(higher.accepted).toBe(true);
    expect(higher.state.previews).toHaveLength(1);
    expect(higher.state.previews[0].source).toBe('新');
    expect(higher.state.previews[0].revision).toBe(3);
    expect(higher.state.previews[0].updatedAt, 'updatedAt 必须随快照刷新').toBe(400);
  });

  it('多个任务按首次出现顺序保留；替换其中一个不改变顺序', () => {
    let state = feed(EMPTY_CHAT_GENERATION_STATE, snapshot({ generation_id: 'a' })).state;
    state = feed(state, snapshot({ generation_id: 'b' })).state;
    state = feed(state, snapshot({ generation_id: 'c' })).state;
    state = feed(state, snapshot({ generation_id: 'b', revision: 2, source: 'b2' })).state;

    expect(state.previews.map((p) => p.generationId)).toEqual(['a', 'b', 'c']);
    expect(state.previews[1].source).toBe('b2');
  });

  it('同一任务换频道是非法帧：拒绝且不改变状态', () => {
    const first = feed(EMPTY_CHAT_GENERATION_STATE, snapshot());
    const moved = feed(first.state, snapshot({ channel_id: 'ch-2', revision: 2 }));
    expect(moved.accepted).toBe(false);
    expect(moved.state).toBe(first.state);
    expect(moved.state.previews[0].channelId).toBe('ch-1');
  });
});

describe('chat-generation-reducer：非法事件一律拒绝且不抛', () => {
  const invalidSnapshots: Array<[string, unknown]> = [
    ['null', null],
    ['数组', []],
    ['字符串', 'generation_snapshot'],
    ['缺 generation_id', snapshot({ generation_id: undefined })],
    ['空 generation_id', snapshot({ generation_id: '' })],
    ['generation_id 非字符串', snapshot({ generation_id: 7 })],
    ['缺 channel_id', snapshot({ channel_id: undefined })],
    ['空 channel_id', snapshot({ channel_id: '' })],
    ['revision 0', snapshot({ revision: 0 })],
    ['revision 负数', snapshot({ revision: -1 })],
    ['revision 小数', snapshot({ revision: 1.5 })],
    ['revision NaN', snapshot({ revision: Number.NaN })],
    ['revision Infinity', snapshot({ revision: Number.POSITIVE_INFINITY })],
    ['revision 超安全整数', snapshot({ revision: Number.MAX_SAFE_INTEGER + 1 })],
    ['revision 字符串', snapshot({ revision: '2' })],
    ['缺 source', snapshot({ source: undefined })],
    ['source 非字符串', snapshot({ source: 3 })],
    ['缺 author', snapshot({ author: undefined })],
    ['author 不是对象', snapshot({ author: '机器人' })],
    ['author 缺 avatar_url', snapshot({ author: { ...AUTHOR, avatar_url: undefined } })],
    ['author 缺 bubble_key', snapshot({ author: { ...AUTHOR, bubble_key: undefined } })],
    ['author is_admin 非布尔', snapshot({ author: { ...AUTHOR, is_admin: 'yes' } })],
    ['未知事件类型', { type: 'generation_unknown' }],
    ['正式消息事件', { type: 'message', channel_id: 'ch-1', message: { id: 1 } }],
  ];

  for (const [name, event] of invalidSnapshots) {
    it(`拒绝 snapshot：${name}`, () => {
      expect(() => applyChatGenerationEvent(EMPTY_CHAT_GENERATION_STATE, event, 0)).not.toThrow();
      const r = applyChatGenerationEvent(EMPTY_CHAT_GENERATION_STATE, event, 0);
      expect(r.accepted).toBe(false);
      expect(r.state).toBe(EMPTY_CHAT_GENERATION_STATE);
      expect(r.completed).toBeUndefined();
    });
  }

  const invalidTerminals: Array<[string, unknown]> = [
    ['缺 generation_id', terminal({ generation_id: undefined })],
    ['缺 channel_id', terminal({ channel_id: undefined })],
    ['revision 非正安全整数', terminal({ revision: 0 })],
    ['status 是 active', terminal({ status: 'active' })],
    ['status 是 finalizing', terminal({ status: 'finalizing' })],
    ['status 未知', terminal({ status: 'done' })],
    ['completed 带非法 message_id', terminal({ message_id: 0 })],
    ['completed 带字符串 message_id', terminal({ message_id: '99' })],
    ['error 非字符串', terminal({ status: 'failed', message_id: undefined, error: 3 })],
  ];

  for (const [name, event] of invalidTerminals) {
    it(`拒绝 terminal：${name}`, () => {
      const first = feed(EMPTY_CHAT_GENERATION_STATE, snapshot(), 10);
      expect(() => applyChatGenerationEvent(first.state, event, 20)).not.toThrow();
      const r = applyChatGenerationEvent(first.state, event, 20);
      expect(r.accepted, '非法终态不能移除预览').toBe(false);
      expect(r.state).toBe(first.state);
      expect(r.state.previews).toHaveLength(1);
      expect(r.state.tombstones).toHaveLength(0);
    });
  }
});

describe('chat-generation-reducer：终态与交接', () => {
  it('terminal 移除预览、记录墓碑；completed 带 message_id 给出补拉通知', () => {
    const first = feed(EMPTY_CHAT_GENERATION_STATE, snapshot({ revision: 5, source: '只用于临时展示' }), 10);
    const r = feed(first.state, terminal({ revision: 6, message_id: 99 }), 20);

    expect(r.accepted).toBe(true);
    expect(r.state.previews).toEqual([]);
    expect(r.state.tombstones).toEqual([
      {
        generationId: 'gen-1',
        channelId: 'ch-1',
        revision: 6,
        status: 'completed',
        messageId: 99,
      },
    ]);
    expect(r.completed).toEqual({ channelId: 'ch-1', messageId: 99 });
    expect('source' in r.state.tombstones[0], '终态不能保留正文').toBe(false);
  });

  it('completed 缺 message_id：接受终态但不触发补拉（等正式 message 关联）', () => {
    const first = feed(EMPTY_CHAT_GENERATION_STATE, snapshot(), 10);
    const r = feed(first.state, terminal({ message_id: undefined }), 20);
    expect(r.accepted).toBe(true);
    expect(r.completed).toBeUndefined();
    expect(r.state.previews).toEqual([]);
    expect(r.state.tombstones[0].messageId).toBeUndefined();
  });

  it('失败终态：移除预览、记录错误标识、不触发补拉', () => {
    const first = feed(EMPTY_CHAT_GENERATION_STATE, snapshot(), 10);
    const r = feed(
      first.state,
      terminal({ status: 'failed', message_id: undefined, error: 'send_rate_limited' }),
      20
    );
    expect(r.accepted).toBe(true);
    expect(r.state.previews).toEqual([]);
    expect(r.state.tombstones[0]).toMatchObject({
      status: 'failed',
      error: 'send_rate_limited',
    });
    expect(r.completed).toBeUndefined();
  });

  it('重复终态先到先赢：不改状态、不重复通知', () => {
    const first = feed(EMPTY_CHAT_GENERATION_STATE, snapshot(), 10);
    const done = feed(first.state, terminal({ revision: 6 }), 20);
    const duplicate = feed(done.state, terminal({ revision: 7, message_id: 100 }), 30);
    expect(duplicate.accepted).toBe(false);
    expect(duplicate.state).toBe(done.state);
    expect(duplicate.state.tombstones).toHaveLength(1);
    expect(duplicate.state.tombstones[0].messageId).toBe(99);
    expect(duplicate.completed).toBeUndefined();
  });

  it('终态之后到达的快照不能复活预览（墓碑判据优先于 revision）', () => {
    const first = feed(EMPTY_CHAT_GENERATION_STATE, snapshot({ revision: 1 }), 10);
    const done = feed(first.state, terminal({ revision: 2 }), 20);
    const late = feed(done.state, snapshot({ revision: 999, source: '迟到的正文' }), 30);
    expect(late.accepted).toBe(false);
    expect(late.state).toBe(done.state);
    expect(late.state.previews).toEqual([]);
  });

  it('正式 message 先到（removeGeneration）：移除预览并立墓碑，后续快照被拒', () => {
    const first = feed(EMPTY_CHAT_GENERATION_STATE, snapshot({ revision: 3 }), 10);
    const removed = removeChatGenerationPreview(first.state, 'gen-1');
    expect(removed.previews).toEqual([]);
    expect(removed.tombstones).toEqual([
      { generationId: 'gen-1', channelId: 'ch-1', revision: 3, status: 'completed' },
    ]);

    const late = feed(removed, snapshot({ revision: 4 }), 20);
    expect(late.accepted).toBe(false);
    expect(late.state).toBe(removed);
  });

  it('removeGeneration 重复调用 / 未知 id 不重复记墓碑', () => {
    const first = feed(EMPTY_CHAT_GENERATION_STATE, snapshot(), 10);
    const removed = removeChatGenerationPreview(first.state, 'gen-1');
    expect(removeChatGenerationPreview(removed, 'gen-1')).toBe(removed);
    expect(removeChatGenerationPreview(removed, '')).toBe(removed);
  });

  it('从未见过快照的正式 message：记一条频道未知的墓碑，迟到快照仍被拒', () => {
    const state = removeChatGenerationPreview(EMPTY_CHAT_GENERATION_STATE, 'gen-x');
    expect(state.tombstones).toEqual([
      { generationId: 'gen-x', channelId: '', revision: 0, status: 'completed' },
    ]);
    const late = feed(state, snapshot({ generation_id: 'gen-x', revision: 1 }), 10);
    expect(late.accepted).toBe(false);
  });

  it('已有失败终态墓碑时，正式 message 的 removeGeneration 不覆盖终态', () => {
    const first = feed(EMPTY_CHAT_GENERATION_STATE, snapshot(), 10);
    const failed = feed(
      first.state,
      terminal({ status: 'failed', message_id: undefined, error: 'commit_unknown' }),
      20
    );
    const afterMessage = removeChatGenerationPreview(failed.state, 'gen-1');
    expect(afterMessage).toBe(failed.state);
    expect(afterMessage.tombstones[0].status).toBe('failed');
  });

  it('墓碑有界：超过 256 条淘汰最旧，保留最近的终态', () => {
    let state = EMPTY_CHAT_GENERATION_STATE;
    for (let i = 0; i < CHAT_GENERATION_TOMBSTONE_LIMIT + 44; i++) {
      state = feed(
        state,
        terminal({
          generation_id: `gen-${i}`,
          status: 'failed',
          message_id: undefined,
          error: 'empty',
        })
      ).state;
    }
    expect(state.tombstones).toHaveLength(CHAT_GENERATION_TOMBSTONE_LIMIT);
    expect(state.tombstones[0].generationId).toBe('gen-44');
    expect(state.tombstones[state.tombstones.length - 1].generationId).toBe('gen-299');
  });
});

describe('chat-generation-reducer：按频道清理与超时', () => {
  it('clearChannel 只清该频道的预览与墓碑，其他频道不受影响', () => {
    let state = feed(EMPTY_CHAT_GENERATION_STATE, snapshot({ generation_id: 'a', channel_id: 'ch-1' })).state;
    state = feed(state, snapshot({ generation_id: 'b', channel_id: 'ch-2' })).state;
    state = feed(state, terminal({ generation_id: 'c', channel_id: 'ch-1' })).state;

    const cleared = clearChatGenerationChannel(state, 'ch-1');
    expect(cleared.previews.map((p) => p.generationId)).toEqual(['b']);
    expect(cleared.tombstones).toEqual([]);
    expect(clearChatGenerationChannel(cleared, 'ch-1'), '没有可清的东西时保持同一引用').toBe(cleared);
  });

  it('clearChannel 不吞掉未知频道的墓碑（它只能被上限淘汰）', () => {
    const state = removeChatGenerationPreview(EMPTY_CHAT_GENERATION_STATE, 'gen-x');
    expect(clearChatGenerationChannel(state, 'ch-1')).toBe(state);
  });

  it('超过 150 秒没有新快照的预览被清掉；刷新过的预览按最后快照计时', () => {
    let state = feed(EMPTY_CHAT_GENERATION_STATE, snapshot({ revision: 1 }), 1_000).state;
    state = feed(state, snapshot({ revision: 2 }), 100_000).state;

    const almost = pruneStaleChatGenerationPreviews(state, 100_000 + CHAT_GENERATION_PREVIEW_TIMEOUT_MS);
    expect(almost.previews, '恰好 150 秒仍算「没有超过」').toHaveLength(1);

    const expired = pruneStaleChatGenerationPreviews(
      state,
      100_000 + CHAT_GENERATION_PREVIEW_TIMEOUT_MS + 1
    );
    expect(expired.previews).toEqual([]);
  });

  it('超时清理不动墓碑；空预览时返回同一引用', () => {
    const done = feed(feed(EMPTY_CHAT_GENERATION_STATE, snapshot(), 0).state, terminal(), 10).state;
    expect(pruneStaleChatGenerationPreviews(done, 10 + CHAT_GENERATION_PREVIEW_TIMEOUT_MS + 1)).toBe(
      done
    );
    expect(
      pruneStaleChatGenerationPreviews(EMPTY_CHAT_GENERATION_STATE, Number.MAX_SAFE_INTEGER)
    ).toBe(EMPTY_CHAT_GENERATION_STATE);
  });

  it('超时清掉的预览在收到新的活动快照后可以重新出现（不记墓碑）', () => {
    const first = feed(EMPTY_CHAT_GENERATION_STATE, snapshot({ revision: 1 }), 0);
    const expired = pruneStaleChatGenerationPreviews(
      first.state,
      CHAT_GENERATION_PREVIEW_TIMEOUT_MS + 1
    );
    expect(expired.previews).toEqual([]);
    const revived = feed(expired, snapshot({ revision: 2 }), CHAT_GENERATION_PREVIEW_TIMEOUT_MS + 2);
    expect(revived.accepted).toBe(true);
    expect(revived.state.previews).toHaveLength(1);
  });
});

describe('chat-generation-reducer：不可变性与事件类型边界', () => {
  it('新帧不原地修改旧状态（旧数组 / 旧对象保持不变）', () => {
    const first = feed(EMPTY_CHAT_GENERATION_STATE, snapshot({ source: '旧' }), 10);
    const previewBefore = first.state.previews[0];
    const higher = feed(first.state, snapshot({ revision: 2, source: '新' }), 20);

    expect(first.state.previews).toHaveLength(1);
    expect(first.state.previews[0]).toBe(previewBefore);
    expect(previewBefore.source).toBe('旧');
    expect(previewBefore.revision).toBe(1);
    expect(higher.state.previews[0]).not.toBe(previewBefore);
  });

  it('其他 SSE 事件类型返回 false 且不改变状态', () => {
    const events: ChatStreamEvent[] = [
      { type: 'resync' },
      { type: 'typing', channel_id: 'ch-1', user_id: 'u1', username: '小明' },
      { type: 'read', channel_id: 'ch-1', user_id: 'u1', message_id: 3 },
      { type: 'appearance' },
      { type: 'message', channel_id: 'ch-1', message: { id: 1 } as never },
    ];
    for (const ev of events) {
      const r = applyChatGenerationEvent(EMPTY_CHAT_GENERATION_STATE, ev, 0);
      expect(r.accepted).toBe(false);
      expect(r.state).toBe(EMPTY_CHAT_GENERATION_STATE);
    }
  });
});