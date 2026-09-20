// ─────────────────────────────────────────────────────────────────────────────
// frame-service.ts — 头像框的**素材域**（扫盘 / 缓存 / 查表）· server-only
//
// 【目录结构】instance/frames/<key>.png —— **是平铺的一层，没有子目录**，
// 且**只认 PNG**。与 instance/stickers/<合集>/<表情>.{gif,webp,png,jpg,jpeg} 不同：
// 框只有十几二十个、没有「合集」这一层，多一层目录只是多一份要维护的约定。
//
// 【只认 PNG 是硬要求，不是偷懒】头像框靠**透明通道**工作 —— 中间那块必须透出下面的
// 头像。JPEG 没有 alpha，GIF 的 1 位透明度边缘全是锯齿。收窄到 PNG 顺带把
// 「按扩展名下发的实现会以 image/svg+xml 内联返回」这条同源存储型 XSS 路径
// 关在外面（详见下面 ALLOWED_FRAME_MIME）。
//
// ── 【与表情包最关键的差别：key 空间不在目录里】──────────────────────────────
// 表情是「目录即 key 空间」——往 instance/stickers/ 丢什么就有什么。
// 框**不是**：key 的权威是 src/lib/frame-refs.ts 的 FRAME_KEYS（代码白名单），
// 目录只提供**字节**。所以：
//   · 目录里多出来的文件（手滑拷进来的 psd、备份文件）**一律不被收编**；
//   · 目录缺席只让框**不显示**（第三道闸判成「暂时没图」），不会让框不存在 ——
//     授权、展示名、价格照常，缺的只是那张图。
//
// 【这一层的安全模型】与 resolveSticker 同源：**key 先过白名单，才谈得上拼路径**。
// 白名单是手写的源码常量，所以「攻击者控制了一个 key」这件事本身不可能发生；
// `path.dirname` 断言是纵深防御（防将来有人把白名单改成从别处读）。
//
// ── 【为什么要缓存】──────────────────────────────────────────────────────────
// raw 路由是**每张图一个请求**（一屏讨论 30 个头像 = 30 次请求）。不缓存就是 30 次
// readdir。三层，与 sticker-service 逐条同构：
//   1. TTL（5s）内直接返回缓存
//   2. TTL 过了但目录 mtime 没变 → 只重算时间戳，不重建 set
//   3. 变了 → 全量重扫
//   4. **兜底**：距上次全扫 > 60s 无条件重扫。Windows 的 8.3 短名缓存会在重命名时
//      产生「隧道」效应，目录 mtime 有极小概率不更新 —— 只靠 mtime 的话新加的框
//      会**永远看不见，且看起来毫无原因**。有兜底全扫，最坏是「新框最多 60 秒后
//      出现」，且**任何时候都不需要重启进程**。
//
// ★ 关键性质：覆盖同名文件的内容**不需要任何失效** ★
// 缓存里只有 key 的集合，字节是每次请求现读的。所以「把 demo.png 换成另一张图」
// 立刻生效（剩下的只是浏览器 HTTP 缓存，见 raw 路由的 Cache-Control）。
// 时间戳只需要捕捉「增 / 删 / 改名」这三种。
//
// ⚠️ 本文件**不做**到期判定、不碰 prisma（那是 frame-service 的后半部分）。
//    它只回答「某个 key 在盘上有没有图」，而这个问题与「谁在戴」无关。
// ─────────────────────────────────────────────────────────────────────────────

import fs from 'node:fs';
import path from 'node:path';
import { FRAME_KEYS, frameLabel } from './frame-refs';

/**
 * 素材目录：优先环境变量，否则回落到 ./instance/frames（对齐 STICKERS_DIR 的约定）。
 *
 * ⚠️ 必须写成**函数**而不是顶层常量：测试会先设 process.env.FRAMES_DIR 再 import，
 * 顶层常量会把它烘死在模块加载那一刻，于是用例会去读真实的 instance/frames。
 */
function framesRoot(): string {
  return process.env.FRAMES_DIR || path.resolve(process.cwd(), 'instance', 'frames');
}

/** 单张框的字节上限 —— 只是防御性的天花板，正常框远小于此（几百 KB 顶天了）。 */
export const MAX_FRAME_BYTES = 4 * 1024 * 1024;

/** PNG 文件签名。 */
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * raw 路由允许下发的真实类型 —— **只有 PNG**。
 *
 * 【为什么这条白名单是必须的】框目录**没有任何上游校验**（不像图床：上传时
 * verifyImageMime 验过字节并落库，raw 路由信的是库不是盘）。有人往目录里丢一个
 * `demo.png`、内容却是 `<svg onload=...>`，若实现按扩展名下发的会以 image/svg+xml
 * 内联返回 = **同源存储型 XSS**。所以路由侧必须**按字节**复核 detectImageMime
 * 的结果再下发，而不是信文件名。
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
    // 部署最隐蔽的失败模式：素材没传到服务器 → 全站头像框**静默不显示**，
    // 而「框不显示」与「没发过框」长得一模一样，没有任何报错。这里留一行，
    // 至少让日志里看得见。运维侧的权威检查是 `npm run cli -- frame list --keys`。
    console.warn(
      `[frame] 未发现任何头像框素材（${root}）。` +
        '素材目录是 gitignored 的运行时数据，部署时需要手动同步。'
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
    const abs = path.join(dir, `${key}.png`);
    if (!frameAssetAvailable(key)) {
      return { key, label, available: false, hasAlpha: null, bytes: null };
    }
    try {
      const buf = fs.readFileSync(abs);
      return { key, label, available: true, hasAlpha: pngHasAlpha(buf), bytes: buf.byteLength };
    } catch {
      // 扫盘说有、读的时候没了（站长正在换文件）—— 当成没有，不抛
      return { key, label, available: false, hasAlpha: null, bytes: null };
    }
  });
}

/** 测试用：清掉模块级缓存，避免用例之间互相污染。 */
export function __resetFrameAssetCacheForTests(): void {
  cache = null;
  warnedEmpty = true; // 测试里不要刷日志
}
