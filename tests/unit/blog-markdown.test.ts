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

import { describe, it, expect, vi, afterEach } from 'vitest';
import DOMPurify from 'dompurify';
import {
  BLOG_SANITIZE_OPTIONS,
  isValidVoteId,
  renderVoteFallback,
  buildVoteWidget,
  renderVoteEmbed,
  type VoteEmbedData,
} from '@/lib/blog-markdown';

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

// ─────────────────────────────────────────────────────────────────────────────
// 投票小组件结构
//
// 【回归用例】这里曾经只渲染「结果行」：没有标题、没有投票入口、没有详情页链接，
// 且最外层少了 .vote-embed-widget —— 而卡片背景 / 边框 / 内边距 / 宽度全挂在那个
// 类上。于是博客正文里的投票箱既投不了票又是个裸条 —— 而小组件本应**可投**：
// 未锁定 + 本人未投 → 可选项 + 投票按钮。
//
// 断言落在 DOM 结构上（类名是字符串，拼错既不报错也不让构建失败）。
// ─────────────────────────────────────────────────────────────────────────────

const VOTE_DATA: VoteEmbedData = {
  title: '午饭吃什么',
  is_locked: false,
  total_votes: 3,
  user_voted: null,
  options: [
    { id: 1, label: '面', count: 2, percentage: 66.7 },
    { id: 2, label: '饭', count: 1, percentage: 33.3 },
  ],
};

function widgetOf(data: VoteEmbedData = VOTE_DATA): HTMLElement {
  const el = document.createElement('div');
  buildVoteWidget(el, 'abc12345', data);
  return el;
}

describe('投票小组件结构', () => {
  it('未投票未锁定：标题 + 可选项 + 投票按钮 + 详情链接', () => {
    const el = widgetOf();
    const widget = el.querySelector('.vote-embed-widget');
    expect(widget, '缺少 .vote-embed-widget 外壳 —— 卡片样式全挂在它上面').not.toBeNull();
    expect(el.querySelector('.vote-embed-title')!.textContent).toBe('午饭吃什么');

    expect(el.querySelectorAll('.vote-embed-option')).toHaveLength(2);
    expect(el.querySelector('.vote-embed-option--result'), '可投票时不该出结果行').toBeNull();
    expect(el.querySelector('.vote-embed-total'), '可投票时不该先剧透票数').toBeNull();

    const submit = el.querySelector<HTMLButtonElement>('.vote-embed-submit');
    expect(submit).not.toBeNull();
    expect(submit!.disabled, '没选任何选项时投票按钮应是禁用的').toBe(true);

    const link = el.querySelector<HTMLAnchorElement>('.vote-embed-link');
    expect(link, '缺详情页入口 —— 读者无从查看详情').not.toBeNull();
    expect(link!.getAttribute('href')).toBe('/vote/abc12345');
    expect(link!.getAttribute('target')).toBe('_blank');
    expect(link!.textContent).toBe('查看详情');
  });

  it('已投票：结果视图（共 X 票 / 进度条 / ✓ 高亮），没有投票按钮', () => {
    const el = widgetOf({ ...VOTE_DATA, user_voted: 2, total_votes: 3 });
    expect(el.querySelector('.vote-embed-total')!.textContent).toBe('共 3 票');
    expect(el.querySelectorAll('.vote-embed-option--result')).toHaveLength(2);
    expect(el.querySelector('.vote-embed-submit')).toBeNull();
    // 已投票也保留详情入口
    expect(el.querySelector('.vote-embed-link')).not.toBeNull();

    const voted = el.querySelector('.vote-embed-option--voted')!;
    expect(voted.querySelector('.vote-embed-option-label')!.textContent).toBe('饭');
    expect(voted.querySelector('.vote-embed-option-stats')!.textContent).toBe('1 票 · 33.3%');
    // 进度条宽度取服务端下发的百分比
    expect((voted.querySelector('.vote-embed-bar') as HTMLElement).style.width).toBe('33.3%');
  });

  it('已锁定：徽章 + 结果视图（本人没投过也是结果）', () => {
    const el = widgetOf({ ...VOTE_DATA, is_locked: true });
    expect(el.querySelector('.badge-locked')!.textContent).toBe('已锁定');
    expect(el.querySelector('.vote-embed-total')!.textContent).toBe('共 3 票');
    expect(el.querySelector('.vote-embed-submit')).toBeNull();
    expect(el.querySelector('.vote-embed-option--voted')).toBeNull();
  });

  it('标题 / 选项标签里的 HTML 只当文本（不拼 innerHTML 的回归）', () => {
    const el = widgetOf({
      ...VOTE_DATA,
      title: '<img src=x onerror=window.__pwn=1>',
      options: [{ id: 1, label: '<svg onload=alert(1)>', count: 0, percentage: 0 }],
    });
    expect(el.querySelector('img')).toBeNull();
    expect(el.querySelector('svg')).toBeNull();
    expect(elementsWithEventAttrs(el)).toEqual([]);
    // 原样作为文本保留
    expect(el.querySelector('.vote-embed-title')!.textContent).toBe('<img src=x onerror=window.__pwn=1>');
    expect(el.querySelector('.vote-embed-option-label')!.textContent).toBe('<svg onload=alert(1)>');
  });
});

