// ─────────────────────────────────────────────────────────────────────────────
// focus-mode.ts — 专注模式共享字面量 / 判定（零依赖，server/client 均可 import）
//
// 专注模式是账号级偏好（DB users.focus_mode）。**总开关 + 四个可分别配置的
// 屏蔽项**：
//   · 博客栏目（focus_hide_categories，用户自选；NULL = 沿用站长标记的默认集合）
//   · 讨论大区（focus_block_lobby）
//   · 玩具区（focus_block_games）
//   · 鱼干练手盘（focus_block_fish_trade）
//
// 这里只放不依赖 prisma 的纯判定与字面量：
//   · 三个 `isFocus*Blocked` 是**服务端闸门与客户端渲染共用的唯一判据** ——
//     别在页面 / 路由里自己写 `user.focusMode && user.focusBlockX`（漏掉总开关
//     就是「没开专注模式也被屏蔽」，只判子项则相反，两种都不报错）。
//   · 设置页锚点 / 403 文案也在这里，避免各处字符串漂移。
//
// 判定函数对 `undefined` 子项**按 true 处理**（`!== false`）：调用方常只拿到
// `{ focusMode: true }` 的窄对象（测试 / 旧调用点），按「默认屏蔽」解释才不会
// 在迁移半途把闸门静默放行。字段在库里有 NOT NULL DEFAULT true 兜底。
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 专注模式下的统一文案。**现在只剩服务端在用**（大区与四个练手盘接口的 403 message）
 * —— 界面层的入口改成了「用不了就整段不渲染」，没有禁用态、也就没有 hover title 了。
 */
export const FOCUS_MODE_BLOCKED_TITLE = '已开启专注模式，无法使用该功能';

/** 设置页专注模式卡片的锚点（横幅「此处」/ 讨论空态同源）。 */
export const FOCUS_MODE_SETTINGS_HREF = '/settings#focus-mode';

/** 专注模式里可分别开关的三类「干扰源」。博客栏目是第四项（多选，单独存）。 */
export const FOCUS_TOGGLE_ITEMS = ['lobby', 'games', 'fishTrade'] as const;
export type FocusToggleItem = (typeof FOCUS_TOGGLE_ITEMS)[number];

/** 判定所需的最小字段形状（SafeUser 与各处 select 出来的窄对象都满足）。 */
export interface FocusFlags {
  focusMode?: boolean | null;
  focusBlockLobby?: boolean | null;
  focusBlockGames?: boolean | null;
  focusBlockFishTrade?: boolean | null;
}

/** 讨论大区是否对当前查看者不可用。 */
export function isFocusLobbyBlocked(u: FocusFlags | null | undefined): boolean {
  return !!u && u.focusMode === true && u.focusBlockLobby !== false;
}

/** 玩具区是否对当前查看者不可用。 */
export function isFocusGamesBlocked(u: FocusFlags | null | undefined): boolean {
  return !!u && u.focusMode === true && u.focusBlockGames !== false;
}

/** 鱼干练手盘（含统计页与四个接口）是否对当前查看者不可用。 */
export function isFocusFishTradeBlocked(u: FocusFlags | null | undefined): boolean {
  return !!u && u.focusMode === true && u.focusBlockFishTrade !== false;
}

/** 单个自选栏目 id 的上限：防「把整份脏 JSON 塞进去」把列撑爆（栏目总数远小于它）。 */
export const FOCUS_HIDDEN_CATEGORY_LIMIT = 500;

/**
 * 把库里 / 请求里的 `focus_hide_categories` 解析成 id 数组。
 *
 * 返回 `null` 有**两种**语义，调用方必须区分：
 *   · 输入是 null/undefined 或空串 → 「未自定义」；
 *   · 输入不是合法 JSON 数组 → 也回退成「未自定义」（宁可回到站长默认集合，
 *     也别把脏数据解释成「用户选择屏蔽零个栏目」—— 后者会静默放出全部水区）。
 *
 * 合法数组里的脏元素（非整数 / ≤0）直接丢弃；去重保序。
 */
export function parseFocusHiddenCategories(raw: unknown): number[] | null {
  if (raw === null || raw === undefined) return null;
  let value: unknown = raw;
  if (typeof raw === 'string') {
    const text = raw.trim();
    if (!text) return null;
    try {
      value = JSON.parse(text);
    } catch {
      return null;
    }
  }
  if (!Array.isArray(value)) return null;
  const ids: number[] = [];
  for (const item of value) {
    if (typeof item !== 'number' || !Number.isInteger(item) || item <= 0) continue;
    if (!ids.includes(item)) ids.push(item);
    if (ids.length >= FOCUS_HIDDEN_CATEGORY_LIMIT) break;
  }
  return ids;
}

/**
 * 严格解析**请求体**里的 `hiddenCategoryIds`：与上面的宽松解析不同，
 * 这里非法形状要显式报错，不能静默回落（用户点了保存却没存上 = 静默失效）。
 * `null` = 恢复默认；数组 = 用户显式选择（含 `[]`）。
 */
export function parseFocusHiddenCategoriesInput(
  raw: unknown
): { ok: true; value: number[] | null } | { ok: false } {
  if (raw === null) return { ok: true, value: null };
  if (!Array.isArray(raw)) return { ok: false };
  const ids: number[] = [];
  for (const item of raw) {
    if (typeof item !== 'number' || !Number.isInteger(item) || item <= 0) return { ok: false };
    if (!ids.includes(item)) ids.push(item);
    if (ids.length > FOCUS_HIDDEN_CATEGORY_LIMIT) return { ok: false };
  }
  return { ok: true, value: ids };
}

/** 落库形态：JSON 数组文本（`[]` 与 NULL 是不同状态，别把空数组写成 null）。 */
export function serializeFocusHiddenCategories(ids: readonly number[]): string {
  return JSON.stringify(ids);
}

// ── 设置页 ↔ API 的载荷形状（纯类型，零运行时）──────────────────────────────
//
// 定义在零依赖模块里，服务端（focus-service / route）与客户端（FocusPanel）共用
// 同一份 —— 分两处写会在加字段时静默漂移（TS 只会在真正读到缺字段的地方报）。

export interface FocusCategoryOption {
  id: number;
  name: string;
  parentId: number | null;
  isActive: boolean;
  /** 站长标记的默认屏蔽栏目（用户未自定义时生效）。设置页用它做「默认」提示。 */
  focusHidden: boolean;
}

export interface FocusSettingsValues {
  enabled: boolean;
  blockLobby: boolean;
  blockGames: boolean;
  blockFishTrade: boolean;
}

export interface FocusStatePayload {
  settings: FocusSettingsValues;
  /** 设置页可勾选的栏目：启用中的栏目 + 已被选中的停用栏目（后者标 isActive=false）。 */
  categories: FocusCategoryOption[];
  /** 当前生效的选中集合（已展开子栏目）。未自定义时 = 站长默认集合。 */
  selected: number[];
  /** 是否已自定义（false = 走站长默认集合，可一键恢复）。 */
  customized: boolean;
}
