import { beforeEach, describe, expect, it } from 'vitest';
import { makeCategory, makeUser, resetDb } from '../helpers/db';
import {
  defaultFocusHiddenCategoryIds,
  getFocusState,
  getFocusStateById,
  resolveFocusHiddenCategoryIds,
} from '@/lib/focus-service';
import { serializeFocusHiddenCategories } from '@/lib/focus-mode';

beforeEach(resetDb);

// ─────────────────────────────────────────────────────────────────────────────
// 专注模式的读路径：默认集合 / 用户自选 / 设置页状态
//
// 这里钉死两件最容易静默错的事：
//   1. NULL（未自定义）与 '[]'（明确一个都不屏蔽）不是一回事；
//   2. 选中的栏目要展开子栏目 —— 否则「勾了根、子栏目文章照常出现」。
// ─────────────────────────────────────────────────────────────────────────────

describe('resolveFocusHiddenCategoryIds', () => {
  async function seed() {
    // 站长默认集合：一个启用的根 + 它的子栏目 + 一个已停用的根
    const flaggedRoot = await makeCategory({ name: '水根', slug: 'flagged-root', focusHidden: true });
    const flaggedChild = await makeCategory({ name: '水子', parentId: flaggedRoot.id });
    const flaggedOff = await makeCategory({ name: '停用水根', focusHidden: true, isActive: false });
    // 对照：没被标记的根 + 子栏目
    const normalRoot = await makeCategory({ name: '正常根', slug: 'normal-root' });
    const normalChild = await makeCategory({ name: '正常子', parentId: normalRoot.id });
    return { flaggedRoot, flaggedChild, flaggedOff, normalRoot, normalChild };
  }

  it('专注模式没开 → null（不启用任何过滤）', async () => {
    const { flaggedRoot } = await seed();
    const ids = await resolveFocusHiddenCategoryIds({
      focusMode: false,
      focusHideCategories: serializeFocusHiddenCategories([flaggedRoot.id]),
    });
    expect(ids).toBeNull();
  });

  it('focus_hide_categories = NULL → 站长默认集合（含子栏目与已停用栏目）', async () => {
    const { flaggedRoot, flaggedChild, flaggedOff, normalRoot, normalChild } = await seed();
    const ids = await resolveFocusHiddenCategoryIds({ focusMode: true, focusHideCategories: null });
    expect(new Set(ids)).toEqual(new Set([flaggedRoot.id, flaggedChild.id, flaggedOff.id]));
    expect(ids).not.toContain(normalRoot.id);
    expect(ids).not.toContain(normalChild.id);
  });

  it('★ 焦点：[] 与 NULL 不同 —— 明确一个都不屏蔽时返回空数组', async () => {
    await seed();
    const ids = await resolveFocusHiddenCategoryIds({
      focusMode: true,
      focusHideCategories: '[]',
    });
    expect(ids).toEqual([]);
  });

  it('显式选中正常根 → 展开其子栏目；站长默认集合不再自动套用', async () => {
    const { flaggedRoot, normalRoot, normalChild } = await seed();
    const ids = await resolveFocusHiddenCategoryIds({
      focusMode: true,
      focusHideCategories: serializeFocusHiddenCategories([normalRoot.id]),
    });
    expect(new Set(ids)).toEqual(new Set([normalRoot.id, normalChild.id]));
    expect(ids).not.toContain(flaggedRoot.id);
  });

  it('脏 JSON 回落成「未自定义」（默认集合），不解释成「屏蔽零个」', async () => {
    const { flaggedRoot } = await seed();
    const ids = await resolveFocusHiddenCategoryIds({ focusMode: true, focusHideCategories: '{oops' });
    expect(ids).toContain(flaggedRoot.id);
  });

  it('不存在的 id 被忽略（栏目删掉后残留的 id 不会让查询报错）', async () => {
    await seed();
    const ids = await resolveFocusHiddenCategoryIds({
      focusMode: true,
      focusHideCategories: serializeFocusHiddenCategories([999999]),
    });
    expect(ids).toEqual([]);
  });

  it('defaultFocusHiddenCategoryIds 只给站长标记的（含停用）栏目与子栏目', async () => {
    const { flaggedRoot, flaggedChild, flaggedOff } = await seed();
    const ids = await defaultFocusHiddenCategoryIds();
    expect(new Set(ids)).toEqual(new Set([flaggedRoot.id, flaggedChild.id, flaggedOff.id]));
  });
});

describe('getFocusState / getFocusStateById', () => {
  it('未自定义：customized=false，selected=站长默认集合，categories 只列启用中的 + 已选中的停用栏目', async () => {
    const me = await makeUser({ focusMode: true });
    const flagged = await makeCategory({ focusHidden: true });
    const flaggedOff = await makeCategory({ focusHidden: true, isActive: false });
    const normal = await makeCategory();

    const state = await getFocusState(me);
    expect(state.settings).toEqual({
      enabled: true,
      blockLobby: true,
      blockGames: true,
      blockFishTrade: true,
    });
    expect(state.customized).toBe(false);
    expect(state.selected).toContain(flagged.id);
    // 停用栏目没被选中 → 不列进可勾选项（否则设置页全是早已下线的板块）；
    // 但**已选中的**停用栏目要保留 —— 否则用户没法把默认集合里的它取消掉。
    expect(state.categories.map((c) => c.id)).toEqual(expect.arrayContaining([flagged.id, normal.id]));
    expect(state.categories.find((c) => c.id === flaggedOff.id)?.isActive).toBe(false);
    expect(state.categories.find((c) => c.id === flagged.id)?.focusHidden).toBe(true);
  });

  it('已自定义：selected 展开子栏目，并保留已选中的停用栏目', async () => {
    const me = await makeUser({ focusMode: true });
    const root = await makeCategory();
    const child = await makeCategory({ parentId: root.id });
    const off = await makeCategory({ isActive: false });
    const untouchedOff = await makeCategory({ isActive: false });
    const state = await getFocusState({
      ...me,
      focusHideCategories: serializeFocusHiddenCategories([root.id, off.id]),
    });
    expect(state.customized).toBe(true);
    expect(new Set(state.selected)).toEqual(new Set([root.id, child.id, off.id]));
    const ids = state.categories.map((c) => c.id);
    expect(ids).toContain(off.id);
    expect(ids).not.toContain(untouchedOff.id);
    expect(state.categories.find((c) => c.id === off.id)?.isActive).toBe(false);
  });

  it('子项原值不受总开关影响（总开关关着也回显上次的选择）', async () => {
    const me = await makeUser({ focusMode: false, focusBlockLobby: false, focusBlockGames: true });
    const state = await getFocusState(me);
    expect(state.settings).toEqual({
      enabled: false,
      blockLobby: false,
      blockGames: true,
      blockFishTrade: true,
    });
  });

  it('getFocusStateById：按 id 重读；不存在的用户返回 null', async () => {
    const me = await makeUser({ focusMode: true });
    const state = await getFocusStateById(me.id);
    expect(state?.settings.enabled).toBe(true);
    expect(await getFocusStateById('no-such-user')).toBeNull();
  });
});
