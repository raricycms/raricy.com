// ─────────────────────────────────────────────────────────────────────────────
// focus-service.ts — 专注模式的读路径（需要 prisma 的那部分）
//
// 零依赖的判定/字面量在 ./focus-mode；这里只负责两件要查库的事：
//   1. **生效的隐藏栏目集合**（resolveFocusHiddenCategoryIds）—— 博客列表、侧栏
//      计数、栏目下拉都吃同一个结果，别各自去读 categories.focus_hidden。
//   2. 设置页要的完整状态（getFocusState）—— 总开关、三个子项、可勾选栏目、
//      当前生效选中的栏目。
//
// 【两种「未选择」不可合并】
//   focus_hide_categories IS NULL → 用户没自定义 → 用站长标记的默认集合；
//   '[]'                          → 用户明确「一个都不屏蔽」。
//   合并会让存量用户升级后突然看到全部水区（静默、无报错）。
//
// 【选中一个栏目 = 屏蔽它及其子栏目】
//   与站长标记 focusHidden 的既有语义一致（勾根栏目带掉子栏目）。所以向外
//   返回的 selected 是**展开后**的集合 —— 设置页据此把子栏目也显示为勾选，
//   否则「勾了根、子项却是空框」看上去像没生效。
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from './db';
import { parseFocusHiddenCategories } from './focus-mode';
import type { FocusCategoryOption, FocusStatePayload } from './focus-mode';

/** 只需要这四列就能算出生效屏蔽范围（SafeUser 与各处 select 的窄对象都满足）。 */
export interface FocusViewer {
  focusMode: boolean;
  focusHideCategories: string | null;
}

export type FocusState = FocusStatePayload;

/** getFocusStateById 需要的列。路由在 PATCH 之后用它重读一遍最新状态。 */
export const FOCUS_STATE_SELECT = {
  focusMode: true,
  focusHideCategories: true,
  focusBlockLobby: true,
  focusBlockGames: true,
  focusBlockFishTrade: true,
} as const;

/** 把 id 集合展开成「自己 + 全部子栏目」。 */
async function expandCategoryIds(ids: readonly number[]): Promise<number[]> {
  if (!ids.length) return [];
  const rows = await prisma.category.findMany({
    where: { id: { in: [...ids] } },
    select: { id: true, children: { select: { id: true } } },
  });
  const out = new Set<number>();
  for (const row of rows) {
    out.add(row.id);
    for (const child of row.children) out.add(child.id);
  }
  return [...out];
}

/**
 * 站长标记的默认屏蔽集合（focus_hidden=true 的栏目 + 子栏目）。
 * 刻意**不过滤 isActive** —— 站长标记的是「这个板子算水区」，停用与否不改变语义
 * （与改版前的旧行为逐字一致）。
 */
export async function defaultFocusHiddenCategoryIds(): Promise<number[]> {
  const flagged = await prisma.category.findMany({
    where: { focusHidden: true },
    select: { id: true, children: { select: { id: true } } },
  });
  const out = new Set<number>();
  for (const row of flagged) {
    out.add(row.id);
    for (const child of row.children) out.add(child.id);
  }
  return [...out];
}

/**
 * 当前查看者的生效隐藏栏目 id。
 *
 * 返回 `null` = **不启用任何过滤**（没开专注模式）。空数组 = 开了专注模式，
 * 但用户选择一个都不屏蔽 —— 两者对 blogListWhere 的行为相同（都不加 notIn），
 * 但语义不同，调用方别用 `!ids` 判「没开」后做别的事。
 */
export async function resolveFocusHiddenCategoryIds(
  viewer: FocusViewer
): Promise<number[] | null> {
  if (!viewer.focusMode) return null;
  const explicit = parseFocusHiddenCategories(viewer.focusHideCategories);
  return explicit === null ? defaultFocusHiddenCategoryIds() : expandCategoryIds(explicit);
}

/** 设置页要的完整状态（GET /api/users/me/focus 的数据源）。 */
export async function getFocusState(user: FocusViewer & {
  focusBlockLobby: boolean;
  focusBlockGames: boolean;
  focusBlockFishTrade: boolean;
}): Promise<FocusState> {
  const explicit = parseFocusHiddenCategories(user.focusHideCategories);
  const [selected, allCategories] = await Promise.all([
    explicit === null ? defaultFocusHiddenCategoryIds() : expandCategoryIds(explicit),
    prisma.category.findMany({
      orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
      select: { id: true, name: true, parentId: true, isActive: true, focusHidden: true },
    }),
  ]);

  // 启用中的栏目总是列出来；停用栏目只在**用户已经选过**时保留 —— 否则设置页
  // 会列出一堆早已下线的板块，而用户又靠它们判断「我正在屏蔽什么」。
  const selectedSet = new Set(selected);
  const categories: FocusCategoryOption[] = allCategories
    .filter((c) => c.isActive || selectedSet.has(c.id))
    .map((c) => ({
      id: c.id,
      name: c.name,
      parentId: c.parentId,
      isActive: c.isActive ?? true,
      focusHidden: c.focusHidden ?? false,
    }));

  return {
    settings: {
      enabled: user.focusMode,
      // 子项**原值**，不与总开关做 AND：设置页的三颗开关要在总开关关着时也显示
      // 用户上次的选择（下次打开专注模式即生效）。真正的闸门是 focus-mode.ts 的
      // isFocus*Blocked（那里才叠总开关），别把两者混起来。
      blockLobby: user.focusBlockLobby,
      blockGames: user.focusBlockGames,
      blockFishTrade: user.focusBlockFishTrade,
    },
    categories,
    selected: [...selected],
    customized: explicit !== null,
  };
}

/** PATCH 之后按 id 重读最新状态（更新路径不持有 SafeUser）。 */
export async function getFocusStateById(userId: string): Promise<FocusState | null> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: FOCUS_STATE_SELECT });
  return user ? getFocusState(user) : null;
}
