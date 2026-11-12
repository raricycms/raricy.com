// ─────────────────────────────────────────────────────────────────────────────
// frame-refs.ts — 头像框的**词汇表**（白名单、解析、人话标签、到期判定）
// 头像框 = 带透明通道的 PNG 叠在头像上（Avatar.tsx 的 .avatar__frame）；素材在 public/static/
// frames/<key>.png（随代码入库）；扫盘与字节路由在 frame-service.ts（server-only）。
// 【key 空间】FRAME_KEYS 是权威，目录只提供字节（与表情「目录即 key 空间」相反）：
//   多余文件不收纳；目录缺席只让框不显示，不会让框不存在（授权 / 价格 / 展示名照常）。
// 【改这里的代价】加框 = FRAMES 加一条 + 一张 PNG（改 make-frame-demos.mjs 的 SVG 后重跑）。
//   FRAMES 是 Record<FrameKey, FrameDef>，漏补条目 tsc 报错；无需迁移（user_frames.frame_key
//   是文本、不是外键，框定义不住库）。
// 【到期判定：全仓只有这里做比较】isFrameExpired 只被 resolveFrameKey 调，后者只被
//   frameUrlFor 调（下发 DTO 的唯一出口）；漏判 = 那一处永远戴着框、不报错。客户端判零次
//   （db-time-guard 规则 3–5 扫 src/ 含页面组件，写 new Date(expires_at) 会被判红）。
// 【时钟】expires_at 由 nowForDb() 写（UTC+8 墙上时间贴 Z），比较必须同一把钟；本文件纯函数、
//   不读时钟，now 由调用方给（服务端唯一调用传 nowForDb()）。拿真实 UTC 比会凭空多 8 小时。
// 【边界口径】expires_at === null → 永久，不过期；now === expiresAt → 未过期（用 > 不是 >=）。
// 本文件不碰 Node / React / prisma，可直接单测（tests/unit/frame-refs.test.ts）。
// 设计背景与取舍：docs/source-design-notes.md §2
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 全部头像框的 key，**这个顺序就是展示顺序**（别打乱 —— 设置面板与 CLI 的选项
 * 都按它排）。与 `blog-visibility.ts` 的 `BLOG_VISIBILITIES` 同款：数组即顺序，
 * 不另设 order 字段（两处维护会漂）。
 *
 * ⚠️ 每一项都要有对应的 `public/static/frames/<key>.png`。缺素材时框**静默不显示**
 * （页面不报错）—— 自查用 `npm run cli -- frame list --keys`。
 * **素材随代码入库**，但来源可以不同：前六款由 `node scripts/make-frame-demos.mjs`
 * 生成（出图规格的活文档）—— 改了那个脚本就得重跑并把 public/static/frames/
 * 一起提交，否则站点继续显示旧图（tests/unit/frame-assets.test.ts 盯着这件事）；
 * `starmoon` 是**手画**的（直接拷一张 PNG 进目录），不在那个脚本与 manifest.json 里 ——
 * 指南 §2 明说这条路合法，frame-assets 那条守卫也只管脚本生成的那些。
 *
 * ⚠️ **退役一个框时把 `FRAMES[k].retired` 置 true，不要从这里删掉 key。**
 *   删了之后：`parseFrameKey` 认不出它 → 设置面板没法显示那一行 → 用户**卸不掉**
 *   一个已经退役的框（见 `docs/architecture.md` §6.14 的风险节）。
 *   保留 key 的代价只是一行数组元素。
 */
