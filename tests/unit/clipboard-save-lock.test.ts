// @vitest-environment jsdom
// ─────────────────────────────────────────────────────────────────────────────
// clipboard-save-lock.test.ts —— 云剪贴板的**保存并发**：一笔在飞时谁还能再发一笔
//
// 【为什么单测】这里的每条错法都是**静默**的，页面上看起来一切正常：
//   · 两个「提交」在同一笔在飞时各挂一次 `await`，它一落地两边同时往下走 →
//     各自 doSave → 新建态**留下两篇内容一样的剪贴板**（页面只跳去其中一篇）；
//   · Ctrl+S（或每分钟自动保存）与在飞的那一笔撞上时排个队 → 连点 Ctrl+S
//     就是连发好几笔 POST，同样每笔一篇；
//   · 反过来收紧过头：等待期间真的改了内容，却被「刚保存过同一份」这条合并逻辑
//     吞掉 → 用户打了字、看着有绿字、改动没存上。
// 这三条要的时序（**第一笔响应悬着**、等待者已经排上队、再放行）只有可控的
// fetch 桩造得出来：真接口几百毫秒就回来了，用例恒绿，什么也证明不了。
//
// 【环境】与 blog-ref-render.test.ts 同款：本仓库没有 @testing-library，
// 用 react-dom/client 的 createRoot + React 19 的 act 直接驱动。
// MarkdownEditor 换成桩（真实例要 CM6 + 测量循环；这里要测的是**表单那一层的锁**，
// 正文从桩里读，见 getContent 的判据）。
// ─────────────────────────────────────────────────────────────────────────────

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement, act } from 'react';
import { createRoot } from 'react-dom/client';
import UploadForm from '@/app/clipboard/upload/UploadForm';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const stubs = vi.hoisted(() => ({
  /** 桩编辑器里的正文（getDoc 读它，用例直接改）。 */
  doc: { value: '' },
  /** router.push 的去向。 */
  pushes: [] as string[],
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: (url: string) => stubs.pushes.push(url),
    replace: () => {},
    back: () => {},
    forward: () => {},
    prefetch: () => {},
    refresh: () => {},
  }),
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
        focus: () => {},
      }));
      return null;
    }),
  };
});

interface PendingCall {
  url: string;
  method: string;
  body: string;
  /** 手动兑现这笔请求（成功）。 */
  resolve(): void;
}

/** 所有请求都**悬着**，由用例决定第一笔何时落地。 */
function stubGatedFetch(): PendingCall[] {
  const calls: PendingCall[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      return new Promise((resolve) => {
        calls.push({
          url,
          method: init?.method ?? 'GET',
          body: String(init?.body ?? ''),
          resolve: () =>
            resolve({ ok: true, status: 200, json: async () => ({ code: 200, id: 'clip0001' }) } as Response),
        });
      });
    })
  );
  return calls;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

/** toast 的去向（UploadForm 走的是 window.showToast）。 */
let toasts: Array<[string, string]> = [];

beforeEach(() => {
  toasts = [];
  stubs.pushes.length = 0;
  stubs.doc.value = '';
  (window as unknown as { showToast?: (m: string, t: string) => void }).showToast = (m, t) => {
    toasts.push([m, t]);
  };
});

/**
 * 挂过的根。**必须逐个卸载**：UploadForm 在 `document` 上挂了 Ctrl+S 监听，
 * 卸载时才会摘掉。只 `document.body.innerHTML = ''` 是不够的 —— 那份 DOM 走了，
 * 监听还在，上一条用例留着的表单会**跟着下一条用例的按键一起保存**，
 * 症状是「请求条数莫名多一条」，而多出来的那条带着上一条用例的内容。
 */
let roots: Array<ReturnType<typeof createRoot>> = [];

afterEach(async () => {
  await act(async () => {
    roots.forEach((root) => root.unmount());
  });
  roots = [];
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
  delete (window as unknown as { showToast?: unknown }).showToast;
});

async function mount(clip?: { id: string; title: string; content: string; publicity: boolean }) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(createElement(UploadForm, clip ? { clip } : {}));
  });
  await settle();
  const title = container.querySelector('#title') as HTMLInputElement;
  const form = container.querySelector('#uploadForm') as HTMLFormElement;
  if (!title || !form) throw new Error('表单没渲染出来：选择器写错了，不是产品坏了');
  return { container, title, form };
}

/** 按 React 认的方式写进受控输入框（直接赋值会被 value tracker 吞掉）。 */
async function setTitle(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function submit(form: HTMLFormElement) {
  await act(async () => {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
}

/** Ctrl+S（表单那一层监听的是 document 上的 keydown）。 */
async function pressCtrlS() {
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true }));
  });
}

