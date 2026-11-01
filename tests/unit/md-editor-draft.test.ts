// @vitest-environment jsdom
// ─────────────────────────────────────────────────────────────────────────────
// md-editor-draft.test.ts —— 本地草稿的三条容易写错的时序
//
// 【为什么这三条值得单独测】草稿的失败模式全是**时序**，而且全都不报错：
//   · 发布成功后先删键、后停定时器 → 延迟回调把刚发布的正文写回来，
//     用户下次进新建页看到一篇已经发出去的文章，会以为服务端丢了数据；
//   · 只在 unmount 里落盘 → 直接关标签页时 unmount 不一定跑，最后一段输入丢；
//   · localStorage 抛异常时若让它逃出去 → 编辑器整个初始化失败，
//     「写不了草稿」被放大成「用不了编辑器」。
// 这三条都只有靠假定时器 + 真实的调用顺序才验得出来。
// ─────────────────────────────────────────────────────────────────────────────

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createDraftStore,
  draftMetaKey,
  encodeDraftMeta,
  encodeDraftValue,
  parseDraftValue,
} from '@/lib/md-editor/draft';

const KEY = 'test-draft-key';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  window.localStorage.removeItem(KEY);
  window.localStorage.removeItem(draftMetaKey(KEY));
});

describe('读写', () => {
  it('没有草稿时读回 null', () => {
    const store = createDraftStore(KEY, { debounceMs: 5 });
    expect(store.read()).toEqual({ ok: true, value: null, format: 'markdown', syntaxVersion: null });
    store.dispose();
  });

  it('排程后到点才落盘（防抖）', async () => {
    vi.useFakeTimers();
    const store = createDraftStore(KEY, { debounceMs: 500 });
    store.schedule('第一版');
    expect(window.localStorage.getItem(KEY)).toBeNull();
    vi.advanceTimersByTime(499);
    expect(window.localStorage.getItem(KEY)).toBeNull();
    vi.advanceTimersByTime(1);
    expect(window.localStorage.getItem(KEY)).toBe('第一版');
    store.dispose();
  });

  it('连续排程只落最后一份', () => {
    vi.useFakeTimers();
    const store = createDraftStore(KEY, { debounceMs: 500 });
    store.schedule('a');
    vi.advanceTimersByTime(300);
    store.schedule('b');
    vi.advanceTimersByTime(300);
    store.schedule('c');
    vi.advanceTimersByTime(500);
    expect(window.localStorage.getItem(KEY)).toBe('c');
    store.dispose();
  });

  it('flush 立刻落盘（提交前 / 离页时用）', () => {
    vi.useFakeTimers();
    const store = createDraftStore(KEY, { debounceMs: 500 });
    store.schedule('马上要跳走了');
    store.flush();
    expect(window.localStorage.getItem(KEY)).toBe('马上要跳走了');
    store.dispose();
  });
});

describe('成功发布后清草稿', () => {
  it('clear 之后那个待写的定时器不会再把它写回来', () => {
    vi.useFakeTimers();
    const store = createDraftStore(KEY, { debounceMs: 500 });
    store.schedule('刚发布出去的正文');
    // 发布成功：清草稿 —— 此刻定时器还挂着
    store.clear();
    expect(window.localStorage.getItem(KEY)).toBeNull();
    // 关键：让时间走过去。顺序写反的实现会在这里把正文写回来。
    vi.advanceTimersByTime(5000);
    expect(window.localStorage.getItem(KEY)).toBeNull();
    store.dispose();
  });

  it('clear 之后接着写仍会攒新草稿（不是"从此不再存"）', () => {
    vi.useFakeTimers();
    const store = createDraftStore(KEY, { debounceMs: 500 });
    store.schedule('第一版');
    store.clear();
    // 剪贴板新建页按 Ctrl+S 保存后并不离开页面，用户接着写下一段
    store.schedule('第二版');
    vi.advanceTimersByTime(500);
    expect(window.localStorage.getItem(KEY)).toBe('第二版');
    store.dispose();
  });

  it('stop 之后不再写（页面马上要跳走的那种）', () => {
    vi.useFakeTimers();
    const store = createDraftStore(KEY, { debounceMs: 500 });
    store.stop();
    store.schedule('不该出现');
    vi.advanceTimersByTime(5000);
    expect(window.localStorage.getItem(KEY)).toBeNull();
    store.dispose();
  });
});

