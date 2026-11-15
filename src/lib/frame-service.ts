// ─────────────────────────────────────────────────────────────────────────────
// frame-service.ts — 头像框素材域（扫盘 / 缓存 / 查表）+ 持有与装备 + 判定唯一出口（server-only）
// 【F1】唯一写入者：users.equipped_frame_key / equipped_frame_expires_at 只由 grantFrameTx /
//   grantFrame / revokeFrame / equipFrame 写；别的文件要改就加 …Tx 内核到本文件，渲染侧直读
//   原始列会被 tests/unit/frame-guard.test.ts 判红。
// 【F2】改持有行 expires_at（续期 / 失效）时若正戴着同一 key，必须同一事务刷新/清空
//   equipped_frame_expires_at；违反 = 续期后框永远不出现（渲染侧只读 users 的冗余列）。
// 【F3】equipFrame 要求 alive 持有行 && 未过期 && 白名单 && 未退役；素材缺失不阻止装备
//   （frameUrlFor 为 null 只是暂时不显示），卸下无条件成功（否则退役 key 卸不掉）。
// 【F4】唯一约束物理且含墓碑行：收回后再授予必须复活旧行（翻 deleted），不能新插；
//   写法照 favorite-service 的 attachItems（upsert，别用 createMany skipDuplicates）。
// 【F5】永不物删：到期只让行失效（deleted 仍 false），只有 revokeFrame 翻墓碑。
// 【判定唯一出口】resolveFrameKey（唯一比较运算）→ frameUrlFor（白名单/未退役/未过期/
//   有图，四道合一）→ DTO 生产者 / API / CLI 下发结果 → 客户端判零次（db-time-guard 规则
//   3–5 扫 src/）；frameUrlFor 固定用 nowForDb() 不收 now，resolveFrameKey 收 now 只为单测。
// 【素材域】public/static/frames/<key>.png 平铺、只认 PNG（透明通道；关掉按扩展名下发
//   SVG 内联的 XSS 路径）。key 权威是 frame-refs.FRAME_KEYS，目录只提供字节：多余文件不
//   收纳，缺席只让框不显示。白名单先于拼路径，path.dirname 是纵深防御。缓存 TTL 5s / mtime
//   / 全量重扫 + 60s 兜底（Windows 8.3 缓存可能不更新 mtime），只存 key 集合（覆盖同名内容
//   无需失效），本层不碰 prisma。
// ⚠️ 改 scripts/make-frame-demos.mjs 必须重跑并提交 manifest.json 与产物
//   （tests/unit/frame-assets.test.ts 核对 sha256）。
// 设计背景与取舍：docs/source-design-notes.md §1
// ─────────────────────────────────────────────────────────────────────────────

import fs from 'node:fs';
import path from 'node:path';
import { prisma } from './db';
import { nowForDb } from './db-time';
import { ymdhms } from './format';
import type { Prisma } from '@prisma/client';

/** 事务客户端 —— 只给 grantFrameTx 用（记账内核 postEntry 收的是同一个类型）。 */
type TxClient = Prisma.TransactionClient;
import {
  FRAME_KEYS,
  FRAMES,
  frameLabel,
  frameUrl,
  parseFrameKey,
  resolveFrameKey,
  type FrameDef,
  type FrameKey,
  type RentUnit,
} from './frame-refs';

/**
 * 素材目录：优先环境变量，否则回落到 ./public/static/frames（对齐 STICKERS_DIR 的约定）。
 *
 * ⚠️ 必须写成**函数**而不是顶层常量：测试会先设 process.env.FRAMES_DIR 再 import，
 * 顶层常量会把它烘死在模块加载那一刻，于是用例会去读真实的 public/static/frames。
 *
 * ⚠️ 素材**入库**，所以这个回落路径在任何环境里都该有东西。它空了只有两种可能：
 *    部署时 FRAMES_DIR 指到了别处，或 git 里那张图被删了 —— 两种都会让全站
 *    静默不显示框，而页面不报错（见 `docs/source-design-notes.md` §1 的「入库带出来的新失效」）。
 */
function framesRoot(): string {
  return process.env.FRAMES_DIR || path.resolve(process.cwd(), 'public', 'static', 'frames');
}