describe('renderVoteEmbed（拉数据 + 投票交互）', () => {
  afterEach(() => vi.unstubAllGlobals());

  /** data 由 voted 决定：投票后服务端返回票数 +1 的结果。 */
  function stubApi() {
    const calls: string[] = [];
    let voted = false;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? 'GET'} ${url}`);
      if (init?.method === 'POST') {
        voted = true;
        return { json: async () => ({ code: 200, message: '投票成功' }) };
      }
      return {
        json: async () => ({
          code: 200,
          data: voted
            ? {
                ...VOTE_DATA,
                user_voted: 1,
                total_votes: 4,
                options: [
                  { id: 1, label: '面', count: 3, percentage: 75 },
                  { id: 2, label: '饭', count: 1, percentage: 25 },
                ],
              }
            : VOTE_DATA,
        }),
      };
    });
    vi.stubGlobal('fetch', fetchMock);
    return { calls, fetchMock };
  }

  it('非法 id：一次请求都不发，直接标记无效', async () => {
    const { fetchMock } = stubApi();
    const el = document.createElement('div');
    await renderVoteEmbed(el, `x"><img src=x onerror=alert(1)>`);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(el.textContent).toBe('[投票链接无效]');
  });

  it('取不到投票：退化成可点击的兜底链接', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ json: async () => ({ code: 404, message: '投票不存在' }) })));
    const el = document.createElement('div');
    await renderVoteEmbed(el, 'abc12345');
    const a = el.querySelector('a')!;
    expect(a.getAttribute('href')).toBe('/vote/abc12345');
    expect(a.textContent).toBe('[查看投票]');
  });

  it('选中 → 投票 → 按服务端结果重绘（不再有投票按钮）', async () => {
    const { calls, fetchMock } = stubApi();
    const el = document.createElement('div');
    await renderVoteEmbed(el, 'abc12345');

    const opts = Array.from(el.querySelectorAll<HTMLElement>('.vote-embed-option'));
    expect(opts).toHaveLength(2);
    expect(opts[0].classList.contains('vote-embed-option--selected')).toBe(false);

    opts[0].click();
    expect(opts[0].classList.contains('vote-embed-option--selected')).toBe(true);
    const submit = el.querySelector<HTMLButtonElement>('.vote-embed-submit')!;
    expect(submit.disabled).toBe(false);

    submit.click();
    await vi.waitFor(() => expect(el.querySelector('.vote-embed-total')).not.toBeNull());

    // 提交的是选中的那一项，且选完选项后重绘了一遍
    expect(fetchMock.mock.calls[1][0]).toBe('/api/votes/abc12345/vote');
    expect(JSON.parse((fetchMock.mock.calls[1][1] as RequestInit).body as string)).toEqual({ optionId: 1 });
    expect(calls).toEqual([
      'GET /api/votes/abc12345',
      'POST /api/votes/abc12345/vote',
      'GET /api/votes/abc12345',
    ]);

    // 重绘后是结果视图：自己投的那项高亮、票数取服务端
    expect(el.querySelector('.vote-embed-submit')).toBeNull();
    expect(el.querySelector('.vote-embed-option--voted .vote-embed-option-label')!.textContent).toBe('面');
    expect(el.querySelector('.vote-embed-total')!.textContent).toBe('共 4 票');
  });
});