describe('离页兜底', () => {
  it('pagehide 把待写的一份落下', () => {
    vi.useFakeTimers();
    const store = createDraftStore(KEY, { debounceMs: 60000 });
    store.schedule('关标签页前最后打的字');
    window.dispatchEvent(new Event('pagehide'));
    expect(window.localStorage.getItem(KEY)).toBe('关标签页前最后打的字');
    store.dispose();
  });

  it('dispose 之后不再响应离页（避免卸载后还写）', () => {
    vi.useFakeTimers();
    const store = createDraftStore(KEY, { debounceMs: 60000 });
    store.dispose();
    store.schedule('卸载之后的内容');
    window.dispatchEvent(new Event('pagehide'));
    expect(window.localStorage.getItem(KEY)).toBeNull();
  });
});

describe('组件卸载（站内换页根本不发 pagehide）', () => {
  // ★ 这一条不是 pagehide 的重复：站内换页是**客户端跳转**，整条路径上一次
  // pagehide 都不会发，只有 React 卸载。而卸载时挂起的恰好是最后 500ms 内敲的字
  // —— 只清定时器就等于把它丢掉，用户视角是「刚打完一句就点了别处，回来少一句」，
  // 页面上没有任何提示。
  it('dispose 把待写的一份落下（不是只清定时器）', () => {
    vi.useFakeTimers();
    const store = createDraftStore(KEY, { debounceMs: 60000 });
    store.schedule('刚打完就点了别处');
    store.dispose();
    expect(window.localStorage.getItem(KEY)).toBe('刚打完就点了别处');
  });

  it('flush 之后再 dispose 不会写第二遍（落盘的是最后一份）', () => {
    vi.useFakeTimers();
    const store = createDraftStore(KEY, { debounceMs: 60000 });
    store.schedule('第一版');
    store.flush();
    store.schedule('第二版');
    store.flush();
    store.dispose();
    expect(window.localStorage.getItem(KEY)).toBe('第二版');
  });

  // ★ 发布成功的顺序是 clear() → 组件卸载。clear() 已经把 pending 置空，所以
  // dispose 里的 flush 必须什么都不写 —— 否则「发布成功 → 跳走 → 卸载」这条最普通的
  // 路径会把刚发出去的正文重新写回 localStorage，用户下次进新建页看到一篇已发布的旧文。
  it('clear 之后 dispose 不会把刚发布的那一份写回来', () => {
    vi.useFakeTimers();
    const store = createDraftStore(KEY, { debounceMs: 60000 });
    store.schedule('刚发布出去的正文');
    store.clear();
    store.dispose();
    vi.advanceTimersByTime(60000);
    expect(window.localStorage.getItem(KEY)).toBeNull();
  });
});

