// @vitest-environment jsdom
// ─────────────────────────────────────────────────────────────────────────────
// BlogForm 的**提交载荷**：栏目 / 可见范围这两格真的进了请求体吗
//
// 【为什么值得单测】这两格从原生 `<select>` 换成 `ExpandSelect` 之后，读值方式跟着改了，
// 而改错的样子**完全静默**：
//   · ExpandSelect 的触发钮带 `id`，真正承载值的隐藏 input 带 `name`；本表单两处传的
//     是同一个字符串，而 `form.elements` 按 **name 或 id** 匹配 —— 集合里于是有两个
//     命中项，`namedItem(name)` 返回的不是元素而是 RadioNodeList，它的 `.value`
//     **恒为空串**（规范如此，Chromium 与 jsdom 实测一致）。
//   · 于是提交出去的 `visibility` 是 `''`（服务端 `parseVisibility('')` → `'internal'`），
//     `category_id` 也是 `''`（服务端当未分类）。PUT 是整体覆盖，所以**编辑一篇 public
//     文章、只改标题**，也会把可见性悄悄收回站内；页面回 200、toast「保存成功」。
//     2026-10 的重构确实这么丢过，用户侧的表现正是「改了可见性但好像没保存」。
//
// 【判据要挑能区分「读对」与「读成空串」的值】`''` 经服务端归一化后碰巧等于
// `internal`，所以拿 `internal` 断言会**假绿** —— 用例一律用 `public` / `link` 与
// 一个数字栏目 id。
//
// 【环境】与 clipboard-save-lock.test.ts 同款：本仓库没有 @testing-library，用
// react-dom/client 的 createRoot + React 19 的 act 直接驱动；MarkdownEditor 换成桩
// （真实实例要 CM6 + 测量循环，而这里要测的是表单那一层的读值）。
// ─────────────────────────────────────────────────────────────────────────────

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement, act } from 'react';
import { createRoot } from 'react-dom/client';
import type { CategoryHierarchy } from '@/lib/blog-service';
import BlogForm from '@/app/components/BlogForm';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const stubs = vi.hoisted(() => ({
  /** 桩编辑器里的正文（getDoc 读它）。 */
  doc: { value: '正文内容' },
}));

vi.mock('@/app/components/MarkdownEditor', async () => {
  const { forwardRef, useImperativeHandle } = await import('react');
  return {
    default: forwardRef(function FakeEditor(_props: unknown, ref: unknown) {
      useImperativeHandle(ref as never, () => ({
        getDoc: () => stubs.doc.value,
        isReady: () => true,
        clearDraft: () => {},
        flushDraft: () => {},
      }));
      return null;
    }),
  };
});

/** 一棵最小栏目树：根 7（技术）带子栏目 8（前端）。只填表单会读的字段。 */
const CATEGORIES = [
  {
    id: 7,
    name: '技术',
    slug: 'tech',
    icon: '🧪',
    adminOnlyPosting: false,
    children: [{ id: 8, name: '前端', slug: 'frontend', icon: '', adminOnlyPosting: false }],
  },
] as unknown as CategoryHierarchy;

interface Call {
  url: string;
  method: string;
  body: Record<string, unknown>;
}

let calls: Call[] = [];
let roots: Array<ReturnType<typeof createRoot>> = [];

beforeEach(() => {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        url: String(input),
        method: init?.method ?? 'GET',
        body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
      });
      return {
        ok: true,
        status: 200,
        json: async () => ({ code: 200, redirect: '/blog/b1', blog_id: 'b1' }),
      } as unknown as Response;
    })
  );
});

afterEach(async () => {
  await act(async () => {
    roots.forEach((root) => root.unmount());
  });
  roots = [];
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

type Props = Parameters<typeof BlogForm>[0];

async function mount(props: Partial<Props> = {}) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(createElement(BlogForm, { categories: CATEGORIES, ...props } as Props));
  });
  const form = container.querySelector('#blogForm') as HTMLFormElement | null;
  if (!form) throw new Error('表单没渲染出来：选择器写错了，不是产品坏了');
  return { container, form };
}

/** 按 React 认的方式写进输入框（直接赋值会被 value tracker 吞掉）。 */
async function setValue(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(proto.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

/** 在自定义下拉里选中一项（模拟真用户：点触发钮 → 点选项）。 */
async function choose(container: HTMLElement, triggerId: string, label: string) {
  const host = Array.from(container.querySelectorAll<HTMLElement>('.expand-select')).find((el) =>
    el.querySelector(`#${triggerId}`)
  );
  if (!host) throw new Error(`没找到 #${triggerId} 所在的自定义下拉`);
  const toggle = host.querySelector<HTMLButtonElement>('.expand-select__toggle');
  if (!toggle) throw new Error(`#${triggerId} 的触发钮没渲染出来`);
  await act(async () => {
    toggle.click();
  });
  const option = Array.from(host.querySelectorAll<HTMLElement>('.expand-select__option')).find(
    (el) => el.textContent === label
  );
  if (!option) throw new Error(`下拉里没有「${label}」这一项`);
  await act(async () => {
    option.click();
  });
}

async function submit(form: HTMLFormElement) {
  await act(async () => {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
}

/** 编辑态的一篇文章：栏目 7、可见性站内、匿名评论已关。 */
function editBlog(overrides: Partial<NonNullable<Props['blog']>> = {}): NonNullable<Props['blog']> {
  return {
    id: 'b1',
    title: '原标题',
    description: '原摘要',
    categoryId: 7,
    visibility: 'internal',
    allowAnonymousComments: false,
    contentMarkdown: '正文内容',
    ...overrides,
  };
}

describe('编辑页：整体覆盖时栏目与可见范围必须原样带上', () => {
  it('★ 把可见范围改成「对外公开」再保存 → PUT 体里是 public（不是空串）★', async () => {
    const { container, form } = await mount({ blog: editBlog() });

    await choose(container, 'visibility', '对外公开');
    await submit(form);

    expect(calls, '一次提交应该只有一笔请求').toHaveLength(1);
    expect(calls[0].method).toBe('PUT');
    expect(calls[0].url).toBe('/api/blogs/b1');
    expect(calls[0].body).toMatchObject({
      visibility: 'public',
      // 没动过的两格也必须带上：PUT 是整体覆盖，空串会把栏目清成未分类、
      // 把匿名开关打回默认 true
      category_id: '7',
      allow_anonymous_comments: false,
    });
  });

  it('只改可见性、正文不动 → 请求体仍带着完整的三件套（服务端会整体覆盖）', async () => {
    const { container, form } = await mount({
      blog: editBlog({ visibility: 'public' }),
    });

    await choose(container, 'visibility', '凭链接可读');
    await submit(form);

    expect(calls[0].body).toMatchObject({
      visibility: 'link',
      title: '原标题',
      description: '原摘要',
      content: '正文内容',
    });
  });
});

describe('新建页：选中的栏目与可见范围必须进 POST 体', () => {
  it('★ 选子栏目「前端」+「凭链接可读」→ POST 体里是 8 / link ★', async () => {
    const { container, form } = await mount();
    await setValue(container.querySelector('#title') as HTMLInputElement, '新标题');
    await setValue(container.querySelector('#description') as HTMLTextAreaElement, '新摘要');

    await choose(container, 'category', '前端');
    await choose(container, 'visibility', '凭链接可读');
    await submit(form);

    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('POST');
    expect(calls[0].url).toBe('/api/blogs');
    expect(calls[0].body).toMatchObject({ category_id: '8', visibility: 'link' });
  });
});