describe('一笔在飞时的提交', () => {
  it('★ 连点三次提交：第一笔悬着时不许叠请求，落地后也不许各自补发 ★', async () => {
    const calls = stubGatedFetch();
    const { title, form } = await mount();
    await setTitle(title, '并发标题');
    stubs.doc.value = '正文';

    await submit(form);
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual(['POST /api/clipboard']);

    // 第一笔还悬着 —— 用户等不及，又点了两下
    await submit(form);
    await submit(form);
    expect(calls, '第一笔还没落地就叠了第二笔').toHaveLength(1);

    // 第一笔落地：两个等待者的意图都已经被它满足，谁也不该补发
    await act(async () => {
      calls[0].resolve();
    });
    await settle();

    expect(calls, '等待后各自又补发了一笔 —— 新建态就是两篇剪贴板').toHaveLength(1);
  });

  it('★ 排队期间真改了内容：这一笔必须补发，不能被「刚存过同一份」吞掉 ★', async () => {
    const calls = stubGatedFetch();
    const { title, form } = await mount();
    await setTitle(title, '并发标题');
    stubs.doc.value = '第一版正文';

    await submit(form);
    // 排队中用户又打了字 —— 这一版**没进**第一笔的请求
    await submit(form);
    stubs.doc.value = '第一版正文 补记';

    await act(async () => {
      calls[0].resolve();
    });
    await settle();

    expect(calls, '等待期间改的内容被合并逻辑吞掉了 —— 用户看着有提示，改动没存上').toHaveLength(2);
    expect(JSON.parse(calls[1].body).content).toBe('第一版正文 补记');
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'POST /api/clipboard',
      'POST /api/clipboard',
    ]);
  });

  it('★ 两个排队者 + 等待期间改了内容：只许补发一笔，不能各自写一笔 ★', async () => {
    // 【这一条盯的是「等完有没有**重新判锁**」】上面那条连点三次能过，是因为
    // 表单没变 → 第二个排队者被「刚存过同一份」那条合并逻辑挡下了，谁也没写。
    // 可一旦等待期间改了内容，合并逻辑就不成立：两个排队者会**同时**从同一个
    // 已落地的 Promise 上醒来，若醒来后不看锁，就各自 doSave —— 从头到尾两笔
    // 写请求叠着跑（新建态 = 两篇内容一样的剪贴板）。
    const calls = stubGatedFetch();
    const { title, form } = await mount();
    await setTitle(title, '并发标题');
    stubs.doc.value = '第一版';

    await submit(form); // 第 1 笔（悬着）
    await submit(form); // 排队
    await submit(form); // 也排队
    expect(calls).toHaveLength(1);
    stubs.doc.value = '第一版 补记'; // 排队期间改了 —— 合并逻辑这次拦不住

    await act(async () => {
      calls[0].resolve();
    });
    await settle();

    expect(calls, '两个排队者同时醒来、各自补发了一笔').toHaveLength(2);
    expect(JSON.parse(calls[1].body).content).toBe('第一版 补记');

    // 补发的那一笔落地 → 第二个排队者这时才醒，看到「刚存下的正是这一份」→ 不再写
    await act(async () => {
      calls[1].resolve();
    });
    await settle();
    expect(calls, '第二个排队者醒得太早，又补了一笔').toHaveLength(2);
  });

  it('★ 在飞时按 Ctrl+S：只回一句「正在保存」，不排队、不补发 ★', async () => {
    const calls = stubGatedFetch();
    const { title, form } = await mount();
    await setTitle(title, '手动保存标题');
    stubs.doc.value = '正文';

    await submit(form);
    await pressCtrlS();

    expect(
      toasts.some(([m]) => m.includes('正在保存')),
      '手动保存在飞时没有给任何提示 —— 用户以为按键没生效'
    ).toBe(true);
    expect(calls, '手动保存在飞时排了队').toHaveLength(1);

    await act(async () => {
      calls[0].resolve();
    });
    await settle();
    expect(calls, '排队的 Ctrl+S 在第一笔落地后又补发了一笔').toHaveLength(1);
  });

  it('★ 第一笔落地之后再按 Ctrl+S：照旧新建一笔（新建语义不因合并而丢）★', async () => {
    const calls = stubGatedFetch();
    const { title, form } = await mount();
    await setTitle(title, '两笔标题');
    stubs.doc.value = '正文';

    await submit(form);
    await act(async () => {
      calls[0].resolve();
    });
    await settle();
    expect(stubs.pushes, '新建成功该跳到这一篇').toEqual(['/clipboard/clip0001']);

    // 页面还在这儿（桩里 push 不真跳），接着写、再按 Ctrl+S：**这是新的一笔**
    stubs.doc.value = '正文 第二笔';
    await pressCtrlS();
    expect(calls).toHaveLength(2);
    expect(JSON.parse(calls[1].body).content).toBe('正文 第二笔');
  });

  it('★ 编辑态：等待期间没改 → 不补发同一份；改了 → 补发的是 PUT 那一篇 ★', async () => {
    const calls = stubGatedFetch();
    const { title, form } = await mount({
      id: 'AbCd1234',
      title: '旧标题',
      content: '旧正文',
      publicity: true,
    });
    stubs.doc.value = '旧正文';

    await setTitle(title, '新标题');
    await submit(form);
    await submit(form); // 撞上在飞的那一笔 → 排队
    expect(calls).toHaveLength(1);

    await act(async () => {
      calls[0].resolve();
    });
    await settle();
    // 表单还是那一份 → 排队那一下的意图已经被满足，不该再写一遍
    expect(calls, '表单没变却被补发了一笔').toHaveLength(1);

    // 排队期间真的改了正文：这一笔必须发出去，而且是**更新那一篇**（PUT）
    await submit(form);
    await submit(form); // 又撞上 → 排队
    expect(calls).toHaveLength(2);
    stubs.doc.value = '新正文';
    await act(async () => {
      calls[1].resolve();
    });
    await settle();

    expect(calls, '排队期间改的正文没被补发 —— 用户看着有提示，改动没存上').toHaveLength(3);
    expect(calls[2].method).toBe('PUT');
    expect(calls[2].url).toBe('/api/clipboard/AbCd1234');
    expect(JSON.parse(calls[2].body).content).toBe('新正文');
  });
});