/** 单张框的字节上限 —— 只是防御性的天花板，正常框远小于此（几百 KB 顶天了）。 */
export const MAX_FRAME_BYTES = 4 * 1024 * 1024;

/** PNG 文件签名。 */
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * raw 路由允许下发的真实类型 —— **只有 PNG**。
 *
 * 【为什么这条白名单是必须的】框目录**没有任何上游校验**（不像图床：上传时
 * planImageUpload 按字节认过类型并落库，raw 路由信的是库不是盘）。有人往目录里丢一个
 * `demo.png`、内容却是 `<svg onload=...>`，若实现按扩展名下发的会以 image/svg+xml
 * 内联返回 = **同源存储型 XSS**。所以路由侧必须**按字节**复核 detectImageMime
 * 的结果再下发，而不是信文件名。
 *
 * ⚠️ **素材搬进 public/ 之后这道闸门更要紧，不是更松**：public/ 下的文件 Next 会
 *    自己静态托管一份（`/static/frames/<key>.png`），那条路**按扩展名给
 *    Content-Type**。所以「文件内容不是 PNG」这件事，应用侧只剩 `/api/frames/[key]`
 *    这一处能拦。别因为「素材入库了、有人 review」就把按字节复核改成信扩展名。
 *
 * 与 ALLOWED_STICKER_MIME 是同一道闸门，只是这里收得更紧（表情还允许 gif/webp/jpeg）。
 */
export const ALLOWED_FRAME_MIME: ReadonlySet<string> = new Set(['image/png']);

const TTL_MS = 5_000;
const FULL_RESCAN_MS = 60_000;

interface FrameAssets {
  /** 磁盘上**存在**的 key（且必须在白名单内 —— 目录里多出来的文件不入账）。 */
  available: Set<string>;
  /** 目录 mtimeMs；null = 目录不存在或读不了。 */
  stamp: number | null;
  /** 上次 TTL 检查的时刻。 */
  checkedAt: number;
  /** 上次**全量重扫**的时刻。 */
  fullScanAt: number;
}

let cache: FrameAssets | null = null;
/** 空素材只警告一次（模块级 flag）—— 每请求打一行日志会把日志刷爆。 */
let warnedEmpty = false;

/** 目录时间戳。平铺一层，所以 root 自己的 mtime 就够了（增/删/改名都会动它）。 */
function dirStamp(root: string): number | null {
  try {
    const st = fs.statSync(root);
    return st.isDirectory() ? st.mtimeMs : null;
  } catch {
    return null;
  }
}

/**
 * 全量扫盘。任何失败都降级成「没有素材」，绝不抛
 * （对齐 sticker-service / story-service 的设计原则：素材缺席不是错误）。
 */
function fullScan(root: string): FrameAssets {
  const available = new Set<string>();

  let names: string[] = [];
  try {
    names = fs.readdirSync(root);
  } catch {
    names = []; // 目录不存在 = 没有素材，不是错误
  }

  // 先排序再遍历：同名多扩展名（demo.png 与 demo.PNG）若取决于 readdir 顺序，
  // 同一份素材在两台机器上就会表现不同。定死一个顺序，行为才是确定的
  //（与 sticker-service 的 EXT_PRIORITY 同一个理由）。
  for (const name of [...names].sort()) {
    if (name.startsWith('.') || name.startsWith('_')) continue;
    if (path.extname(name).toLowerCase() !== '.png') continue;
    const key = name.slice(0, -4);
    // ★ 白名单是 key 空间的权威：目录里多出来的东西一律不认。
    //   这一条同时就是目录穿越的免疫 —— 白名单是手写的源码常量。
    if (!(FRAME_KEYS as readonly string[]).includes(key)) continue;
    available.add(key);
  }

  return {
    available,
    stamp: dirStamp(root),
    checkedAt: Date.now(),
    fullScanAt: Date.now(),
  };
}

