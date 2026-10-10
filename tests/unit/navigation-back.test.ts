// ─────────────────────────────────────────────────────────────────────────────
// navigation-back.test.ts —— 「返回上页」落点判据的回归
//
// 盯住的是一个**只在 iOS A2HS 冷启时现形、且不报错**的失效：标签页里没有上一页时
// `history.back()` 是空操作，按钮变成死键。判据抽成纯函数后在这里钉死每条分支。
// ─────────────────────────────────────────────────────────────────────────────

import { describe, expect, it } from 'vitest';
import {
  BACK_FALLBACK_CORE,
  BACK_FALLBACK_GUEST,
  decideBackTarget,
} from '../../src/lib/navigation-back';

describe('decideBackTarget', () => {
  it('有站内上一页（length > 1）时原样 back，core 与否都不改落点', () => {
    expect(decideBackTarget({ historyLength: 2, isCore: true })).toEqual({
      kind: 'history-back',
    });
    expect(decideBackTarget({ historyLength: 5, isCore: false })).toEqual({
      kind: 'history-back',
    });
  });

  it('没有上一页（length === 1）时 core 落 /blog', () => {
    expect(decideBackTarget({ historyLength: 1, isCore: true })).toEqual({
      kind: 'navigate',
      href: BACK_FALLBACK_CORE,
    });
  });

  it('没有上一页时非 core 落 /explore', () => {
    expect(decideBackTarget({ historyLength: 1, isCore: false })).toEqual({
      kind: 'navigate',
      href: BACK_FALLBACK_GUEST,
    });
  });

  it('length 异常地小（0 / 负数）也走兜底，不让按钮变成死键', () => {
    expect(decideBackTarget({ historyLength: 0, isCore: true })).toEqual({
      kind: 'navigate',
      href: BACK_FALLBACK_CORE,
    });
    expect(decideBackTarget({ historyLength: -1, isCore: true }).kind).toBe('navigate');
  });

  it('两个兜底落点互不相同，且都是站内绝对路径', () => {
    expect(BACK_FALLBACK_CORE).not.toBe(BACK_FALLBACK_GUEST);
    for (const href of [BACK_FALLBACK_CORE, BACK_FALLBACK_GUEST]) {
      expect(href.startsWith('/')).toBe(true);
    }
  });
});
