// @vitest-environment jsdom
// ─────────────────────────────────────────────────────────────────────────────
// chat-grouping.test.ts —— 讨论区「同人连续发言合并表头」的判据
//
// 【被测的是什么】markGroupedMessages（src/app/chat/ChatMessageItem.tsx）按列表顺序
// 标出哪些消息省略表头（时间 / 用户名 / 头像）。它是**纯函数**，所以这里只喂消息数组、
// 只断言布尔数组；屏幕上长什么样（哪个元素被隐藏）由 _chat.scss 的
// `.chat-msg--grouped` 承担。
//
// 【这一条为什么值得单测】判据是「距**这一串的第一条** ≤ 5 分钟」，不是「距上一条」
// —— 两者在「每 4 分钟发一条」时结论相反（前者断开、后者无限并下去），而**看屏幕
// 看不出来**：两种实现下前面几条长得一模一样，差异要等到第 3 条才出现。同理，拍一拍
// 的「两侧都不并进来」、跨自然日断开、时间戳读不出来时不并，这三条也都是静默的。
//
// 【时间戳口径】库内是「UTC+8 墙上时间贴 Z 标签」（见 src/lib/db-time.ts），
// 所以下面一律写 `...T10:00:00.000Z` 这种钟面串，比较就在钟面空间里做，与真实 UTC
// 无关 —— 用例也别去碰时区。
// ─────────────────────────────────────────────────────────────────────────────

import { describe, expect, it } from 'vitest';
import { CHAT_GROUP_WINDOW_MS, markGroupedMessages } from '@/app/chat/ChatMessageItem';
import type { ChatMessageDTO } from '@/lib/chat-shared';

/** 造一条消息：只填判据用得上的字段，其余给空值。 */
function msg(
  id: number,
  author: string,
  at: string | null,
  opts: { pat?: boolean } = {}
): ChatMessageDTO {
  return {
    id,
    channel_id: 'lobby',
    author: { id: author, username: author, avatar_url: '', frame_url: null, is_admin: false },
    content: `m${id}`,
    image: null,
    image_missing: false,
    blog: null,
    blog_missing: false,
    pat: opts.pat ? { target_id: 'someone', target_name: '某人' } : null,
    reply: null,
    is_deleted: false,
    created_at: at,
  };
}

/** 同一天里的钟面时刻串。 */
const t = (h: number, m: number) =>
  `2026-09-22T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00.000Z`;

/** 断言等长（渲染层按下标取用 groupedFlags[i]，长度错了会静默错位）。 */
function expectFlags(messages: ChatMessageDTO[], expected: boolean[]) {
  const flags = markGroupedMessages(messages);
  expect(flags).toHaveLength(messages.length);
  expect(flags).toEqual(expected);
}

describe('markGroupedMessages', () => {
  it('空列表 → 空数组；单条 → 首条照常画表头', () => {
    expect(markGroupedMessages([])).toEqual([]);
    expectFlags([msg(1, 'A', t(10, 0))], [false]);
  });

  it('同人接连发言 → 串首画表头，后续省略', () => {
    expectFlags(
      [msg(1, 'A', t(10, 0)), msg(2, 'A', t(10, 1)), msg(3, 'A', t(10, 2))],
      [false, true, true]
    );
  });

  it('窗口锚在串首：一串总长超过 5 分钟就断开，那条自己开新串', () => {
    // 0 / 4 / 8 分钟 —— 「与上一条比较」会把 8 分钟那条也并进去（距上一条才 4 分钟）
    expectFlags(
      [msg(1, 'A', t(10, 0)), msg(2, 'A', t(10, 4)), msg(3, 'A', t(10, 8))],
      [false, true, false]
    );
    // 断开的那条成为新串首：紧跟其后的又并进来
    expectFlags(
      [msg(1, 'A', t(10, 0)), msg(2, 'A', t(10, 4)), msg(3, 'A', t(10, 8)), msg(4, 'A', t(10, 9))],
      [false, true, false, true]
    );
    // 窗口恰好是 5 分钟（含端点），6 分钟则断开
    expectFlags([msg(1, 'A', t(10, 0)), msg(2, 'A', t(10, 5))], [false, true]);
    expectFlags([msg(1, 'A', t(10, 0)), msg(2, 'A', t(10, 6))], [false, false]);
    expect(CHAT_GROUP_WINDOW_MS).toBe(5 * 60_000);
  });

  it('换人插话 → 两边都断开（插话者与回到发言的人都画表头）', () => {
    expectFlags(
      [msg(1, 'A', t(10, 0)), msg(2, 'B', t(10, 1)), msg(3, 'A', t(10, 2))],
      [false, false, false]
    );
    // B 接着又说一句 → B 自己的串照样合并
    expectFlags(
      [msg(1, 'A', t(10, 0)), msg(2, 'B', t(10, 1)), msg(3, 'B', t(10, 2))],
      [false, false, true]
    );
  });

  it('拍一拍：自己不做后继，也不做串首（前后两条都画表头）', () => {
    const pat = msg(2, 'A', t(10, 1), { pat: true });
    expectFlags([msg(1, 'A', t(10, 0)), pat, msg(3, 'A', t(10, 2))], [false, false, false]);
    // 拍一拍后面那条是新串首：再往后又并起来
    expectFlags(
      [msg(1, 'A', t(10, 0)), pat, msg(3, 'A', t(10, 2)), msg(4, 'A', t(10, 3))],
      [false, false, false, true]
    );
  });

  it('跨自然日 → 断开（日期分隔线插在两条之间，表头必须跟着出现）', () => {
    expectFlags(
      [
        msg(1, 'A', '2026-09-22T23:59:00.000Z'),
        msg(2, 'A', '2026-09-23T00:01:00.000Z'),
      ],
      [false, false]
    );
  });

  it('时间戳缺失 / 不可解析 → 不并（读不出间隔就不合并），且从它起另起一串', () => {
    // 前一条没有时间戳：后一条的无从判断，照常画表头
    expectFlags([msg(1, 'A', null), msg(2, 'A', t(10, 0))], [false, false]);
    // 中间一条坏掉：它自己画表头，其后那条也不能跨过它去并
    expectFlags(
      [msg(1, 'A', t(10, 0)), msg(2, 'A', '不是时间'), msg(3, 'A', t(10, 1))],
      [false, false, false]
    );
    // 再往后恢复：坏掉的那条之后，新的串从 10:01 起算
    expectFlags(
      [
        msg(1, 'A', t(10, 0)),
        msg(2, 'A', '不是时间'),
        msg(3, 'A', t(10, 1)),
        msg(4, 'A', t(10, 2)),
      ],
      [false, false, false, true]
    );
  });

  it('已删除的消息照常参与合并（占位泡也是这一串里的一条）', () => {
    const deleted = { ...msg(2, 'A', t(10, 1)), is_deleted: true, content: '[该消息已删除]' };
    expectFlags([msg(1, 'A', t(10, 0)), deleted], [false, true]);
  });
});