function getAssets(): FrameAssets {
  const root = framesRoot();
  const now = Date.now();

  if (cache && now - cache.checkedAt < TTL_MS) return cache;

  if (cache && now - cache.fullScanAt < FULL_RESCAN_MS) {
    const stamp = dirStamp(root);
    // stamp 为 null = 目录读不了；此时不信任缓存，走全量重扫（会得到空集）
    if (stamp !== null && stamp === cache.stamp) {
      cache.checkedAt = now;
      return cache;
    }
  }

  cache = fullScan(root);

  if (!warnedEmpty && cache.available.size === 0) {
    warnedEmpty = true;
    // 部署最隐蔽的失败模式：全站头像框**静默不显示**，而「框不显示」与「没发过框」
    // 长得一模一样，没有任何报错。这里留一行，至少让日志里看得见。
    // ⚠️ 素材**入库**，所以「这个目录是空的」不再是正常状态 —— 多半是 FRAMES_DIR
    //    指到了别处，或者部署时漏了 public/static/frames/。运维侧的权威检查是
    //    `npm run cli -- frame list --keys`。
    console.warn(
      `[frame] 未发现任何头像框素材（${root}）。` +
        '素材随代码入库（public/static/frames/），这个目录为空说明部署时漏了它，' +
        '或者 FRAMES_DIR 指到了别处。'
    );
  }

  return cache;
}

/**
 * 某个 key 的素材在不在盘上。key 不在白名单里 → 恒 false。
 *
 * 这是「三道闸」里的第三道（白名单 → 未过期 → 盘上有图），由 frameUrlFor() 调用。
 */
export function frameAssetAvailable(key: string): boolean {
  return getAssets().available.has(key);
}

/**
 * 查一个 key 对应的素材文件绝对路径，供 raw 路由读字节。
 *
 * 返回 null 的三种情形都是 404，**不区分**：key 不在白名单、目录里没有这个文件、
 * 目录本身不存在。区分它们只会给出一个「哪些 key 存在」的探测面。
 */
export function resolveFrameAsset(key: string): { absPath: string; dir: string } | null {
  if (!(FRAME_KEYS as readonly string[]).includes(key)) return null;
  if (!frameAssetAvailable(key)) return null;

  const dir = framesRoot();
  const absPath = path.join(dir, `${key}.png`);
  return { absPath, dir };
}

/**
 * PNG 有没有透明通道。
 *
 * 【为什么需要它】这是唯一能自动发现「框素材中间不透明、会**盖住所有人的脸**」的
 * 手段 —— 那个错会让全站 15 处头像一起坏，而站长可能只在自己的主页看一眼。
 * 检查成本近乎零（只读文件头，不解码像素）。
 *
 * 【返回】`true` 有 / `false` 没有 / `null` 不是 PNG 或头不完整。
 *
 * 【判定依据】PNG 的 IHDR 块第 25 字节是颜色类型：
 *   0 灰度 · 2 真彩 · 3 调色板 · 4 灰度+alpha · 6 真彩+alpha
 * 4 / 6 直接带 alpha 通道；0 / 2 / 3 也可能**没有** alpha 通道，但可以用一个
 * `tRNS` 块声明「某一个颜色是透明的」，所以还要往后走块头找 tRNS。
 *
 * ⚠️ **这是弱检查，别把它当保证**。它只抓「导出时被压平了」（整个画布不透明），
 * 抓不到「透明区域画歪了 / 中心偏移了」。出图规格仍然要靠
 * `docs/guide/头像框使用指南.md` 里那份人工核对。
 */
export function pngHasAlpha(buf: Buffer): boolean | null {
  // 8 字节签名 + IHDR 至少到第 26 字节（颜色类型）
  if (buf.length < 26) return null;
  if (!buf.subarray(0, 8).equals(PNG_SIG)) return null;
  // IHDR 必须是第一个块 —— 不是的话这个文件的结构我们不认识，判不出来
  if (buf.subarray(12, 16).toString('latin1') !== 'IHDR') return null;

  const colorType = buf[25];
  if (colorType === 4 || colorType === 6) return true;

  // 找 tRNS：它若存在，必须在 IDAT 之前。块结构 = [4B 长度][4B 类型][数据][4B CRC]。
  // 长度是 uint32，所以 off 每轮至少前进 12 —— 不会死循环。
  let off = 8;
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.subarray(off + 4, off + 8).toString('latin1');
    if (type === 'tRNS') return true;
    if (type === 'IDAT' || type === 'IEND') break;
    off += 12 + len;
  }
  return false;
}

