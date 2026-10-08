// @vitest-environment jsdom
// ─────────────────────────────────────────────────────────────────────────────
// md-editor-resource-panel.test.ts —— 「插入引用」面板的**竞态**（谁的结果落地）
//
// 【为什么单测】这一域的错误全都不报错、也没有任何日志，表现只是「列表里的东西
// 自己变了」或「刷新没生效」：
//   · 在「投票」加载中切回已经缓存好的「图床」—— 面板这一趟既不取数也不写 state
//     （缓存命中直接早退），可**别的那一条仍在飞**，落地时把图片列表覆盖成投票列表；
//   · 连点两次刷新：先发的那一条后到，把后发的**结果**连同**缓存**一起改回去；
//   · 先发的那一条失败，把后发那条刚写好的缓存**删掉**（下次切回来白重取一次）。
// 判据只能是「按可控顺序兑现响应之后，屏幕上与缓存里各是什么」—— 所以这里用手动
// 兑现的 fetch 桩，而不是响应顺序不可控的真接口。
//
// 【环境】与 blog-ref-render.test.ts 同款：不引 @testing-library（本仓库没有这个
// 依赖），用 react-dom/client 的 createRoot + React 19 的 act 直接驱动。
// ─────────────────────────────────────────────────────────────────────────────

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement, act } from 'react';
import { createRoot } from 'react-dom/client';
import ResourcePanel from '@/app/components/markdown-editor/ResourcePanel';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface PendingCall {
  url: string;
  fulfill(body: unknown): void;
  fail(): void;
}

/** 所有请求都**悬着**，由用例按想要的后到顺序逐条兑现。 */
function stubDeferredFetch(): PendingCall[] {
  const calls: PendingCall[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      return new Promise((resolve, reject) => {
        calls.push({
          url,
          fulfill: (body) => resolve({ ok: true, status: 200, json: async () => body }),
          fail: () => reject(new Error('network')),
        });
      });
    })
  );
  return calls;
}

/** 图片列表的报文（只留解析用得到的字段）。 */
function imagePayload(...names: string[]): unknown {
  return {
    code: 200,
    images: names.map((filename, i) => ({
      id: `Img${String(i)}AbCdEf`,
      filename,
      created_at: '2026-10-07T21:04:05.000Z',
      is_public: true,
    })),
  };
}

function votePayload(...titles: string[]): unknown {
  return {
    code: 200,
    votes: titles.map((title, i) => ({
      id: `Vot${String(i)}AbCdEf`,
      title,
      created_at: '2026-10-07T21:04:05.000Z',
    })),
  };
}

/** 跑一轮宏任务，把 effect 与 promise 链推到底。 */
async function settle(): Promise<void> {
  for (let i = 0; i < 3; i += 1) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

async function mount() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const onInsert = vi.fn();
  const onClose = vi.fn();
  await act(async () => {
    root.render(createElement(ResourcePanel, { onInsert, onClose }));
  });
  await settle();
  return { container, onInsert, onClose, root };
}

/** 当前列表条目的主标题（按屏幕顺序）。 */
function titles(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll('.md-res-item__title')).map(
    (el) => el.textContent ?? ''
  );
}

async function click(el: Element | null): Promise<void> {
  if (!el) throw new Error('要点的元素不在：选择器写错了，不是产品坏了');
  await act(async () => {
    (el as HTMLElement).click();
  });
  await settle();
}

const tab = (container: HTMLElement, key: string) =>
  container.querySelector(`#md-res-tab-${key}`);

function refreshBtn(container: HTMLElement): Element | null {
  return container.querySelector('.md-res-refresh');
}

function searchInput(container: HTMLElement): HTMLInputElement {
  const el = container.querySelector('input[type="search"]');
  if (!el) throw new Error('搜索框不在：选择器写错了，不是产品坏了');
  return el as HTMLInputElement;
}

/** 当前高亮那条（焦点留在搜索框上，高亮由 aria-activedescendant 标出来）。 */
function activeDescendant(container: HTMLElement): string | null {
  return searchInput(container).getAttribute('aria-activedescendant');
}

