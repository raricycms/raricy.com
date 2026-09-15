// ─────────────────────────────────────────────────────────────────────────────
// sticker-service.ts — 表情包素材的扫盘 / manifest / 查找（**server-only**）
//
// 【目录结构】instance/stickers/<合集>/<表情>.{gif,webp,png,jpg,jpeg}
//
// 与 instance/stories/<合集>/<故事>.md 是同一套「合集目录」约定，扫盘规则也对齐
// story-service.ts 的 getCollection()：每个合集目录可放一个 info.json，
//   · title    面板上显示的合集名（缺省 = 目录名）
//   · priority 合集排序，降序（缺省 0）
//   · ignore   true → 整集合隐藏
// 跳过 `.`/`_` 开头的文件、Thumbs.db、__pycache__、以及非图片扩展名。**不递归**：
// token 语法 `[@合集/表情]` 只有两级，扫盘能力与语法能力严格对齐，不多不少。
//
// 【为什么要缓存，而 story-service 不缓存】故事是整页 SSR，一页扫一次盘；表情的
// raw 路由是**每张图一个请求**（一屏聊天 30 张 = 30 次请求）。不缓存就是 30 次
// readdir。三层：
//   1. TTL（5s）内直接返回缓存 —— 一屏表情只扫一次
//   2. TTL 过了但目录时间戳没变 → 只重算时间戳（root 一次 readdir + 每个合集一次
//      stat），不重建 map。这是绝大多数请求走的路径
//   3. 时间戳变了 → 全量重扫
//   4. **兜底**：距上次全扫 > 60s 无条件重扫。Windows 的 8.3 短名缓存会在重命名时
//      产生「隧道」效应，目录 mtime 有极小概率不更新 —— 只靠 mtime 的话新加的表情
//      会**永远看不见，且看起来毫无原因**。有兜底全扫，最坏是「新表情最多 60 秒后
//      出现」，且**任何时候都不需要重启进程**。
//
// ★ 关键性质：覆盖同名文件的内容**不需要任何失效** ★
// manifest 里只有名字 / 真实文件名 / MIME，字节是每次请求现读的。所以「把开心.gif
// 换成另一张图」立刻生效（剩下的只是浏览器 HTTP 缓存，见 raw 路由的 Cache-Control）。
// 时间戳只需要捕捉「增 / 删 / 改名」这三种。
// ─────────────────────────────────────────────────────────────────────────────

import fs from 'node:fs';
import path from 'node:path';
import { detectImageMime } from './image-upload';
import { stickerKey, stickerUrl } from './sticker-refs';

/** 素材目录：优先环境变量，否则回落到 ./instance/stickers（对齐 STORIES_DIR 的约定）。 */
function stickersRoot(): string {
  return process.env.STICKERS_DIR || path.resolve(process.cwd(), 'instance', 'stickers');
}

/** 单张表情的字节上限 —— 只是防御性的天花板，正常表情包远小于此。 */
export const MAX_STICKER_BYTES = 8 * 1024 * 1024;

const TTL_MS = 5_000;
const FULL_RESCAN_MS = 60_000;

/**
 * 同名多扩展名的固定优先级。
 *
 * 【为什么必须定】`开心.gif` 与 `开心.png` 同时存在时，服务哪个若取决于 readdir
 * 顺序，同一份素材在两台机器上就会表现不同（NTFS 上是字母序，但那是实现细节、
 * 不是契约）。定死一个顺序，行为才是确定的。
 */
const EXT_PRIORITY = ['gif', 'webp', 'png', 'jpg', 'jpeg'] as const;

const MIME_BY_EXT: Record<string, string> = {
  gif: 'image/gif',
  webp: 'image/webp',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
};

/**
 * raw 路由允许下发的真实类型 —— **不含 image/svg+xml**。
 *
 * 【为什么必须排除 SVG】表情目录**没有任何上游校验**（不像图床：上传时
 * verifyImageMime 验过字节并落库，raw 路由信的是库不是盘）。有人往目录里丢一个
 * `开心.svg`（内容是 `<svg onload=...>`），若按扩展名下发的实现会以
 * image/svg+xml 内联返回 = **同源存储型 XSS**。这条白名单是那条攻击路径的唯一闸门。
 */
export const ALLOWED_STICKER_MIME: ReadonlySet<string> = new Set(Object.values(MIME_BY_EXT));