/** 单个框的素材体检结果。 */
export interface FrameAssetAudit {
  key: string;
  label: string;
  /** 盘上有没有这个文件。false = 白名单里有、网站上却没有这一款。 */
  available: boolean;
  /** 文件在但解析不出 PNG 结构 → null。 */
  hasAlpha: boolean | null;
  /** 文件大小（字节）；没文件时 null。 */
  bytes: number | null;
  /**
   * 鱼干商城的租金（单位 + 单价）；null = 不零售（只能由站长发放）/ 已退役 / 价配错了。
   * 单位的量词与单价口径在 `frame-refs.ts` 的 `RENT_UNITS`（展示侧现读，不在这份里抄）。
   */
  rent: { unit: RentUnit; price: number } | null;
  /**
   * 价配成了非正数（`rent: { price: 0 }` 这种「免费框」写法）。
   *
   * 商城把它当**不卖**（判据见 `frame-refs.ts` 的 frameSaleOf）—— 因为免费租借这条
   * 路根本不存在：记账内核拒收 0 单位，不判的话用户点一下就是 500。
   * 于是「配错了」与「故意不卖」在页面上长得一样，只有这里点名能区别开。
   */
  rentMisconfigured: boolean;
}

/**
 * 素材体检 —— 白名单里**每一个** key 的在盘状态。
 *
 * 【谁在用】`npm run cli -- frame list --keys` 与 /settings 的装备面板。
 * 这是运维唯一能发现「白名单里有这个框、盘上却没有图」的地方 —— 那种情况下
 * 全站静默不显示框，页面不报任何错。
 *
 * 白名单里的 key 是个位数，逐个读文件头不构成负担（CLI 里也只调用一次）。
 * 不设缓存：这是一条诊断路径，读到的必须是**此刻**的事实。
 */
export function auditFrameAssets(): FrameAssetAudit[] {
  const dir = framesRoot();
  return FRAME_KEYS.map((key) => {
    // frameLabel 对已知 key 恒有值（key 来自 FRAME_KEYS，是 FRAMES 的键集）
    const label = frameLabel(key) ?? key;
    // 租金与素材无关（那两件事的诊断价值不同：没图 = 全站静默不显示，
    // 没价 = 商城里不出现），所以先算好，三条 return 都带上。
    const def = FRAMES[key];
    const rawRent = def.retired ? null : (def.rent ?? null);
    // 非正数 = 配置有误：商城按「不卖」处理（见 frameSaleOf 的理由），这里也照实报成
    // 不零售，并把「配错了」单独标出来 —— 否则它与「故意不卖」在输出里长得一样。
    const rentMisconfigured = rawRent !== null && rawRent.price <= 0;
    const rent = rentMisconfigured ? null : rawRent;
    const abs = path.join(dir, `${key}.png`);
    if (!frameAssetAvailable(key)) {
      return { key, label, available: false, hasAlpha: null, bytes: null, rent, rentMisconfigured };
    }
    try {
      const buf = fs.readFileSync(abs);
      return {
        key,
        label,
        available: true,
        hasAlpha: pngHasAlpha(buf),
        bytes: buf.byteLength,
        rent,
        rentMisconfigured,
      };
    } catch {
      // 扫盘说有、读的时候没了（站长正在换文件）—— 当成没有，不抛
      return { key, label, available: false, hasAlpha: null, bytes: null, rent, rentMisconfigured };
    }
  });
}

/** 测试用：清掉模块级缓存，避免用例之间互相污染。 */
export function __resetFrameAssetCacheForTests(): void {
  cache = null;
  warnedEmpty = true; // 测试里不要刷日志
}

// ═══════════════════════════════════════════════════════════════════════════════
// 判定唯一出口
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * DTO 生产者手里的形状 —— 任何含这两列的 users 行（或其子集）都行。
 *
 * 两列都可选：调用方的 select 未必都取了它们，而「没取」与「是 null」在这里
 * 应当同解（都判成「没戴框」）。**刻意不给默认放行的语义** —— 缺字段就是没有。
 */
export interface FrameFields {
  equippedFrameKey?: string | null;
  equippedFrameExpiresAt?: Date | null;
}

