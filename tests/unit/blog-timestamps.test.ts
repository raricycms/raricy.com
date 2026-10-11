// @vitest-environment jsdom
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import BlogTimestamps from '@/app/components/BlogTimestamps';

function render(createdAt: Date | string | null, updatedAt: Date | string | null, detail = false, sort: 'created' | 'updated' = 'created') {
  const root = document.createElement('div');
  root.innerHTML = renderToStaticMarkup(createElement(BlogTimestamps, { createdAt, updatedAt, detail, sort }));
  return root;
}

const PUBLISHED = '2026-10-01T23:58:00.000Z';
const UPDATED = '2026-10-02T00:03:00.000Z';

describe('文章时间展示', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-11T12:00:00.000Z'));
  });
  afterEach(() => vi.useRealTimers());

  it('首次发布只显示一项；历史更新早于发布也不显示为后续更新', () => {
    for (const updated of [PUBLISHED, '2026-09-30T12:00:00.000Z', null]) {
      const root = render(PUBLISHED, updated);
      expect(root.querySelectorAll('time')).toHaveLength(1);
      expect(root.textContent).toBe('10月1日');
      expect(root.querySelector('time')?.getAttribute('aria-label')).toContain('发布于2026-10-01');
      expect(root.textContent).not.toContain('更新于');
    }
  });

  it('详情默认显示日期，折叠面板保留北京时间的完整秒数和正确瞬间', () => {
    const root = render(new Date(PUBLISHED), new Date(UPDATED), true);
    expect(root.querySelector('details')?.open).toBe(false);
    expect(root.querySelector('summary time')?.textContent).toBe('2026-10-01');
    const times = root.querySelectorAll<HTMLTimeElement>('.blog-timestamps__panel time');
    expect(times[0].textContent).toBe('2026-10-01 23:58:00');
    expect(times[1].textContent).toBe('2026-10-02 00:03:00');
    expect(times[1].dateTime).toBe('2026-10-02T00:03:00.000+08:00');
    expect(times[1].title).toContain('北京时间');
  });

  it('同日编辑只露一份日期和已编辑提示，即使在同一分钟内也不丢失更新事实', () => {
    for (const updated of ['2026-10-01T23:59:00.000Z', '2026-10-01T23:58:00.500Z']) {
      const root = render(PUBLISHED, updated, true);
      expect(root.querySelectorAll('summary time')).toHaveLength(1);
      expect(root.querySelector('summary')?.textContent).toBe('发布于2026-10-01已编辑');
      expect(root.querySelector('.blog-timestamps__item--secondary')?.getAttribute('title')).toContain(updated.slice(0, 19).replace('T', ' '));
    }
  });

  it('跨日编辑的列表只保留与排序对应的日期，完整发布和更新时间都在提示里', () => {
    const published = render(PUBLISHED, UPDATED);
    expect(published.textContent).toBe('10月1日');
    expect(published.querySelectorAll('time')).toHaveLength(1);
    const root = render(PUBLISHED, UPDATED, false, 'updated');
    const times = root.querySelectorAll('time');
    expect(times).toHaveLength(1);
    expect(root.textContent).toBe('10月2日');
    expect(times[0].title).toContain('发布时间：2026-10-01 23:58:00');
    expect(times[0].title).toContain('更新时间：2026-10-02 00:03:00');
    expect(times[0].dateTime).toBe('2026-10-02T00:03:00.000+08:00');
    expect(times[0].getAttribute('aria-label')).toContain('更新于2026-10-02');
  });

  it('同日按更新排序时只显示更新日期；尚未编辑的文章仍标明发布', () => {
    const root = render(PUBLISHED, '2026-10-01T23:59:00.000Z');
    expect(root.querySelector('time')?.title).toContain('2026-10-01 23:58:00');
    const sorted = render(PUBLISHED, '2026-10-01T23:59:00.000Z', false, 'updated');
    expect(sorted.querySelectorAll('time')).toHaveLength(1);
    expect(sorted.textContent).toBe('10月1日');
    expect(sorted.querySelector('time')?.title).toContain('2026-10-01 23:59:00');
    expect(render(PUBLISHED, PUBLISHED, false, 'updated').querySelector('time')?.getAttribute('aria-label')).toContain('发布于2026-10-01');
  });

  it('跨年日期带年份，今年以北京时间判定而非真实 UTC 年份', () => {
    vi.setSystemTime(new Date('2026-12-31T16:05:00.000Z'));
    expect(render(PUBLISHED, null).textContent).toBe('2026年10月1日');
    expect(render('2027-01-01T00:03:00.000Z', null).textContent).toBe('1月1日');
  });

  it('历史缺少发布时间仍可显示更新时间；全空或非法时间不留空壳', () => {
    expect(render(null, UPDATED).textContent).toBe('10月2日');
    expect(render(null, UPDATED).querySelector('time')?.getAttribute('aria-label')).toContain('更新于2026-10-02');
    expect(render(null, null).innerHTML).toBe('');
    expect(render('invalid', 'invalid').innerHTML).toBe('');
  });
});
