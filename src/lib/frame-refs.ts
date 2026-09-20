// ─────────────────────────────────────────────────────────────────────────────
// frame-refs.ts — 头像框的**词汇表**（白名单、解析、人话标签、到期判定）
//
// 头像框 = 一张带透明通道的 PNG，绝对定位叠在头像上（`src/app/components/Avatar.tsx`
// 的 `.avatar__frame`）。素材字节在 `instance/frames/<key>.png`（gitignored，站长手工拷），
// 扫盘与字节路由在 `src/lib/frame-service.ts`（server-only）。
//
// ── 【为什么单独一个文件】────────────────────────────────────────────────────
// `/settings` 的装备面板是**客户端组件**，它要把每个框渲染成一张卡片（缩略图 + 显示名）；
// 而 `frame-service.ts` 拖着 `node:fs` 与 prisma，**不能进客户端包**。词汇是这一整套
// 设计里唯一两端都要用到的部分，所以它必须住在零依赖的模块里 —— 否则前端只能手抄一份
// 清单，而手抄的那份会在加第二个框时静默漏掉（面板少一张卡片，不报错，
// 只是那个框从此在界面上不可达）。`type-only` 的 `import type` 帮不上忙：
// 它只擦类型，擦不掉运行时要用到的数组。同一理由见 `blog-visibility.ts` 的文件头。
//
// ── 【key 空间在白名单里，目录只提供字节】────────────────────────────────────
// 这一点与**表情包相反**，别照抄那边的直觉：表情的目录即 key 空间（往
// `instance/stickers/` 丢什么就有什么）。这里 `FRAME_KEYS` 是权威，磁盘只是素材仓库。
// 于是「目录缺席」只让框**不显示**，不会让框**不存在** —— 授权、价格、展示名都照常，
// 缺的只是那张图（`frame-service` 的第三道闸会把它判成「暂时没图」）。
//
// ── 【改这里的代价】────────────────────────────────────────────────────────────
// 加一个框 = 拷一张 PNG 到 `instance/frames/` + 在 `FRAMES` 里加一条。
// `FRAMES` 是 `Record<FrameKey, FrameDef>`（穷尽的），加了 key 不补条目 **tsc 当场报错** ——
// 这正是要的形状：漏补的后果（面板上少一张卡片、CLI 的选项里没有它）都是静默的。
// **不需要迁移**：`user_frames.frame_key` 是文本、不是外键，框的定义不住库。
//
// ── 【到期判定：全仓只有这里做比较】──────────────────────────────────────────
// `isFrameExpired` 是**唯一**的到期比较，而它只被 `resolveFrameKey` 调用，
// `resolveFrameKey` 又只被 `frame-service.frameUrlFor()` 调用（那是下发 DTO 的唯一出口）。
// 为什么要把这件事收成一条线：
//   · 漏判的症状是**那一处永远戴着框** —— 到期不消失，不报错、不 500、日志里什么都没有；
//   · 客户端一次都不该判：`tests/unit/db-time-guard.test.ts` 规则 3–5 扫**整个 `src/`**
//     （含页面组件），在客户端写 `new Date(expires_at) > new Date()` 会被静态守卫判红。
//     所以「唯一的判定形状」与「静态守卫的要求」在这里正好重合。
//
// ⚠️ 时钟：`expires_at` 由 `nowForDb()` 写入（UTC+8 墙上时间贴 Z 标签），
//    比较必须用同一把钟。本文件是纯函数、**自己不读时钟** —— `now` 一律由调用方给，
//    服务端那唯一一处调用传的就是 `nowForDb()`（见 `frame-service.frameUrlFor`）。
//    拿真实 UTC 的 `new Date()` 去比会凭空多 8 小时：**30 天的框实际生效 29 天 16 小时**，
//    轻微到没人会发现，正是那种静默错误。
//
// ── 【边界口径】───────────────────────────────────────────────────────────────
//   `expires_at === null`  → 永久，不过期
//   `now === expiresAt`    → **未过期**（用 `>` 不是 `>=`，与 `isCurrentlyBanned`
//                            的 `nowForDb() > banUntil` 同口径）
//
// 本文件不依赖任何 Node 侧东西、不碰 React、不碰 prisma，故可直接单测
//（tests/unit/frame-refs.test.ts）。
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 全部头像框的 key，**这个顺序就是展示顺序**（别打乱 —— 设置面板与 CLI 的选项
 * 都按它排）。与 `blog-visibility.ts` 的 `BLOG_VISIBILITIES` 同款：数组即顺序，
 * 不另设 order 字段（两处维护会漂）。
 *
 * ⚠️ **退役一个框时把 `FRAMES[k].retired` 置 true，不要从这里删掉 key。**
 *   删了之后：`parseFrameKey` 认不出它 → 设置面板没法显示那一行 → 用户**卸不掉**
 *   一个已经退役的框（见 `docs/architecture.md` §6.14 的风险节）。
 *   保留 key 的代价只是一行数组元素。
 *
 * ⚠️ 第一版只有一个占位 key，给单测与 e2e 用。站长做好素材后按真实文件名登记
 *   （`instance/frames/<key>.png` 的 `<key>` 就是这里的字符串，一一对应）。
 */