/**
 * ★ 唯一的「这个用户现在该显示哪张框图」出口（同步）★
 *
 * 四道闸合一：白名单 → 未退役 → 未过期 → **盘上有素材**。返回 null = 不显示框。
 *
 * ⚠️ 时钟固定用 `nowForDb()`，**不接受 now 参数** —— 少一个传错的机会。
 *    拿真实 UTC 的 new Date() 去比会凭空多 8 小时（见 frame-refs.ts 文件头）。
 *
 * ⚠️ 第四道闸（盘上素材）在这里而不在 resolveFrameKey：素材在不在盘上是运维事实，
 *    只有本文件握着 fs。它判 null 的效果是「暂不显示」，而**授权与到期状态不受影响** ——
 *    站长补上素材后框立刻出现，不需要用户重新装备。
 */
export function frameUrlFor(u: FrameFields | null | undefined): string | null {
  if (!u) return null;
  const key = resolveFrameKey(u.equippedFrameKey, u.equippedFrameExpiresAt, nowForDb());
  if (!key) return null;
  if (!frameAssetAvailable(key)) return null;
  return frameUrl(key);
}

// ═══════════════════════════════════════════════════════════════════════════════
// 写路径（F1：users 那两列的唯一写入者）
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * 两个到期时刻取较晚者。`null` = 永久，而**永久是最大的** —— 所以任一端为 null
 * 结果就是 null（「只延长不缩短」的极端情形）。
 */
function laterExpiry(a: Date | null, b: Date | null): Date | null {
  if (a === null || b === null) return null;
  return a.getTime() >= b.getTime() ? a : b;
}

export type FrameGrantAction = 'created' | 'revived' | 'extended' | 'noop';

export type FrameGrantResult =
  | { ok: true; action: FrameGrantAction; expiresAt: Date | null; refreshedEquip: boolean }
  | { ok: false; code: 400 | 404; message: string };

export interface GrantFrameInput {
  userId: string;
  key: string;
  /** 绝对时刻；null = 永久。调用方按 nowForDb() 口径算好（`new Date(now.getTime() + n)`）。 */
  expiresAt: Date | null;
  /** 'purchase' 由鱼干商城那条路传（见 frame-shop-service）。 */
  source?: 'cli' | 'purchase' | 'system';
}

/**
 * ★ 授予内核：在**调用方给的事务**里授予 / 续期 ★
 *
 * `grantFrame` 是它的「自己开一个事务」薄壳；鱼干商城的购买路径直接用它 ——
 * 那里必须让「扣鱼干」与「发框」落在**同一个事务**里，而记账内核 `postEntry`
 * 要求调用方传 tx（见 fish-service.ts）。拆出这一层就是为了这个，
 * 而不是为了给外部多一个入口。
 *
 * 【授予 ≠ 装备】这里只写持有关系，用户自己去 /settings 选择戴不戴。
 *
 * 【幂等，且只延长不缩短】同一 (用户, 框) 已存在时取「原到期」与「新到期」的较晚者。
 * 想缩短或收回，用 revokeFrame。
 * ⚠️ **这条口径对「购买」是个陷阱**：买 3 天的正确语义是「在现有到期上加 3 天」，
 *    而不是「从现在起 3 天」。调用方算 `expiresAt` 时必须从**当前到期**起算，
 *    否则一个还剩 20 天的人买 3 天会走到 noop —— **扣了钱、什么都没拿到、不报错**。
 *    商城那条路的算法与其用例见 frame-shop-service.rentFrame。
 *
 * ⚠️ **墓碑行上的旧 expires_at 不参与取较晚**（见下面 `existing.deleted` 那一支）：
 *    那个值属于一次**已被收回**的授权。若参与，就会出现「曾经永久授权过 → 收回 →
 *    再授 30 天 → 仍是永久」这种荒唐结果。
 *
 * 【F2】若该用户此刻正戴着这个框，**同一事务里**刷新装备列的到期时刻。
 *
 * ⚠️ 调用方若在本函数**之前**已经写过东西（商城那一路先扣了鱼干），拿到
 *    `ok: false` 时**必须抛出去**让事务回滚 —— 返回错误对象在这里只意味着
 *    「本函数没写库」，不代表整个事务没写。
 */
