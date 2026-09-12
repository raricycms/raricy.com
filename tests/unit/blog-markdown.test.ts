// @vitest-environment jsdom
// ─────────────────────────────────────────────────────────────────────────────
// blog-markdown.test.ts —— 博客 / 剪贴板正文渲染的安全边界
//
// 【回归用例 · 已复现的存储型 XSS】data-vote-id 属性逃逸：
//   <div class="vote-embed" data-vote-id='x"><img src=x onerror=alert(1)>'>
// DOMPurify 只净化 HTML 结构，会**保留**这个属性值；旧实现随后把它拼进
// `el.innerHTML = \`<a href="/vote/${vid}">...\`` —— getAttribute 取回的原文
// 重新解析就变成可执行的 <img onerror>。
// 这里按真实路径走一遍：净化 → getAttribute → 校验 / renderVoteFallback → 断言 DOM。
// 断言一律落在解析后的结构上，不看字符串（字符串比对会被转义形式骗过去）。
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from 'vitest';
import DOMPurify from 'dompurify';
import { BLOG_SANITIZE_OPTIONS, isValidVoteId, renderVoteFallback } from '@/lib/blog-markdown';

/** 净化 + 挂载，便于按 DOM 结构断言。 */
function mount(dirty: string): HTMLElement {
  const root = document.createElement('div');
  root.innerHTML = DOMPurify.sanitize(dirty, BLOG_SANITIZE_OPTIONS);
  return root;
}

/** 收集带 on* 事件属性的元素（转义成文本的「属性」不算 —— 那只是字符，不会绑定）。 */
function elementsWithEventAttrs(root: HTMLElement): string[] {
  const bad: string[] = [];
  root.querySelectorAll('*').forEach((el) => {
    for (const attr of Array.from(el.attributes)) {
      if (/^on/i.test(attr.name)) bad.push(`${el.tagName}[${attr.name}]`);
    }
  });
  return bad;
}

const ATTACK = `<div class="vote-embed" data-vote-id='x"><img src=x onerror=window.__pwn=1>'>正文</div>`;

describe('投票 id 校验', () => {
  it('放行真实形态的短 id', () => {
    expect(isValidVoteId('abcdef12')).toBe(true);
    expect(isValidVoteId('a1b2c3d4e')).toBe(true);
    expect(isValidVoteId('AbC123')).toBe(true);
  });

  it('拒绝属性逃逸 / 路径 / 空白 / 空值', () => {
    expect(isValidVoteId(`x"><img src=x onerror=alert(1)>`)).toBe(false);
    expect(isValidVoteId('../../etc/passwd')).toBe(false);
    expect(isValidVoteId('a b')).toBe(false);
    expect(isValidVoteId('a/b')).toBe(false);
    expect(isValidVoteId('')).toBe(false);
    expect(isValidVoteId(null)).toBe(false);
    expect(isValidVoteId(undefined)).toBe(false);
    expect(isValidVoteId('a'.repeat(33))).toBe(false);
  });
});

describe('兜底链接的写入方式', () => {
  it('用 DOM API 写入：只产生一个 <a>，无子元素、无 on*', () => {
    const el = document.createElement('div');
    renderVoteFallback(el, 'abc12345');
    const a = el.querySelector('a');
    expect(a).not.toBeNull();
    expect(a!.getAttribute('href')).toBe('/vote/abc12345');
    expect(a!.textContent).toBe('[查看投票]');
    expect(el.children).toHaveLength(1);
    expect(elementsWithEventAttrs(el)).toEqual([]);
  });

  it('即便传入逃逸 payload 也只当文本，不解析成标签', () => {
    const el = document.createElement('div');
    renderVoteFallback(el, `x"><img src=x onerror=alert(1)>`);
    expect(el.querySelector('img')).toBeNull();
    expect(elementsWithEventAttrs(el)).toEqual([]);
    // href 是一个（无害的）字符串，而不是被拆出去的属性
    expect(el.querySelector('a')!.getAttribute('href')).toContain('x"><img');
  });
});

describe('data-vote-id 逃逸回归（存储型 XSS）', () => {
  it('净化后属性值仍可被 getAttribute 取回 —— 这正是当初能逃逸的原因', () => {
    const el = mount(ATTACK).querySelector<HTMLElement>('.vote-embed[data-vote-id]');
    expect(el).not.toBeNull();
    const vid = el!.getAttribute('data-vote-id')!;
    expect(vid).toContain('<img');
    // 渲染前的第一道闸门必须拦下它
    expect(isValidVoteId(vid)).toBe(false);
  });

  it('净化本身剥掉 on* 与白名单外的 data-*', () => {
    const root = mount(
      `<div class="vote-embed" data-vote-id="abc" data-other="x"><img src=x onerror=alert(1)></div>`
    );
    expect(elementsWithEventAttrs(root)).toEqual([]);
    expect(root.querySelector('[data-other]')).toBeNull();
    // 白名单内的两个 data-* 仍保留
    expect(root.querySelector('.vote-embed')!.getAttribute('data-vote-id')).toBe('abc');
  });

  it('正常投票嵌入没被误伤：class 与 data-vote-id 都保留', () => {
    const el = mount(`<div class="vote-embed" data-vote-id="abcdef12"></div>`).querySelector<HTMLElement>(
      '.vote-embed[data-vote-id]'
    );
    expect(el).not.toBeNull();
    expect(el!.getAttribute('data-vote-id')).toBe('abcdef12');
    expect(el!.classList.contains('vote-embed')).toBe(true);
  });

  it('代码块复制按钮的 data-code 没被误伤', () => {
    const btn = mount('<button data-code="abc" data-other="x">复制</button>').querySelector('button');
    expect(btn!.getAttribute('data-code')).toBe('abc');
    expect(btn!.hasAttribute('data-other')).toBe(false);
  });
});