export const FRAME_KEYS = [
  'ring',
  'gradient',
  'glow',
  'corner',
  'dashed',
  'fishblue',
  'starmoon',
] as const;

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
   * 鱼干商城的租金：**单位 + 单价**（`价格 鱼干 / 单位`）。省略 = 不零售，
   * 只能由站长发放。
   *
   * 【为什么价格住这里而不是库】与 `label` 同一个理由（见 `docs/source-design-notes.md` §2）：商城面板是
   * 客户端组件，而 `frame-service` 拖着 prisma 进不了客户端包 —— 价格若住在那边，
   * 前端就只能手抄一份，而手抄的那份会在改价时静默对不上（页面显示 1 鱼干、
   * 服务端扣 2 条）。放这里，**展示与校验读的是同一个数**。
   *
   * 【为什么是「单位 + 单价」而不是两个字段】按天与按月的两款框共存（鱼干蓝
   * 1 鱼干/天、星落月畔 50 鱼干/月）。写成 `rentPerDay` + `rentPerMonth` 两个可选
   * 字段的话，「两个都配了」与「两个都没配」在类型上完全合法 —— 前者没有报错、
   * 只有一个会生效，正是本仓库最忌讳的静默歧义。单位收进一个字段就没有这种状态。
   *
   * ⚠️ 改这个数 = 改全站定价。`docs/guide/头像框使用指南.md` 与 `docs/cli.md`
   *    （`frame list --keys` 的输出样例）复述了它，要同步。
   * ⚠️ 退役一款框（`retired: true`）会**同时下架**它在商城的在售行 ——
   *    `rentableFrameKeys()` 两件事一起判，不会出现「已下架却还能买」。
   */
  rent?: { unit: RentUnit; price: number };
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
    rent: { unit: 'day', price: 1 },
  },
  starmoon: {
    label: '星落月畔',
    description: '金 → 蓝的渐变环，左上与右下各有一位角色，环上散着星点。缩到 20px 时只剩金蓝两色的环。',
    // 唯一按月卖的一款（50 鱼干 / 月）。按月而不是按天是**定价**：50 摊到 30 天
    // 是 1.6667，除得尽的天数没几个，剩下的全会在 fishToUnits 的 4 位小数闸上抛错。
    rent: { unit: 'month', price: 50 },
  },
};

/** 头像框字节路由的路由前缀。 */
export const FRAME_URL_PREFIX = '/api/frames/';

/**
 * 解析提交上来的 frame key：**已登记**就返回 key，退役与否不在这一步判。
 *
 * 非白名单值（含 `undefined` / `null` / 空串）一律 **null**，由调用方报 400 ——
 * **不静默丢弃**。这里**没有**像 `parseVisibility` 那样的缺省值：可见性有
 * 「最安全的那一档」可以兜，而 frame key 没有安全默认值（兜成任何一个 key 都等于
 * 替用户做了个他没做的决定）。
 *
 * 【为什么退役 key 也返回】它是「这个 key 存不存在」的解析器，不是「能不能新授权」
 * 的闸门。保留退役 key 的解析是**历史持有可读**的前提：
 *   · `revokeFrame` / CLI `frame revoke` 必须还能收回一款已退役的框（否则用户摘不掉）；
 *   · `equipFrame` 要靠它给出「已下架，不能装备」这句专属文案（而不是「未知的头像框」）；
 *   · 设置面板要靠它把已退役的持有行渲染出来（见文件头「退役一个框时别删 key」）。
 * 写路径各自判 `FRAMES[key].retired`：`equipFrame`（拒装备）、`rentFrame`（不在售）、
 * `grantFrameTx`（拒新授权）—— **不要**把所有语义都塞进这个纯解析函数。
 */
export function parseFrameKey(raw: unknown): FrameKey | null {
  if (typeof raw !== 'string' || raw === '') return null;
  return (FRAME_KEYS as readonly string[]).includes(raw) ? (raw as FrameKey) : null;
}

/**
 * key → 显示名。**未知 key 返回 null**，退役的 key 照常返回名字。
 *
 * 与 `parseFrameKey` 的分工：那个是「是不是一个已登记的 key」（退役也认，历史行要
 * 显示/收回）；「能不能新授权 / 装备」由各写路径自己判 `retired`。退役了也要说得出
 * 它叫什么，否则设置面板只能显示一行 `unknown-frame-3`。
 */
export function frameLabel(key: string): string | null {
  return (FRAMES as Record<string, FrameDef | undefined>)[key]?.label ?? null;
}