export async function grantFrameTx(
  tx: TxClient,
  input: GrantFrameInput
): Promise<FrameGrantResult> {
  const { userId, expiresAt } = input;
  const source = input.source ?? 'cli';

  const key = parseFrameKey(input.key);
  if (!key) {
    return { ok: false, code: 400, message: `未知的头像框：${input.key}（合法值见 src/lib/frame-refs.ts 的 FRAME_KEYS）` };
  }
  // 退役框**不能再新授权**（R3-322）：已退役的框用户永远戴不上，发出去只会让
  // 「frame list 显示持有、equip 报已下架」这种半截状态出现。历史持有行不受影响
  //（parseFrameKey 仍认退役 key，收回 / 显示照常）。
  if (FRAMES[key].retired) {
    return { ok: false, code: 400, message: `「${frameLabel(key) ?? key}」已下架，不能再发放` };
  }

  const user = await tx.user.findUnique({ where: { id: userId }, select: { id: true } });
  if (!user) return { ok: false, code: 404, message: '用户不存在' };

  const now = nowForDb();

  const existing = await tx.userFrame.findUnique({
    where: { uq_user_frame: { userId, frameKey: key } },
    select: { expiresAt: true, deleted: true },
  });

  let action: FrameGrantAction;
  let next: Date | null;

  if (!existing) {
    action = 'created';
    next = expiresAt;
  } else if (existing.deleted) {
    // 复活墓碑行（F4）。**不与旧值取较晚** —— 那是上一次已被收回的授权。
    action = 'revived';
    next = expiresAt;
  } else if (existing.expiresAt === null) {
    // 已经是永久 —— 任何请求都改不了它（永久是最大的）
    next = null;
    action = 'noop';
  } else {
    // 「只延长不缩短」就落在这一句上：请求更短时 next 仍是原值 → noop
    next = laterExpiry(existing.expiresAt, expiresAt);
    action = (next === null || next.getTime() > existing.expiresAt.getTime())
      ? 'extended'
      : 'noop';
  }

  // upsert 而不是 create：唯一约束是物理的、含墓碑行，新插会撞约束。
  // 写法照 favorite-service 的 attachItems（那里记着 createMany({skipDuplicates})
  // 会静默变成 no-op 的教训 —— 这里是「点了没反应」的同一类问题）。
  await tx.userFrame.upsert({
    where: { uq_user_frame: { userId, frameKey: key } },
    create: { userId, frameKey: key, expiresAt: next, source, createdAt: now },
    update: { deleted: false, deletedAt: null, expiresAt: next, source },
  });

  // ── F2：正戴着这个框的话，装备列的到期时刻必须跟着走 ──────────────────
  const cur = await tx.user.findUnique({
    where: { id: userId },
    select: { equippedFrameKey: true },
  });
  let refreshedEquip = false;
  if (cur?.equippedFrameKey === key) {
    await tx.user.update({
      where: { id: userId },
      data: { equippedFrameExpiresAt: next },
    });
    refreshedEquip = true;
  }

  return { ok: true as const, action, expiresAt: next, refreshedEquip };
}

/**
 * 授予 / 续期一个头像框（自己开事务的薄壳）。CLI 与站长发放走这条。
 *
 * 事务体在 `grantFrameTx` 里 —— 那里同时是商城的原子性边界，见它的注释。
 */
export async function grantFrame(input: GrantFrameInput): Promise<FrameGrantResult> {
  try {
    return await prisma.$transaction((tx) => grantFrameTx(tx, input));
  } catch {
    // 事务里只有本地写，没有远端 HTTP —— 失败就是失败，不吞细节地编一个成功
    return { ok: false, code: 400, message: '授予失败，请重试' };
  }
}

export interface FrameRevokeResult {
  /** 是否真的翻了一个墓碑（false = 本来就没持有 / 已经收回过）。 */
  revoked: boolean;
  /** 是否顺带卸下了当前装备（他正戴着这个框）。 */
  unequipped: boolean;
}