/**
 * 造一次 keydown。`isComposing` 是**事件对象自己的属性**，用 defineProperty 钉住：
 * jsdom 的构造字典对它的支持随版本而变，钉住才不依赖环境。
 * 返回事件本身 —— `defaultPrevented` 是这几条用例的判据之一（拦下默认动作会
 * 让输入法的候选选不中）。
 */
function keydown(el: Element, key: string, isComposing = false): KeyboardEvent {
  const ev = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  Object.defineProperty(ev, 'isComposing', { value: isComposing, configurable: true });
  el.dispatchEvent(ev);
  return ev;
}

function composition(el: Element, type: 'compositionstart' | 'compositionend'): void {
  el.dispatchEvent(new CompositionEvent(type, { bubbles: true }));
}

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('缓存命中不许放走在飞的那条', () => {
  it('★ 「投票」加载中切回已缓存的「图床」，晚到的投票结果不许覆盖图片列表 ★', async () => {
    const calls = stubDeferredFetch();
    const { container } = await mount();

    // 首屏图床：兑现
    expect(calls.map((c) => c.url)).toEqual(['/api/images']);
    calls[0].fulfill(imagePayload('甲图.png'));
    await settle();
    expect(titles(container)).toEqual(['甲图.png']);

    // 切到投票 —— 请求发出去，**不兑现**（模拟还在飞）
    await click(tab(container, 'vote'));
    expect(calls.map((c) => c.url)).toEqual(['/api/images', '/api/votes']);
    expect(container.textContent).toContain('加载中');

    // 切回图床 —— 缓存命中，立刻见到图片，不发新请求
    await click(tab(container, 'image'));
    expect(calls).toHaveLength(2);
    expect(titles(container)).toEqual(['甲图.png']);

    // 现在那条投票请求才到（先发后到）
    calls[1].fulfill(votePayload('晚饭吃什么'));
    await settle();

    expect(titles(container), '图片列表被晚到的投票结果覆盖了').toEqual(['甲图.png']);
    // 也不能把投票那份塞进图床的缓存格：切回投票时应当**重新取数**，
    // 否则「图床」标签点开是投票列表。
    await click(tab(container, 'vote'));
    expect(calls.map((c) => c.url)).toEqual(['/api/images', '/api/votes', '/api/votes']);
  });
});

