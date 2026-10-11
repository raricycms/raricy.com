// @vitest-environment jsdom
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import BlogTimestamps from '@/app/components/BlogTimestamps';

function render(createdAt: Date | string | null, updatedAt: Date | string | null, detail = false) {
  const root = document.createElement('div');
  root.innerHTML = renderToStaticMarkup(createElement(BlogTimestamps, { createdAt, updatedAt, detail }));
  return root;
}

const PUBLISHED = '2026-10-01T23:58:00.000Z';
const UPDATED = '2026-10-02T00:03:00.000Z';

describe('文章时间展示', () => {
  it('首次发布只显示一项；历史更新早于发布也不显示为后续更新', () => {
    for (const updated of [PUBLISHED, '2026-09-30T12:00:00.000Z', null]) {
      const root = render(PUBLISHED, updated);
      expect(root.querySelectorAll('time')).toHaveLength(1);
      expect(root.textContent).toContain('发布于2026-10-01');
      expect(root.textContent).not.toContain('更新于');
    }
  });

  it('详情按北京时间显示到分钟，机器读到正确的 +08:00 瞬间', () => {
    const root = render(new Date(PUBLISHED), new Date(UPDATED), true);
    const times = root.querySelectorAll('time');
    expect(times[0].textContent).toBe('2026-10-01 23:58');
    expect(times[1].textContent).toBe('2026-10-02 00:03');
    expect(times[1].dateTime).toBe('2026-10-02T00:03:00.000+08:00');
    expect(times[1].title).toContain('北京时间');
  });

  it('列表与客户端个人主页显示日期，提示保留完整时间；同日编辑也显示更新', () => {
    const root = render(PUBLISHED, '2026-10-01T23:59:00.000Z');
    const times = root.querySelectorAll('time');
    expect(times).toHaveLength(2);
    expect(times[1].textContent).toBe('2026-10-01');
    expect(times[1].title).toContain('2026-10-01 23:59:00');
  });

  it('历史缺少发布时间仍可显示更新时间；全空或非法时间不留空壳', () => {
    expect(render(null, UPDATED).textContent).toBe('更新于2026-10-02');
    expect(render(null, null).innerHTML).toBe('');
    expect(render('invalid', 'invalid').innerHTML).toBe('');
  });
});