/**
 * 收回一个头像框（翻墓碑 + 顺带卸下）。
 *
 * 【幂等】没持有过、或已经收回过的，照样返回 ok —— 反复执行没有副作用。
 * 【F5】翻 `deleted` 而不是物理删（全站口径）。
 * 【F2】若他正戴着这个框，**同一事务里**把两列装备指针清空。
 */
export async function revokeFrame(input: { userId: string; key: string }): Promise<FrameRevokeResult> {
  const key = parseFrameKey(input.key);
  if (!key) return { revoked: false, unequipped: false };

  const now = nowForDb();

  return prisma.$transaction(async (tx) => {
    const existing = await tx.userFrame.findUnique({
      where: { uq_user_frame: { userId: input.userId, frameKey: key } },
      select: { deleted: true },
    });
    if (!existing || existing.deleted) return { revoked: false, unequipped: false };

    await tx.userFrame.update({
      where: { uq_user_frame: { userId: input.userId, frameKey: key } },
      data: { deleted: true, deletedAt: now },
    });

    const cur = await tx.user.findUnique({
      where: { id: input.userId },
      select: { equippedFrameKey: true },
    });
    let unequipped = false;
    if (cur?.equippedFrameKey === key) {
      await tx.user.update({
        where: { id: input.userId },
        data: { equippedFrameKey: null, equippedFrameExpiresAt: null },
      });
      unequipped = true;
    }

    return { revoked: true, unequipped };
  });
}

export type FrameEquipResult =
  | { ok: true; key: FrameKey | null; expiresAt: Date | null }
  | { ok: false; code: 400 | 403; message: string };

/**
 * 装备 / 换框 / 卸下（`key === null`）。
 *
 * 【F3】装备前置：alive 持有行 && 未过期 && 白名单 && 未退役。
 *      **素材缺失不阻止装备** —— 先授权后传素材是合法顺序。
 * 【F3】卸下**无条件成功** —— 不看当前 key 合不合法、不看有没有持有行。
 *      否则一个退役的（或白名单里已删掉的）key 会变成卸不掉的僵尸装备。
 *
 * 幂等：重复装备同一个框是安全的（设置语义，不是累加）。
 */
