// @vitest-environment jsdom
// ─────────────────────────────────────────────────────────────────────────────
// sticker-picker.test.ts —— 表情面板「停在哪一栏」的判定
//
// 【为什么值得单测】e2e（tests/e2e/sticker.spec.ts）覆盖了主路径：开着面板切一栏、
// 关掉再开还停在那一栏。但下面三条在浏览器里**摆不出来、或摆起来要动服务器磁盘**，
// 而它们全是「改坏了不报错」的那类 —— 面板照样开、照样能点，只是落点不对：
//   · 记忆里的那一栏**已经不在了**（站长删了目录）→ 要落回第一栏，不能空着；
//   · 站长在素材目录里也建了个「黄脸」→ 面板里**只能有一栏**（两种来源共用同一个
//     名字空间，token 都是 `[@黄脸/…]`；列成两栏还会让 React key 与 aria-selected
//     的比对一起撞车）；
//   · 点一栏之后**写进 localStorage 的是 key**（token 里那一段），不是下标 ——
//     下标会在两次打开之间悄悄换人。
// 第三条正是本文件与面板一起改的那个决定，前两条是它的边界。
//
// 【环境】同 use-resolved-content.test.ts：jsdom + react-dom/client 的 createRoot
// + React 19 的 act，不引 @testing-library/react（本仓库没有这个依赖）。
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createElement, act } from 'react';
import { createRoot } from 'react-dom/client';
import StickerPicker from '@/app/components/StickerPicker';
import { EMOJI_COLLECTION, EMOJI_COLLECTION_TITLE } from '@/lib/emoji-faces';

// React 要求显式声明「这是测试环境」，否则 act 会警告
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * 面板记忆的存储键。**故意写成字面量**：这是与实现之间的契约（e2e 那边靠「刷新整页
 * 还记得」间接钉它），改键名时应当连着这份用例一起改，而不是让它跟着实现漂。
 */
const LS_KEY = 'sticker_collection';

const OWNER_COLLECTION = '猫猫';
const OTHER_COLLECTION = '风景';

/**
 * 一份固定的面板载荷 —— 含一个**与内置黄脸同名**的站长目录。
 *
 * 【为什么全文件共用一份】面板的清单缓存在模块级（5 分钟 TTL），用例之间会串；
 * 共用一份就不必为了清缓存去 resetModules（那会牵动 React 的模块实例）。
 */
const PAYLOAD = {
  code: 200,
  empty: false,
  collections: [
    {
      key: EMOJI_COLLECTION,
      title: '站长自己建的黄脸',
      stickers: [{ name: '自定义脸', url: '/api/stickers/黄脸/自定义脸' }],
    },
    {
      key: OWNER_COLLECTION,
      title: '猫猫合集',
      stickers: [
        { name: '开心', url: '/api/stickers/猫猫/开心' },
        { name: '生气', url: '/api/stickers/猫猫/生气' },
      ],
    },
    {
      key: OTHER_COLLECTION,
      title: '风景合集',
      stickers: [{ name: '山', url: '/api/stickers/风景/山' }],
    },
  ],
};

/** 把挂起的 promise 链跑完（fetch 的 then / finally 都要轮到）。 */
async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

