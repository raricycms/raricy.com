// @vitest-environment jsdom
//
// lib/scroll-lock —— 被每日一言、正文配图放大、博客目录个人面板、积木墙详情层、
// 阅读器全屏与跨站提示六处共用。它的两个约定值得钉住：释放幂等、可嵌套。
// 模块里存着锁计数，所以每个用例都重新 import 一份，避免前后用例互相影响。
import { beforeEach, describe, expect, it, vi } from 'vitest';

async function freshLockPageScroll() {
  vi.resetModules();
  return (await import('@/lib/scroll-lock')).lockPageScroll;
}

describe('lockPageScroll', () => {
  beforeEach(() => {
    document.body.style.overflow = '';
  });

  it('锁住时写 hidden，释放后还原原来的值', async () => {
    const lockPageScroll = await freshLockPageScroll();
    document.body.style.overflow = 'scroll';

    const release = lockPageScroll();
    expect(document.body.style.overflow).toBe('hidden');

    release();
    expect(document.body.style.overflow, '释放要还原成锁之前的值，不是清空').toBe('scroll');
  });

  it('释放函数幂等：同一层重复释放不会把别的层一起放开', async () => {
    const lockPageScroll = await freshLockPageScroll();
    const outer = lockPageScroll();
    const inner = lockPageScroll();

    outer();
    outer(); // 双击关闭 / cleanup 再跑一次：不能把计数减两次
    expect(document.body.style.overflow, '内层还锁着，页面必须仍然禁止滚动').toBe('hidden');

    inner();
    expect(document.body.style.overflow).toBe('');
  });

  it('可嵌套：释放顺序与打开顺序无关，最后一个释放才还原', async () => {
    const lockPageScroll = await freshLockPageScroll();
    document.body.style.overflow = 'auto';

    const outer = lockPageScroll();
    const inner = lockPageScroll();

    inner();
    expect(document.body.style.overflow).toBe('hidden');

    outer();
    expect(document.body.style.overflow).toBe('auto');
  });
});