export interface StickerEntry {
  /** 合集目录的**原始**名（磁盘上的真名，不是归一化后的键）。 */
  collection: string;
  /** 面板显示名（info.json 的 title，缺省 = 目录名）。 */
  collectionTitle: string;
  /** 表情名 = 文件名去扩展名（磁盘原始名）。 */
  name: string;
  /** 磁盘上的真实文件名（含真实大小写与扩展名）。 */
  file: string;
  /** 磁盘绝对路径。 */
  absPath: string;
  /** 合集目录绝对路径 —— raw 路由的 dirname 断言用。 */
  dir: string;
  /** 由**扩展名**推出的 MIME。注意这只是「声明」，raw 路由会按字节复核。 */
  mime: string;
}

export interface StickerCollection {
  key: string;
  title: string;
  priority: number;
  stickers: { name: string; url: string }[];
}

interface InternalEntry extends StickerEntry {
  /** 合集被 info.json 的 ignore 标为隐藏。 */
  ignored: boolean;
}

interface Manifest {
  byKey: Map<string, InternalEntry>;
  collections: StickerCollection[];
  /** 目录时间戳；null = 根目录不存在或读不了。 */
  stamp: string | null;
  /** 上次 TTL 检查的时刻。 */
  checkedAt: number;
  /** 上次**全量重扫**的时刻。 */
  fullScanAt: number;
}

let cache: Manifest | null = null;
/** 空素材只警告一次（模块级 flag）—— 每请求打一行日志会把日志刷爆。 */
let warnedEmpty = false;

/** 跳过 `.` / `_` 开头的名字，以及几个众所周知的操作系统垃圾文件。 */
function isSkippedName(name: string): boolean {
  return name.startsWith('.') || name.startsWith('_') || name === 'Thumbs.db' || name === '__pycache__';
}

/** 读 info.json（缺文件 / 坏 JSON / 无权限一律返回 {}，绝不抛）。 */
function readInfoJson(dir: string): Record<string, unknown> {
  try {
    const raw = fs.readFileSync(path.join(dir, 'info.json'), 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}

function num(v: unknown, fallback = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function bool(v: unknown): boolean {
  return v === true;
}

/**
 * 目录时间戳：root 自身 mtime + 每个合集目录的「名字:mtime」。
 *
 * 只 readdir root（合集数量是个位数）+ 每合集一次 stat，比全量扫盘便宜一个量级。
 */
function dirStamp(root: string): string | null {
  try {
    const rootStat = fs.statSync(root);
    if (!rootStat.isDirectory()) return null;
    const parts: string[] = [String(rootStat.mtimeMs)];
    for (const e of fs.readdirSync(root, { withFileTypes: true })) {
      if (!e.isDirectory() || isSkippedName(e.name)) continue;
      try {
        parts.push(`${e.name}:${fs.statSync(path.join(root, e.name)).mtimeMs}`);
      } catch {
        // 单个合集读不了不影响整体时间戳
      }
    }
    return parts.join('|');
  } catch {
    return null;
  }
}

/** 全量扫盘。任何一层失败都跳过该层，绝不抛（对齐 story-service 的设计原则）。 */
function fullScan(root: string): Manifest {
  const byKey = new Map<string, InternalEntry>();
  const collections: StickerCollection[] = [];
  let dirNames: string[] = [];

  try {
    dirNames = fs
      .readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !isSkippedName(e.name))
      .map((e) => e.name);
  } catch {
    dirNames = []; // 根目录不存在 = 没有素材，不是错误
  }

  for (const collection of dirNames) {
    const dir = path.join(root, collection);
    const info = readInfoJson(dir);
    const ignored = bool(info['ignore']);
    const title = str(info['title']) || collection;
    const priority = num(info['priority']);

    // 先按「去扩展名的基名」分组，再按固定优先级挑一个 —— 见 EXT_PRIORITY 的注释
    const byBase = new Map<string, string[]>(); // base → 该基名下的所有文件名
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isFile() || isSkippedName(e.name)) continue;
      const ext = path.extname(e.name).slice(1).toLowerCase();
      if (!(EXT_PRIORITY as readonly string[]).includes(ext)) continue;
      const base = e.name.slice(0, -(ext.length + 1));
      if (!base) continue;
      const list = byBase.get(base);
      if (list) list.push(e.name);
      else byBase.set(base, [e.name]);
    }

    const stickers: { name: string; url: string }[] = [];
    for (const [base, files] of byBase) {
      const rank = (f: string) =>
        (EXT_PRIORITY as readonly string[]).indexOf(path.extname(f).slice(1).toLowerCase());
      const file = files.sort((a, b) => rank(a) - rank(b))[0];
      const ext = path.extname(file).slice(1).toLowerCase();
      const mime = MIME_BY_EXT[ext];
      if (!mime) continue;

      const entry: InternalEntry = {
        collection,
        collectionTitle: title,
        name: base,
        file,
        absPath: path.join(dir, file),
        dir,
        mime,
        ignored,
      };
      // 键做 NFC 归一化（见 sticker-refs.ts 的 stickerKey）；同键碰撞时先到先得 ——
      // 只在「两个文件仅差归一化形式」时发生，属于站长的命名失误，不覆盖已注册的。
      const key = stickerKey(collection, base);
      if (!byKey.has(key)) byKey.set(key, entry);
      // 走 stickerUrl()，不自己拼 —— 前端拼 token、后端拼 URL 必须只有一处口径
      if (!ignored) stickers.push({ name: base, url: stickerUrl(collection, base) });
    }

    if (!ignored && stickers.length > 0) {
      stickers.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      collections.push({ key: collection, title, priority, stickers });
    }
  }

  // priority 降序，其次显示名升序（与 story-service 的稳定排序同思路）
  collections.sort((a, b) => {
    if (a.priority !== b.priority) return b.priority - a.priority;
    return a.title.toLowerCase() < b.title.toLowerCase() ? -1 : 1;
  });

  return { byKey, collections, stamp: dirStamp(root), checkedAt: Date.now(), fullScanAt: Date.now() };
}