/** 挂载面板。调用方拿到容器后按类名查 DOM（本仓库没有 testing-library）。 */
async function mountPicker() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(createElement(StickerPicker, { onClose: () => {}, onPick: () => {} }));
  });
  await flush(); // 等清单到货
  return {
    container,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

/** tab 文案（顺序即面板上的从左到右）。 */
function tabTitles(container: HTMLElement): string[] {
  return [...container.querySelectorAll('.sticker-picker__tab')].map((el) => el.textContent ?? '');
}

/** 当前高亮的那一栏的文案；一栏都没高亮时返回 null。 */
function activeTitle(container: HTMLElement): string | null {
  return container.querySelector('.sticker-picker__tab[aria-selected="true"]')?.textContent ?? null;
}

/** 网格里第一格的 token（`title` 属性就是 token）。 */
function firstItemToken(container: HTMLElement): string | null {
  return container.querySelector('.sticker-picker__item')?.getAttribute('title') ?? null;
}

/** 点某一栏。 */
function clickTab(container: HTMLElement, title: string) {
  const btn = [...container.querySelectorAll<HTMLButtonElement>('.sticker-picker__tab')].find(
    (el) => el.textContent === title
  );
  if (!btn) throw new Error(`没有这一栏：${title}`);
  act(() => {
    btn.click();
  });
}

describe('表情面板：停在哪一栏', () => {
  let mounted: { container: HTMLElement; unmount: () => void } | null = null;

  beforeEach(() => {
    localStorage.clear();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 200, json: async () => PAYLOAD }))
    );
  });

  afterEach(() => {
    mounted?.unmount();
    mounted = null;
    vi.unstubAllGlobals();
  });

  it('没有记忆时停在第一栏（黄脸），站长的合集排在后面', async () => {
    mounted = await mountPicker();
    const { container } = mounted;

    expect(tabTitles(container)).toEqual([EMOJI_COLLECTION_TITLE, '猫猫合集', '风景合集']);
    expect(activeTitle(container)).toBe(EMOJI_COLLECTION_TITLE);
  });

  it('★ 站长也建了个「黄脸」目录时，面板里仍然只有一栏', async () => {
    mounted = await mountPicker();
    const { container } = mounted;

    // 载荷里那份同名合集的**显示名**都没机会出现 —— 它整栏被让给了内置黄脸
    expect(tabTitles(container)).not.toContain('站长自己建的黄脸');
    expect(tabTitles(container).filter((t) => t === EMOJI_COLLECTION_TITLE)).toHaveLength(1);
    // 网格里是**内置**黄脸（静态素材），不是站长那个目录里的图
    expect(firstItemToken(container)?.startsWith(`[@${EMOJI_COLLECTION}/`)).toBe(true);
    expect(firstItemToken(container)).not.toBe(`[@${EMOJI_COLLECTION}/自定义脸]`);
  });

  it('有记忆时停在记忆的那一栏，网格也跟着走', async () => {
    localStorage.setItem(LS_KEY, OWNER_COLLECTION);
    mounted = await mountPicker();
    const { container } = mounted;

    expect(activeTitle(container)).toBe('猫猫合集');
    expect(firstItemToken(container)).toBe(`[@${OWNER_COLLECTION}/开心]`);
  });

  it('★ 记忆里的那一栏已经没了（站长删了目录）→ 落回第一栏，且仍然只有一栏高亮', async () => {
    localStorage.setItem(LS_KEY, '已经删掉的合集');
    mounted = await mountPicker();
    const { container } = mounted;

    expect(activeTitle(container)).toBe(EMOJI_COLLECTION_TITLE);
    // 高亮必须只有一处 —— 否则说明判定跟着 activeKey 走了（那个值谁都对不上）
    expect(container.querySelectorAll('.sticker-picker__tab[aria-selected="true"]')).toHaveLength(1);
  });

  it('★ 点一栏写进 localStorage 的是 key（token 里那一段），不是下标', async () => {
    mounted = await mountPicker();
    const { container } = mounted;

    // 风景合集在下标 2 上 —— 若存的是下标，这里会是 '2'，而站长的合集列表一变，
    // 下一次打开就会落到另一个合集上（不报错）
    clickTab(container, '风景合集');
    expect(localStorage.getItem(LS_KEY)).toBe(OTHER_COLLECTION);
    expect(activeTitle(container)).toBe('风景合集');

    // 切回去也要跟着更新
    clickTab(container, '猫猫合集');
    expect(localStorage.getItem(LS_KEY)).toBe(OWNER_COLLECTION);
  });

  it('localStorage 用不了（隐私模式）时不炸：只是不记忆', async () => {
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });

    mounted = await mountPicker();
    const { container } = mounted;
    expect(activeTitle(container)).toBe(EMOJI_COLLECTION_TITLE);

    // 本次会话内照样能切（只是记不住）
    clickTab(container, '风景合集');
    expect(activeTitle(container)).toBe('风景合集');

    getItem.mockRestore();
    setItem.mockRestore();
  });
});