/** 头像框贴图地址。key 已由白名单约束（标识符形状），无需编码。 */
export function frameUrl(key: FrameKey): string {
  return `${FRAME_URL_PREFIX}${key}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// 鱼干商城的**租赁词汇**（计价单位、价格、上下限、在架清单）
//
// 这一节是纯函数，服务端与客户端读的是**同一份**：服务端拿它校验与算钱，
// 商城面板拿它渲染价格与置灰按钮。两边各写一份的后果不是报错，是
// 「页面显示 1 鱼干、服务端扣 2 条」—— 而用户只会觉得账不对。
//
// ── 【两种计价单位】──────────────────────────────────────────────────────────
// 一款框按**天**卖（鱼干蓝：1 鱼干 / 天，1–30 天），另一款按**月**卖
// （星落月畔：50 鱼干 / 月，1–12 个月）。单位住在下面那张表里、**每款框自己选**。
// 之所以不把月租摊成「1.6667 鱼干 / 天」：50 ÷ 30 除不尽，摊出来的单价乘上多数
// 天数都过不了 `fishToUnits` 的 4 位小数闸（7 天 → 116666.6667 单位 → 抛错 → 400），
// 只有 3 的倍数那几天能用 —— 一个「大部分天数点下去就报错」的框。
//
// ⚠️ **一个月固定 30 天**，不按自然月算（「2 月买一个月只得 28 天」是另一套口径，
//    本站不引入）。到期时刻与页面文案都读 `RENT_UNITS[unit].days`，**别在别处写死 30**。
// ─────────────────────────────────────────────────────────────────────────────

// 兼容原有头像框调用点，租期权威已抽到商城共享词汇，不复制单位或区间。
// 这里只转导出**确实仍有人从这里 import** 的三个符号（RENT_UNITS / parseRentCount /
// RentUnit）—— 其余租期词汇一律直接从 `shop-refs` 取，别再往这里加。
import { isRentCountInRange, type RentUnit } from './shop-refs';
export { RENT_UNITS, parseRentCount } from './shop-refs';
export type { RentUnit } from './shop-refs';

/**
 * 一款框**能卖的价**（单位 + 单价）；null = 不卖。
 *
 * 判据两条，缺一不可：配了一个**正数**价，且未退役。商城在架清单与算钱都走这一个
 * 出口 —— 别在调用方另写一份「有没有价格」的判断，两份判断迟早会对不上。
 *
 * ⚠️ 为什么非正数也算「不卖」而不是「免费」：`rent: { price: 0 }` 是最容易写出来的
 *    「免费框」，而免费租借这条路根本不存在 —— 记账内核拒收 0 单位（`postEntry`
 *    抛普通 Error），于是**用户点一下就是 500**，而页面上还写着「合计 0 鱼干、
 *    按钮可点」。判成「不卖」之后：商城不列它、接口回 400 点名去问站长，
 *    运维在 `frame list --keys` 与 `npm run diagnose` 里看得到那条警告。
 *    真要免费送，走 `npm run cli -- frame grant`（那里不经过鱼干）。
 *
 * ⚠️ 别漏 `retired` 那一半：漏了就是「已下架的框还能买到」—— 鱼干照扣、持有行
 *    照建，但戴上不显示（`resolveFrameKey` 到期之前先判退役），看起来像素材丢了。
 */
export function frameSaleOf(key: FrameKey): { unit: RentUnit; price: number } | null {
  const def = FRAMES[key];
  if (def.retired) return null;
  const rent = def.rent;
  return rent && rent.price > 0 ? rent : null;
}

/** 在售的框 —— 商城的**唯一**在架清单，按 `FRAME_KEYS` 顺序陈列。 */
export function rentableFrameKeys(): FrameKey[] {
  return FRAME_KEYS.filter((k) => frameSaleOf(k) !== null);
}

/**
 * 一款框租 `count` 个单位的**总价**（鱼干）。**不可租 / 单位数越界一律 null**。
 *
 * 与 `parseRentCount` 的分工照 `parseFrameKey` / `frameLabel` 那一对：
 * 这个回答「要收多少钱」，那个回答「这个数本身合法吗」。
 *
 * 乘积不四舍五入：单位数恒是整数，单价配的是整数（1 / 50），所以总价恒为整数。
 * 真要配小数单价，请自己确认它在 `count` 的整个合法区间里都不超过 4 位小数 ——
 * 越过了会在 `fishToUnits` 那一步抛错（接口回 400「租金精度超出支持范围」）。
 */
export function frameRentCost(key: string, count: number): number | null {
  const k = parseFrameKey(key);
  if (!k) return null;
  const sale = frameSaleOf(k);
  if (!sale || !isRentCountInRange(sale.unit, count)) return null;
  return sale.price * count;
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