function getManifest(): Manifest {
  const root = stickersRoot();
  const now = Date.now();

  if (cache && now - cache.checkedAt < TTL_MS) return cache;

  if (cache && now - cache.fullScanAt < FULL_RESCAN_MS) {
    const stamp = dirStamp(root);
    // stamp 为 null = 根目录读不了；此时不信任缓存，走全量重扫（会得到空 manifest）
    if (stamp !== null && stamp === cache.stamp) {
      cache.checkedAt = now;
      return cache;
    }
  }

  cache = fullScan(root);

  if (!warnedEmpty && cache.byKey.size === 0) {
    warnedEmpty = true;
    // 部署最隐蔽的失败模式：素材没传到服务器 → 全站表情静默降级成字面量，
    // 没有任何报错。这里留一行，至少让日志里看得见。
    console.warn(
      `[sticker] 未发现任何表情素材（${root}）。` +
        '素材目录是 gitignored 的运行时数据，部署时需要手动同步。'
    );
  }

  return cache;
}

/**
 * 按 `[@合集/表情]` 的两段查一张表情，查不到返回 null。
 *
 * ★ 安全模型：collection / name **只当 map 的 key 用，永远不拼进路径** ★
 *
 * 这与 /api/images/[id]/raw 的「先查库、再按库里的值拼路径」是同一种模型：键不在
 * 表里就是 404，攻击者控制不了磁盘上的任何一个字节。具体堵的是 `%2F`——动态段里
 * 的编码斜杠在某些情况下会被解码进 params，若实现是 `path.join(dir, name)`，
 * `name = 'a/../../../etc/passwd'` 就出去了。查表天然免疫。
 *
 * ⚠️ 别为了「支持多级合集」把它优化成路径拼接 —— 那会重新打开这个洞。
 *
 * ignore 的合集**在这里也要拦**：只在列表接口过滤的话，「隐藏合集」不过是让它
 * 不出现在面板里，手打 `[@私密合集/xx]` 照样能把图取出来。
 */
export function resolveSticker(collection: string, name: string): StickerEntry | null {
  const hit = getManifest().byKey.get(stickerKey(collection, name));
  if (!hit || hit.ignored) return null;
  return hit;
}

/** 面板数据源：所有**未被 ignore** 的合集及其表情。 */
export function listStickerCollections(): StickerCollection[] {
  return getManifest().collections;
}

/**
 * 表情素材是否为空（根目录缺失或一张都没有）。
 * 供 /api/stickers 列表接口下发，让前端能显示一句「站长还没放表情」而不是空白面板。
 */
export function hasNoStickers(): boolean {
  return getManifest().byKey.size === 0;
}

/** 测试用：清掉模块级缓存，避免用例之间互相污染。 */
export function __resetStickerCacheForTests(): void {
  cache = null;
  warnedEmpty = true; // 测试里不要刷日志
}

export { detectImageMime };
