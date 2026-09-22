// ─────────────────────────────────────────────────────────────────────────────
// frame-refs.ts — 头像框的**词汇表**（白名单、解析、人话标签、到期判定）
//
// 头像框 = 一张带透明通道的 PNG，绝对定位叠在头像上（`src/app/components/Avatar.tsx`
// 的 `.avatar__frame`）。素材字节在 `public/static/frames/<key>.png`（**随代码入库** ——
// 它是我们自己画的，与用户上传 / 第三方表情那些运行时数据不是一类东西），
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
// 加一个框 = 加一条 `FRAMES` 条目 + 一张 `public/static/frames/<key>.png`（正常是改
// `scripts/make-frame-demos.mjs` 的 SVG 再重跑，见那个文件头）。
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
 * ⚠️ 每一项都要有对应的 `public/static/frames/<key>.png`。缺素材时框**静默不显示**
 * （页面不报错）—— 自查用 `npm run cli -- frame list --keys`。
 * 这几款的素材由 `node scripts/make-frame-demos.mjs` 生成（出图规格的活文档），
 * 并**随代码入库**：改了那个脚本就得重跑并把 public/static/frames/ 一起提交，
 * 否则站点继续显示旧图 —— tests/unit/frame-assets.test.ts 盯着这件事。
 *
 * ⚠️ **退役一个框时把 `FRAMES[k].retired` 置 true，不要从这里删掉 key。**
 *   删了之后：`parseFrameKey` 认不出它 → 设置面板没法显示那一行 → 用户**卸不掉**
 *   一个已经退役的框（见 `docs/architecture.md` §6.14 的风险节）。
 *   保留 key 的代价只是一行数组元素。
 */
export const FRAME_KEYS = ['ring', 'gradient', 'glow', 'corner', 'dashed', 'fishblue'] as const;

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
  /**
   * 鱼干商城的租金（**鱼干 / 天**）。省略 = 不零售，只能由站长发放。
   *
   * 【为什么价格住这里而不是库】与 `label` 同一个理由（见文件头）：商城面板是
   * 客户端组件，而 `frame-service` 拖着 prisma 进不了客户端包 —— 价格若住在那边，
   * 前端就只能手抄一份，而手抄的那份会在改价时静默对不上（页面显示 1 鱼干、
   * 服务端扣 2 条）。放这里，**展示与校验读的是同一个数**。
   *
   * ⚠️ 改这个数 = 改全站定价。`docs/guide/头像框使用指南.md` 与 `docs/cli.md`
   *    （`frame list --keys` 的输出样例）复述了它，要同步。
   * ⚠️ 退役一款框（`retired: true`）会**同时下架**它在商城的在售行 ——
   *    `rentableFrameKeys()` 两件事一起判，不会出现「已下架却还能买」。
   */
  rentPerDay?: number;
}

/**
 * 穷尽表 —— 加 `FRAME_KEYS` 的条目而不补这里，tsc 当场报错（这是刻意的，见文件头）。
 */