export const FRAME_KEYS = ['demo'] as const;

export type FrameKey = (typeof FRAME_KEYS)[number];

export interface FrameDef {
  /** 给人看的名字，界面与 CLI 一律用它 —— 别把 key 塞进界面。 */
  label: string;
  /** 一句话说明。设置面板的卡片与 CLI 的 `describe` 共用。 */
  description: string;
  /**
   * 已下架：不再在面板的「可装备」区出现，但**持有关系保留**，且用户仍能卸下它。
   * 省略 = 在架。
   */
  retired?: boolean;
}

/**
 * 穷尽表 —— 加 `FRAME_KEYS` 的条目而不补这里，tsc 当场报错（这是刻意的，见文件头）。
 */
export const FRAMES: Record<FrameKey, FrameDef> = {
  demo: {
    label: '示例框',
    description: '占位用的示例头像框。站长做好素材后按真实文件名登记，把这条换掉。',
  },
};

/** 头像框字节路由的路由前缀。 */
export const FRAME_URL_PREFIX = '/api/frames/';

/**
 * 解析提交上来的 frame key。
 *
 * 非白名单值（含 `undefined` / `null` / 空串 / 已退役的 key）一律 **null**，
 * 由调用方报 400 —— **不静默丢弃**。这里**没有**像 `parseVisibility` 那样的缺省值：
 * 可见性有「最安全的那一档」可以兜，而 frame key 没有安全默认值
 * （兜成任何一个 key 都等于替用户做了个他没做的决定）。
 *
 * 所以「卸下」这件事**不走本函数** —— 调用方拿到的 `null` 就是卸下信号，
 * 与「key 非法」是两条不同的路（见 `/api/users/me/frame` 的 PUT）。
 */
export function parseFrameKey(raw: unknown): FrameKey | null {
  if (typeof raw !== 'string' || raw === '') return null;
  return (FRAME_KEYS as readonly string[]).includes(raw) ? (raw as FrameKey) : null;
}

/**
 * key → 显示名。**未知 key 返回 null**，退役的 key 照常返回名字。
 *
 * 与 `parseFrameKey` 的分工：那个是「能不能用它做写操作」（退役即不可再装备），
 * 这个是「能不能把它显示给人看」（退役了也要说得出它叫什么，
 * 否则设置面板只能显示一行 `unknown-frame-3`）。
 */
export function frameLabel(key: string): string | null {
  return (FRAMES as Record<string, FrameDef | undefined>)[key]?.label ?? null;
}

/** 头像框贴图地址。key 已由白名单约束（标识符形状），无需编码。 */
export function frameUrl(key: FrameKey): string {
  return `${FRAME_URL_PREFIX}${key}`;
}

/**
 * ★ 全仓**唯一**的到期比较 ★
 *
 * 纯函数，内部**不读时钟** —— `now` 由调用方给（服务端传 `nowForDb()`）。
 * 这样边界可以冻时钟单测，且不存在「两把钟混用」的可能。
 *
 * `expires_at` 为 null = 永久。相同时刻算**未过期**（见文件头的边界口径）。
 */
export function isFrameExpired(expiresAt: Date | null | undefined, now: Date): boolean {
  if (!expiresAt) return false;
  return now > expiresAt;
}

/**
 * ★ 唯一的「这个框该不该显示」判定（不含磁盘）★
 *
 * 三道判定合一：白名单 → 未退役 → 未过期。返回 null 表示**不该显示**。
 *
 * ⚠️ 这里**不查磁盘**。素材在不在盘上是第三道闸，只有 `frame-service` 能查
 *（它握着 fs）。本函数回答的是「授权与时间上该不该戴」，那个答案不受
 * 「站长还没把图拷上来」影响 —— 素材缺失是运维问题，不是用户的问题。
 */
export function resolveFrameKey(
  key: string | null | undefined,
  expiresAt: Date | null | undefined,
  now: Date
): FrameKey | null {
  const k = parseFrameKey(key);
  if (!k) return null;
  if (FRAMES[k].retired) return null;
  if (isFrameExpired(expiresAt, now)) return null;
  return k;
}