describe('草稿格式：主键永远是原文，格式走旁路元数据', () => {
  /** 只读主键的老阅读器：不是历史信封就原样当 Markdown。 */
  function readLikeOldReader(): { format: string; text: string } | null {
    const raw = window.localStorage.getItem(KEY);
    if (raw === null) return null;
    const legacy = parseDraftValue(raw);
    return legacy ? { format: legacy.format, text: legacy.text } : { format: 'markdown', text: raw };
  }

  it('裸正文（Vditor 时代的老草稿）恢复成 markdown', () => {
    vi.useFakeTimers();
    window.localStorage.setItem(KEY, '# 旧草稿');
    const store = createDraftStore(KEY);
    expect(store.read()).toEqual({
      ok: true,
      value: '# 旧草稿',
      format: 'markdown',
      syntaxVersion: null,
    });
    store.dispose();
  });

  it('★ 看起来像 JSON 的旧正文也不猜成 reactive ★', () => {
    const old = '{"format":"reactive","text":"这是正文"}';
    window.localStorage.setItem(KEY, old);
    const store = createDraftStore(KEY);
    expect(store.read()).toEqual({
      ok: true,
      value: old,
      format: 'markdown',
      syntaxVersion: null,
    });
    store.dispose();
  });

  it('坏掉的历史信封不丢正文，仍按 markdown 恢复', () => {
    const broken = 'raricy-md-draft:v1:{not json';
    window.localStorage.setItem(KEY, broken);
    const store = createDraftStore(KEY);
    expect(store.read()).toEqual({
      ok: true,
      value: broken,
      format: 'markdown',
      syntaxVersion: null,
    });
    store.dispose();
  });

  it('reactive 草稿：主键是原文，格式/版本在旁路元数据里', () => {
    vi.useFakeTimers();
    const store = createDraftStore(KEY, { debounceMs: 500 });
    store.schedule({
      format: 'reactive',
      text: '人数：{{ people }}',
      syntaxVersion: 'local-draft-3',
    });
    vi.advanceTimersByTime(500);

    // ★ 旧阅读器 / 回滚后的旧构建只读主键：看到的是原文，不是 JSON 信封 ★
    expect(window.localStorage.getItem(KEY)).toBe('人数：{{ people }}');
    expect(readLikeOldReader()).toEqual({
      format: 'markdown',
      text: '人数：{{ people }}',
    });
    expect(JSON.parse(window.localStorage.getItem(draftMetaKey(KEY))!)).toMatchObject({
      format: 'reactive',
      syntaxVersion: 'local-draft-3',
    });
    expect(store.read()).toEqual({
      ok: true,
      value: '人数：{{ people }}',
      format: 'reactive',
      syntaxVersion: 'local-draft-3',
    });
    store.dispose();
  });

  it('markdown 落盘形态一个字都没变，也不留元数据', () => {
    vi.useFakeTimers();
    const store = createDraftStore(KEY, { debounceMs: 500 });
    store.schedule('普通正文');
    vi.advanceTimersByTime(500);
    expect(window.localStorage.getItem(KEY)).toBe('普通正文');
    expect(window.localStorage.getItem(draftMetaKey(KEY))).toBeNull();
    expect(encodeDraftValue({ format: 'markdown', text: '普通正文', syntaxVersion: null })).toBe(
      '普通正文'
    );
    store.dispose();
  });

  it('旧阅读器只改主键 → 指纹不匹配，元数据作废、按 markdown 恢复', () => {
    vi.useFakeTimers();
    const store = createDraftStore(KEY, { debounceMs: 500 });
    store.schedule({ format: 'reactive', text: '原正文', syntaxVersion: 'local-draft-3' });
    vi.advanceTimersByTime(500);

    // 模拟回滚后的旧构建 / 旧标签页：只写主键（它不认 meta）。
    window.localStorage.setItem(KEY, '旧构建改写的正文');
    expect(store.read()).toEqual({
      ok: true,
      value: '旧构建改写的正文',
      format: 'markdown',
      syntaxVersion: null,
    });
    store.dispose();
  });

  it('从 reactive 改回 markdown 时清掉旧元数据', () => {
    vi.useFakeTimers();
    const store = createDraftStore(KEY, { debounceMs: 500 });
    store.schedule({ format: 'reactive', text: '正文', syntaxVersion: 'local-draft-3' });
    vi.advanceTimersByTime(500);
    expect(window.localStorage.getItem(draftMetaKey(KEY))).not.toBeNull();

    store.schedule({ format: 'markdown', text: '正文', syntaxVersion: null });
    vi.advanceTimersByTime(500);
    expect(window.localStorage.getItem(draftMetaKey(KEY))).toBeNull();
    expect(store.read()).toMatchObject({ format: 'markdown', syntaxVersion: null });
    store.dispose();
  });

  it('v1 信封继续读：没有版本字段的旧 reactive 草稿按 null 恢复', () => {
    const v1 = 'raricy-md-draft:v1:' + JSON.stringify({ format: 'reactive', text: '旧正文' });
    expect(parseDraftValue(v1)).toEqual({
      format: 'reactive',
      text: '旧正文',
      syntaxVersion: null,
    });
  });

  it('v2 信封连语法版本一起恢复（升级前写下的那些）', () => {
    const v2 =
      'raricy-md-draft:v2:' +
      JSON.stringify({ format: 'reactive', text: '新正文', syntaxVersion: 'local-draft-3' });
    expect(parseDraftValue(v2)).toEqual({
      format: 'reactive',
      text: '新正文',
      syntaxVersion: 'local-draft-3',
    });
  });

  it('新 writer 的 reactive 结果也能被「只认历史信封」的解析器按原文读回', () => {
    const entry = { format: 'reactive' as const, text: '正文', syntaxVersion: 'local-draft-3' };
    expect(encodeDraftValue(entry)).toBe('正文');
    expect(parseDraftValue(encodeDraftValue(entry))).toBeNull();
    expect(encodeDraftMeta(entry)).toContain('"format":"reactive"');
  });
});

describe('localStorage 不可用', () => {  it('写失败时不抛出去，只回调一次', () => {
    vi.useFakeTimers();
    const onUnavailable = vi.fn();
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    const store = createDraftStore(KEY, { debounceMs: 500, onUnavailable });

    expect(() => {
      store.schedule('a');
      vi.advanceTimersByTime(500);
      store.schedule('b');
      vi.advanceTimersByTime(500);
    }).not.toThrow();
    // 只提示一次 —— 每敲一个字弹一次提示比不存草稿还烦
    expect(onUnavailable).toHaveBeenCalledTimes(1);
    store.dispose();
  });

  it('读失败时返回 ok:false 而不是抛', () => {
    const onUnavailable = vi.fn();
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    const store = createDraftStore(KEY, { onUnavailable });
    expect(store.read()).toEqual({ ok: false });
    expect(onUnavailable).toHaveBeenCalledTimes(1);
    store.dispose();
  });
});