describe('连点刷新：先发的后到', () => {
  it('★ 晚到的旧结果不许覆盖新结果，也不许污染缓存 ★', async () => {
    const calls = stubDeferredFetch();
    const { container } = await mount();
    calls[0].fulfill(imagePayload('旧图.png'));
    await settle();
    expect(titles(container)).toEqual(['旧图.png']);

    // 连点两次刷新
    await click(refreshBtn(container));
    await click(refreshBtn(container));
    expect(calls).toHaveLength(3);

    // 后发的先到（新结果）
    calls[2].fulfill(imagePayload('新图.png'));
    await settle();
    expect(titles(container)).toEqual(['新图.png']);

    // 先发的后到（旧结果）—— 屏幕不能翻回去
    calls[1].fulfill(imagePayload('旧图.png'));
    await settle();
    expect(titles(container)).toEqual(['新图.png']);

    // ★ 真正的判据在缓存里 ★：切走再切回来走的是缓存命中这条路，
    // 缓存被旧结果污染的话，这里看到的就是「旧图.png」，而且不发任何请求。
    await click(tab(container, 'vote'));
    calls[calls.length - 1].fulfill(votePayload('晚饭吃什么'));
    await settle();
    await click(tab(container, 'image'));
    expect(titles(container), '缓存被晚到的旧结果覆盖了').toEqual(['新图.png']);
  });

  it('★ 晚到的失败不许删掉新结果那份缓存 ★', async () => {
    const calls = stubDeferredFetch();
    const { container } = await mount();
    calls[0].fulfill(imagePayload('旧图.png'));
    await settle();

    await click(refreshBtn(container));
    await click(refreshBtn(container));

    calls[2].fulfill(imagePayload('新图.png'));
    await settle();
    expect(titles(container)).toEqual(['新图.png']);

    // 先发的那一条现在才失败：它不该把「新图.png」这份缓存删掉
    calls[1].fail();
    await settle();

    // 切走再切回：走缓存命中（不发新请求），列表还是新的那一份。
    // 一轮往返只该多出**一条**请求（切到投票那次）；多出两条就是「切回图床时
    // 缓存已被删掉、只好重打接口」—— 而屏幕上看起来一切正常。
    const before = calls.length;
    await click(tab(container, 'vote'));
    calls[calls.length - 1].fulfill(votePayload('晚饭吃什么'));
    await settle();
    await click(tab(container, 'image'));
    expect(titles(container)).toEqual(['新图.png']);
    expect(calls.length, '缓存被删掉了 —— 切回来又打了一次接口').toBe(before + 1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 组字期间的按键
//
// 【为什么单测】搜索框是中文输入的必经之路：用户打拼音时，Enter 是「确认候选」、
// ↑↓ 是「在候选词之间翻」—— 那几下都**属于输入法**。面板若把它们当成自己的：
//   · Enter → 插进一条**不是用户想要**的引用（他要的是候选词里那个标题）；
//   · ↑↓ → 高亮从 A 跳到 B，用户按 Enter 时插的是 B；
//   · 更糟的是 preventDefault：候选词选不中，字直接打不进去，而面板看着一切正常。
//
// 判据必须是「三件事一件都没发生 + 那一下**没有被拦**」，只断言「没插引用」是不够的
// —— 拦下默认动作那一半同样在毁用户的输入，而屏幕上没有任何迹象。
//
// 【这不是真 IME 验证】这里合成的是事件（compositionstart/end 与带 isComposing 的
// keydown），不是真的让某个输入法去组字。真 IME 只有人手动敲得出来，所以这几条钉的是
// 「判据在不在、拦没拦」；两条路（本地标志 / 原生 isComposing）各测一遍，因为
// 不同浏览器只给其中一条（见 ResourcePanel 里那段注释）。
// ─────────────────────────────────────────────────────────────────────────────
describe('输入法组字期间的按键', () => {
  it('★ 组字中按 Enter：不插、不关面板、也不拦默认动作；组完 Enter 回到面板手里 ★', async () => {
    const calls = stubDeferredFetch();
    const { container, onInsert } = await mount();
    calls[0].fulfill(imagePayload('甲图.png', '乙图.png'));
    await settle();
    const input = searchInput(container);

    // 第一条路：本地标志。Safari 在 compositionend **之前**那一下 keydown 上给
    // isComposing=false，只认原生属性的话这一下会被当成正常回车。
    await act(async () => {
      composition(input, 'compositionstart');
    });
    const enter = await act(async () => keydown(input, 'Enter'));

    expect(enter.defaultPrevented, '组字期间按 Enter 被 preventDefault 了（候选就选不中）').toBe(
      false
    );
    expect(onInsert, '组字期间按 Enter 把引用插进去了').not.toHaveBeenCalled();
    expect(container.querySelector('.md-res-modal'), '组字期间按 Enter 把面板关了').not.toBeNull();

    // 组字结束之后，Enter 立刻回到面板手里 —— 守卫不能粘住（粘住的表现是
    // 「打字时好好的，打完按回车就没反应了」）
    await act(async () => {
      composition(input, 'compositionend');
    });
    const after = await act(async () => keydown(input, 'Enter'));
    expect(after.defaultPrevented, '组完字之后 Enter 不再被拦了（表单隐式提交的口子）').toBe(true);
    expect(onInsert).toHaveBeenCalledTimes(1);
  });

  it('★ 只给原生 isComposing 的那一档（没有 compositionstart）同样得让开 ★', async () => {
    const calls = stubDeferredFetch();
    const { container, onInsert } = await mount();
    calls[0].fulfill(imagePayload('甲图.png'));
    await settle();
    const input = searchInput(container);

    // 有的浏览器组字时 isComposing 为真、而事件早于 compositionstart ——
    // 本地标志那一刻还是 false，只有原生属性认得出。
    const enter = await act(async () => keydown(input, 'Enter', true));
    expect(enter.defaultPrevented, 'isComposing=true 的 Enter 被拦下了').toBe(false);
    expect(onInsert).not.toHaveBeenCalled();

    // 标志是「按这一次事件」判的，不残留：下一枚正常回车照样插
    const next = await act(async () => keydown(input, 'Enter'));
    expect(next.defaultPrevented).toBe(true);
    expect(onInsert).toHaveBeenCalledTimes(1);
  });

  it('★ 组字中按 ↑↓ 高亮不许动，也不许拦（拦了候选词就翻不动）★', async () => {
    const calls = stubDeferredFetch();
    const { container } = await mount();
    calls[0].fulfill(imagePayload('甲图.png', '乙图.png'));
    await settle();
    const input = searchInput(container);
    const before = activeDescendant(container);
    expect(before, '首屏高亮没落在第一条上，这条用例就测不到东西了').not.toBeNull();

    await act(async () => {
      composition(input, 'compositionstart');
    });
    const down = await act(async () => keydown(input, 'ArrowDown'));
    expect(down.defaultPrevented, '组字期间 ↓ 被拦下了').toBe(false);
    expect(activeDescendant(container), '组字期间 ↓ 把高亮挪走了').toBe(before);

    const up = await act(async () => keydown(input, 'ArrowUp'));
    expect(up.defaultPrevented).toBe(false);
    expect(activeDescendant(container)).toBe(before);

    // 组完字之后 ↓ 照旧移动高亮（不是把方向键整个关掉了）
    await act(async () => {
      composition(input, 'compositionend');
    });
    await act(async () => keydown(input, 'ArrowDown'));
    expect(activeDescendant(container), '组完字之后 ↓ 不管用了').not.toBe(before);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 组字期间的 Escape
//
// 【为什么单测】搜索框的 onKeyDown 早就在组字期间让开了，但 Escape 不是它接的 ——
// 它冒泡到**面板挂在 document 上的那个监听**，而那个监听原来无条件 onClose()。
// 于是中文用户打了一半拼音、按 Esc 想把候选条收回去，**整个面板跟着关了**：
// 不报错、不写日志，只是「面板怎么自己没了」。两处判据必须同源（原生 isComposing
// + 本地 composingRef），否则正好漏掉另一半到达顺序。
//
// 【同样不是真 IME 验证】见上一节的说明：这里合成的是事件。
// ─────────────────────────────────────────────────────────────────────────────
describe('输入法组字期间的 Escape', () => {
  it('★ 组字中按 Esc：不关面板；组完字之后 Esc 照常关 ★', async () => {
    const calls = stubDeferredFetch();
    const { container, onClose } = await mount();
    calls[0].fulfill(imagePayload('甲图.png'));
    await settle();
    const input = searchInput(container);

    // 本地标志这一档（Safari：compositionend 之前那一下 keydown 的 isComposing 为 false）
    await act(async () => {
      composition(input, 'compositionstart');
    });
    await act(async () => keydown(input, 'Escape'));
    expect(onClose, '组字期间的 Esc 把面板关了（用户只是想撤掉候选）').not.toHaveBeenCalled();

    // 守卫不能粘住：组字结束后 Esc 立刻回到面板手里
    await act(async () => {
      composition(input, 'compositionend');
    });
    await act(async () => keydown(input, 'Escape'));
    expect(onClose, '组完字之后 Esc 不再关面板了').toHaveBeenCalledTimes(1);
  });

  it('★ 只给原生 isComposing 的 Esc（没有 compositionstart）同样得让开 ★', async () => {
    const calls = stubDeferredFetch();
    const { container, onClose } = await mount();
    calls[0].fulfill(imagePayload('甲图.png'));
    await settle();
    const input = searchInput(container);

    await act(async () => keydown(input, 'Escape', true));
    expect(onClose, 'isComposing=true 的 Esc 把面板关了').not.toHaveBeenCalled();

    // 判据是「按这一次事件」判的，不残留
    await act(async () => keydown(input, 'Escape'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('组字结束后、且不在输入框里按的 Esc 也照常关（不是把 Escape 整个关掉）', async () => {
    const calls = stubDeferredFetch();
    const { container, onClose } = await mount();
    calls[0].fulfill(imagePayload('甲图.png'));
    await settle();

    await act(async () => keydown(container.querySelector('.md-res-modal') ?? document.body, 'Escape'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