export async function equipFrame(userId: string, rawKey: string | null): Promise<FrameEquipResult> {
  if (rawKey === null) {
    await prisma.user.update({
      where: { id: userId },
      data: { equippedFrameKey: null, equippedFrameExpiresAt: null },
    });
    return { ok: true, key: null, expiresAt: null };
  }

  const key = parseFrameKey(rawKey);
  if (!key) return { ok: false, code: 400, message: `未知的头像框：${rawKey}` };
  if (FRAMES[key].retired) {
    return { ok: false, code: 400, message: `「${frameLabel(key) ?? key}」已下架，不能装备` };
  }

  // 【一个事务】读持有行与写装备列副本必须原子（F2 的狭窄竞态）：两条独立语句之间
  // 若有人延长了同一款框（商城续租 / CLI 续期，都只延长不缩短），这里会把**旧的**
  // 到期时刻写进 `users.equipped_frame_expires_at` —— 框提前消失，而钱没丢
  //（持有行是延长后的）。收进事务后这个窗口不存在。
  return prisma.$transaction(async (tx) => {
    const row = await tx.userFrame.findUnique({
      where: { uq_user_frame: { userId, frameKey: key } },
      select: { expiresAt: true, deleted: true },
    });
    if (!row || row.deleted) return { ok: false, code: 403, message: '你还没有这个头像框' };

    // 复用唯一的比较（白名单与退役上面已判过，所以走到这里失败只可能是过期）
    if (!resolveFrameKey(key, row.expiresAt, nowForDb())) {
      return { ok: false, code: 403, message: '这个头像框已过期' };
    }

    await tx.user.update({
      where: { id: userId },
      // 装备列的到期时刻 = 那一刻持有行的到期时刻。此后两者由 F2 保持一致。
      data: { equippedFrameKey: key, equippedFrameExpiresAt: row.expiresAt },
    });
    return { ok: true as const, key, expiresAt: row.expiresAt };
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// 设置面板的数据源
// ═══════════════════════════════════════════════════════════════════════════════

export interface MyFrameRow {
  key: string;
  /** 显示名。key 若已不在白名单里（数据脏），退回 key 本身，**不编一个名字**。 */
  label: string;
  description: string;
  /** 站长把 `FRAMES[k].retired` 置了 true，或这个 key 已不在白名单里。 */
  retired: boolean;
  /** 盘上有没有素材。false = 白名单里有、网站上却缺图（运维自查用）。 */
  available: boolean;
  /** 判定后的贴图地址；null = 素材缺失 / 已过期 / 已下架。 */
  url: string | null;
  /** 展示用（`YYYY-MM-DD HH:MM:SS`，UTC+8 口径）；null = 永久。 */
  expiresAt: string | null;
  /** 已过期。**由服务端算好** —— 客户端不做任何时间比较（见文件头）。 */
  expired: boolean;
  equipped: boolean;
}

export interface MyFramesView {
  frames: MyFrameRow[];
  /**
   * 当前装备。`key` 是**原始值**（可能指向一个已过期 / 已下架 / 已不在白名单的框
   * —— 那些情况下 `active` 为 false，面板据此显示状态并提供「卸下」）。
   */
  equipped: {
    key: string;
    label: string;
    active: boolean;
    expiresAt: string | null;
  } | null;
}

/**
 * 「我持有的框」+ 当前装备 —— /settings 的装备面板与 `GET /api/users/me/frame` 的数据源。
 *
 * ★ 下发的是**判定后的结果**（`url` / `expired` / `active` 都由服务端算好），
 *   客户端一次都不做时间比较。见文件头的判定唯一出口。
 *
 * 只列 **alive** 的持有行 —— 收回过的不出现（与收藏夹列表同口径）。
 */
export async function listMyFrames(userId: string): Promise<MyFramesView> {
  const now = nowForDb();

  const [rows, user] = await Promise.all([
    prisma.userFrame.findMany({
      where: { userId, deleted: false },
      select: { frameKey: true, expiresAt: true },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.user.findUnique({
      where: { id: userId },
      select: { equippedFrameKey: true, equippedFrameExpiresAt: true },
    }),
  ]);

  const equippedKey = user?.equippedFrameKey ?? null;

  // 白名单顺序（FRAME_KEYS 即展示顺序），白名单外的 key 排在最后 —— 它们只会出现在
  // 「数据脏」的情形里，不该插在正常框中间。
  const rank = (k: string) => {
    const i = (FRAME_KEYS as readonly string[]).indexOf(k);
    return i === -1 ? FRAME_KEYS.length : i;
  };
  const sorted = [...rows].sort((a, b) => rank(a.frameKey) - rank(b.frameKey));

  const frames: MyFrameRow[] = sorted.map((r) => {
    // 白名单外的 key（数据脏）查不到定义 → 当作已下架处理，面板仍能显示它并让用户卸下
    const def = (FRAMES as Record<string, FrameDef | undefined>)[r.frameKey];
    const retired = !def || def.retired === true;
    const effective = resolveFrameKey(r.frameKey, r.expiresAt, now);
    return {
      key: r.frameKey,
      label: frameLabel(r.frameKey) ?? r.frameKey,
      description: def?.description ?? '',
      retired,
      available: frameAssetAvailable(r.frameKey),
      // 复用唯一出口：四道闸与渲染侧完全一致，面板上的预览不可能与真实显示不一致
      url: effective ? frameUrlFor({ equippedFrameKey: r.frameKey, equippedFrameExpiresAt: r.expiresAt }) : null,
      expiresAt: ymdhms(r.expiresAt),
      // retired 为假时 resolveFrameKey 失败只可能是过期（白名单过了，退役也过了）
      expired: !retired && effective === null,
      equipped: equippedKey === r.frameKey,
    };
  });

  const equipped = equippedKey
    ? {
        key: equippedKey,
        label: frameLabel(equippedKey) ?? equippedKey,
        // 「真的显示着吗」—— 同 frameUrlFor 的判定，只是不看素材那一道闸
        //（素材缺失时框显示不出来，但装备状态本身是有效的，面板该照实说）。
        active: resolveFrameKey(equippedKey, user?.equippedFrameExpiresAt ?? null, now) !== null,
        expiresAt: ymdhms(user?.equippedFrameExpiresAt ?? null),
      }
    : null;

  return { frames, equipped };
}