export const FRAMES: Record<FrameKey, FrameDef> = {
  ring: {
    label: '素环',
    description: '最基础的一款：一圈实心描边。缩到 20px 也认得出，是可以照抄的下限。',
  },
  gradient: {
    label: '流光',
    description: '青 → 蓝 → 紫的斜向渐变。几何与素环完全一样，只是换了配色。',
  },
  glow: {
    label: '光晕',
    description: '外侧一圈实线，内侧两层递弱的宽环 —— 柔和的发光感。',
  },
  corner: {
    label: '角框',
    description: '细环 + 加粗的四角。大尺寸下好看，缩到 20px 就只剩一圈环了。',
  },
  dashed: {
    label: '点线',
    description: '圆头端点的虚线环，像一圈小扇贝。小尺寸下会糊成一条灰环。',
  },
  fishblue: {
    label: '鱼干蓝',
    description: '深蓝 → 天蓝的渐变环，四角各压一条小鱼干。缩到 20px 时鱼只剩四个浅色小点。',
    rentPerDay: 1,
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

// ─────────────────────────────────────────────────────────────────────────────
// 鱼干商城的**租赁词汇**（价格、天数、在架清单）
//
// 这一节是纯函数，服务端与客户端读的是**同一份**：服务端拿它校验与算钱，
// 商城面板拿它渲染价格与置灰按钮。两边各写一份的后果不是报错，是
// 「页面显示 1 鱼干、服务端扣 2 条」—— 而用户只会觉得账不对。
// ─────────────────────────────────────────────────────────────────────────────

/** 单次可租的最少 / 最多天数。**两端都是硬边界**，两边读同一对常量。 */
export const FRAME_RENT_MIN_DAYS = 1;
export const FRAME_RENT_MAX_DAYS = 30;

/** 天数在合法区间内吗（整数、含两端）。 */
export function isRentDaysInRange(days: number): boolean {
  return Number.isInteger(days) && days >= FRAME_RENT_MIN_DAYS && days <= FRAME_RENT_MAX_DAYS;
}

/**
 * 一款框**能卖的价**（鱼干 / 天）；null = 不卖。
 *
 * 判据两条，缺一不可：配了一个**正数**价，且未退役。商城在架清单与算钱都走这一个
 * 出口 —— 别在调用方另写一份「有没有价格」的判断，两份判断迟早会对不上。
 *
 * ⚠️ 为什么非正数也算「不卖」而不是「免费」：`rentPerDay: 0` 是最容易写出来的
 *    「免费框」，而免费租借这条路根本不存在 —— 记账内核拒收 0 单位（`postEntry`
 *    抛普通 Error），于是**用户点一下就是 500**，而页面上还写着「合计 0 鱼干、
 *    按钮可点」。判成「不卖」之后：商城不列它、接口回 400 点名去问站长，
 *    运维在 `frame list --keys` 与 `npm run diagnose` 里看得到那条警告。
 *    真要免费送，走 `npm run cli -- frame grant`（那里不经过鱼干）。
 *
 * ⚠️ 别漏 `retired` 那一半：漏了就是「已下架的框还能买到」—— 鱼干照扣、持有行
 *    照建，但戴上不显示（`resolveFrameKey` 到期之前先判退役），看起来像素材丢了。
 */
function salePriceOf(key: FrameKey): number | null {
  const def = FRAMES[key];
  if (def.retired) return null;
  const price = def.rentPerDay;
  return typeof price === 'number' && price > 0 ? price : null;
}

/** 在售的框 —— 商城的**唯一**在架清单，按 `FRAME_KEYS` 顺序陈列。 */
export function rentableFrameKeys(): FrameKey[] {
  return FRAME_KEYS.filter((k) => salePriceOf(k) !== null);
}

/**
 * 一款框租 `days` 天的总价（鱼干）。**不可租 / 天数越界一律 null**。
 *
 * 与 `parseRentDays` 的分工照 `parseFrameKey` / `frameLabel` 那一对：
 * 这个回答「要收多少钱」，那个回答「这个天数字本身合法吗」。
 */
export function frameRentCost(key: string, days: number): number | null {
  const k = parseFrameKey(key);
  if (!k) return null;
  const price = salePriceOf(k);
  if (price === null || !isRentDaysInRange(days)) return null;
  return price * days;
}

/**
 * 解析提交上来的天数。**非法一律 null**，由调用方报 400 —— 不兜默认值。
 *
 * 与 `parseFrameKey` 同款纪律：兜成 1 天或 30 天都等于**替用户做了一个他没做的
 * 决定**，而这次那个决定还带着一次扣款。
 *
 * 形状判得比 `Number()` 严：`Number('1e2')` 是 100、`Number(' 1 ')` 是 1、
 * `Number('')` 是 0、`Number([])` 是 0 —— 放行前两个就是静默卖出一个用户没打算
 * 买的天数。所以字符串先过一道「十进制整数」的形状，数字则必须本身就是整数。
 */
export function parseRentDays(raw: unknown): number | null {
  const n =
    typeof raw === 'number'
      ? raw
      : typeof raw === 'string' && /^\s*\d+\s*$/.test(raw)
        ? Number(raw)
        : NaN;
  return isRentDaysInRange(n) ? n : null;
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
