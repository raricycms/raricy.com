// frame-service.ts —— 头像框的**素材域**（扫盘 / 缓存 / 查表 / PNG 体检）。
//
// 【为什么值得重点测】
//  1. **key 空间在白名单里，不在目录里** —— 这条与表情包相反，是本模块最容易
//     被「顺手改成扫盘即所得」的地方。改成那样之后，往目录里丢一个任意名字的
//     PNG 就成了一个可用的框，而**没有任何别的测试会红**。
//  2. **目录穿越免疫**：白名单是手写的源码常量，所以「key 先过白名单，才谈得上
//     拼路径」这条就是全部的防线。它一旦被改成直接 path.join，洞就开了。
//  3. **pngHasAlpha 是唯一能自动发现「框会盖住脸」的手段** —— 它读错了不会报错，
//     只会让全站 15 处头像一起被一张不透明的图盖住。
//  4. **缓存三层**：层与层之间的边界（TTL / mtime / 60s 兜底）写错了症状都是
//     「新加的框永远看不见」，而那看起来毫无原因。
//
// 【磁盘安全】只碰 tests/.tmp/frames-test/，绝不碰 ./instance/frames 里的真实素材
// —— 见下方 TEST_FRAMES_DIR 与 assertTempDir()。

import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from 'vitest';

// ⚠️ 必须在 import frame-service 之前设好 —— framesRoot() 是**函数**（每次读 env），
// 所以这里其实只要在第一次调用前设上就够；但放在最前面读起来最不容易误解。
const TEST_FRAMES_DIR = path.resolve(import.meta.dirname, '../.tmp/frames-test');
process.env.FRAMES_DIR = TEST_FRAMES_DIR;

import {
  ALLOWED_FRAME_MIME,
  MAX_FRAME_BYTES,
  __resetFrameAssetCacheForTests,
  auditFrameAssets,
  equipFrame,
  frameAssetAvailable,
  frameUrlFor,
  frameUrlOfUser,
  grantFrame,
  listMyFrames,
  pngHasAlpha,
  resolveFrameAsset,
  revokeFrame,
} from '@/lib/frame-service';
import { FRAME_KEYS } from '@/lib/frame-refs';
import { prisma } from '@/lib/db';
import { nowForDb } from '@/lib/db-time';
import { makeUser, resetDb } from '../helpers/db';

/** 硬校验：素材目录必须在 tests/.tmp/ 下，否则直接抛（防止误动真实素材）。 */
function assertTempDir() {
  if (!TEST_FRAMES_DIR.includes(`${path.sep}tests${path.sep}.tmp${path.sep}`)) {
    throw new Error(`拒绝在非临时目录上跑头像框用例：${TEST_FRAMES_DIR}`);
  }
}

/** 白名单里的第一个 key —— 素材文件名就用它。 */
const KEY = FRAME_KEYS[0];

// ── 最小合法 PNG 字节 ───────────────────────────────────────────────────────
//
// pngHasAlpha 只解析文件头与块结构，不需要真能解码的像素数据。

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  return Buffer.concat([len, Buffer.from(type, 'latin1'), data, Buffer.alloc(4)]);
}

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * 造一个结构合法（能过 pngHasAlpha 的解析）的 PNG 头。
 * @param colorType 0 灰度 / 2 真彩 / 3 调色板 / 4 灰度+alpha / 6 真彩+alpha
 */
function png(colorType: number, opts: { trns?: boolean } = {}): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0); // width
  ihdr.writeUInt32BE(1, 4); // height
  ihdr[8] = 8; // bit depth
  ihdr[9] = colorType; // color type
  const parts = [PNG_SIG, chunk('IHDR', ihdr)];
  if (opts.trns) parts.push(chunk('tRNS', Buffer.alloc(6)));
  parts.push(chunk('IDAT', Buffer.alloc(0)), chunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(parts);
}

/** 内容根本不是 PNG 的文件 —— 用来验证「扩展名只是声明」。 */
const SVG_BYTES = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>');
const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]);

function writeAsset(name: string, data: Buffer | string) {
  fs.mkdirSync(TEST_FRAMES_DIR, { recursive: true });
  fs.writeFileSync(path.join(TEST_FRAMES_DIR, name), data);
}

function clearDir() {
  fs.rmSync(TEST_FRAMES_DIR, { recursive: true, force: true });
}

beforeAll(() => {
  assertTempDir();
  clearDir();
});

afterAll(() => {
  assertTempDir();
  clearDir();
});

beforeEach(() => {
  assertTempDir();
  fs.rmSync(TEST_FRAMES_DIR, { recursive: true, force: true });
  __resetFrameAssetCacheForTests();
});

afterEach(() => {
  vi.useRealTimers();
});

// ── 白名单即 key 空间 ───────────────────────────────────────────────────────

describe('素材查表：白名单是 key 空间的权威，目录只是字节仓库', () => {
  it('目录缺席不是错误 —— 一律 false，不抛', () => {
    expect(frameAssetAvailable(KEY)).toBe(false);
    expect(resolveFrameAsset(KEY)).toBeNull();
  });

  it('白名单内的 key + 盘上有图 → 命中', () => {
    writeAsset(`${KEY}.png`, png(6));
    __resetFrameAssetCacheForTests();
    expect(frameAssetAvailable(KEY)).toBe(true);
    expect(resolveFrameAsset(KEY)?.absPath).toBe(path.join(TEST_FRAMES_DIR, `${KEY}.png`));
  });

  it('★ 目录里多出来的文件一律不被收编（与表情包的「扫到什么有什么」相反）', () => {
    writeAsset('not-in-whitelist.png', png(6));
    writeAsset('另一个框.png', png(6));
    __resetFrameAssetCacheForTests();
    expect(frameAssetAvailable('not-in-whitelist')).toBe(false);
    expect(frameAssetAvailable('另一个框')).toBe(false);
    expect(resolveFrameAsset('not-in-whitelist')).toBeNull();
  });

  it('★ 非 .png 一律不认 —— 只认 PNG 是硬要求（JPEG 没 alpha、GIF 边缘锯齿）', () => {
    writeAsset(`${KEY}.jpg`, JPEG_BYTES);
    writeAsset(`${KEY}.svg`, SVG_BYTES);
    writeAsset(`${KEY}.webp`, Buffer.from('RIFF....WEBPVP8 ', 'latin1'));
    __resetFrameAssetCacheForTests();
    expect(frameAssetAvailable(KEY)).toBe(false);
  });

  it('.PNG 大写扩展名也认（Windows 上很常见）', () => {
    writeAsset(`${KEY}.PNG`, png(6));
    __resetFrameAssetCacheForTests();
    expect(frameAssetAvailable(KEY)).toBe(true);
  });

  it('`.` / `_` 开头的文件被跳过（编辑器临时文件、macOS 资源叉）', () => {
    writeAsset(`.${KEY}.png`, png(6));
    writeAsset(`_${KEY}.png`, png(6));
    __resetFrameAssetCacheForTests();
    expect(frameAssetAvailable(KEY)).toBe(false);
  });

  it('★ 目录穿越：key 直接就是路径片段时，白名单先把它挡掉', () => {
    // 白名单是手写常量，所以这类 key 根本进不了查表 —— 这正是免疫的来源。
    for (const evil of ['../users', '../../etc/passwd', '..%2F..%2Fetc', '/etc/passwd', 'a/b']) {
      expect(frameAssetAvailable(evil), evil).toBe(false);
      expect(resolveFrameAsset(evil), evil).toBeNull();
    }
  });
});

// ── 缓存三层 ────────────────────────────────────────────────────────────────

describe('扫盘缓存', () => {
  it('新加的素材会被看见（TTL 过后 mtime 变了 → 全量重扫）', () => {
    vi.useFakeTimers();
    __resetFrameAssetCacheForTests();

    expect(frameAssetAvailable(KEY)).toBe(false); // 第一次扫：空

    writeAsset(`${KEY}.png`, png(6));
    // ✗ 还没过 TTL：缓存原样返回。这条是**刻意**的（一屏 30 个头像只扫一次盘）。
    expect(frameAssetAvailable(KEY)).toBe(false);

    vi.advanceTimersByTime(6_000); // 越过 TTL_MS
    expect(frameAssetAvailable(KEY)).toBe(true);
  });

  it('★ 覆盖同名文件的内容不需要失效（缓存里只有 key 集合，字节每次现读）', () => {
    writeAsset(`${KEY}.png`, png(2)); // 不透明
    __resetFrameAssetCacheForTests();
    expect(frameAssetAvailable(KEY)).toBe(true);

    writeAsset(`${KEY}.png`, png(6)); // 换成带透明的
    // 不加任何失效：查表仍命中（这是对的），而读到的字节会是最新的 ——
    // 字节新鲜度是 raw 路由的职责，不是缓存的。
    expect(frameAssetAvailable(KEY)).toBe(true);
    expect(pngHasAlpha(fs.readFileSync(path.join(TEST_FRAMES_DIR, `${KEY}.png`)))).toBe(true);
  });

  it('删掉素材后，过期重扫会把它移出可用集', () => {
    vi.useFakeTimers();
    writeAsset(`${KEY}.png`, png(6));
    __resetFrameAssetCacheForTests();
    expect(frameAssetAvailable(KEY)).toBe(true);
    const stamp = fs.statSync(TEST_FRAMES_DIR).mtimeMs;

    fs.rmSync(path.join(TEST_FRAMES_DIR, `${KEY}.png`));
    // ⚠️ 显式把 mtime 推到一个**确定不同**的值，不要指望 rmSync 自己会改它 ——
    //    NTFS 的时间戳粒度下，mkdir 与 rm 落在同一刻度里时 mtime 可以**完全不变**，
    //    那样这条用例就会变成时序相关的抖动（本仓已实测）。代码本身是对的，
    //    抖动的是「依赖文件系统时间戳」这个假设。
    const bumped = stamp + 5_000;
    fs.utimesSync(TEST_FRAMES_DIR, new Date(bumped), new Date(bumped));
    expect(fs.statSync(TEST_FRAMES_DIR).mtimeMs).not.toBe(stamp);

    vi.advanceTimersByTime(6_000);
    expect(frameAssetAvailable(KEY)).toBe(false);
  });

  it('★ 距上次全扫超过 60s 无条件重扫 —— 即使目录 mtime 没变（Windows 隧道效应）', () => {
    vi.useFakeTimers();
    fs.mkdirSync(TEST_FRAMES_DIR, { recursive: true });
    // mtimeMs 带亚毫秒小数（实测 .4421 这样的值），而 utimesSync 只能写到整毫秒
    // —— 先把目录时间戳归整，后面才**能**精确地按回同一个值。不归整的话
    // 「还原 mtime」这一步会悄悄差 0.x 毫秒，缓存当场就认得出变化，隧道效应模拟不出来。
    const m0 = Math.floor(fs.statSync(TEST_FRAMES_DIR).mtimeMs);
    fs.utimesSync(TEST_FRAMES_DIR, new Date(m0), new Date(m0));
    // ⚠️ 「归整生效了」的判据是**幂等**，不是「值恰好等于 m0」。
    // 文件系统存的精度比毫秒细：utimesSync 写进去的整毫秒，读回来可能是 m0 - 0.001
    //（本机实测 ext4/overlay 上稳定给出 .999）。这条用例真正依赖的性质是
    //「同一个 m0 写两次 → 读出来同一个值」，所以就拿第一次读到的值当基准。
    // 拿整数去比会假红 —— 而且是**只在本机复现**的那种红（另一台机器上可能正好相等）。
    const settle = fs.statSync(TEST_FRAMES_DIR).mtimeMs;
    fs.utimesSync(TEST_FRAMES_DIR, new Date(m0), new Date(m0));
    expect(fs.statSync(TEST_FRAMES_DIR).mtimeMs, '同一个 m0 写两次必须稳定').toBe(settle);

    __resetFrameAssetCacheForTests();
    expect(frameAssetAvailable(KEY)).toBe(false); // 空目录，缓存记下这个时间戳

    writeAsset(`${KEY}.png`, png(6));
    // 强行把 mtime 按回 m0 —— 模拟 Windows 8.3 短名缓存的「隧道」效应：
    // 目录内容确实变了，但时间戳没跟着动。
    fs.utimesSync(TEST_FRAMES_DIR, new Date(m0), new Date(m0));
    expect(fs.statSync(TEST_FRAMES_DIR).mtimeMs).toBe(settle);

    // 只靠 mtime 的那一层被彻底骗过 —— 这正是「新加的框永远看不见、且毫无原因」
    // 那个故障的症状。
    vi.advanceTimersByTime(6_000);
    expect(frameAssetAvailable(KEY)).toBe(false);

    // 越过 FULL_RESCAN_MS：兜底全扫不依赖 mtime，所以看得见。
    // 最坏情况于是变成「新框最多 60 秒后出现」，且任何时候都不需要重启进程。
    vi.advanceTimersByTime(55_000);
    expect(frameAssetAvailable(KEY)).toBe(true);
  });
});

// ── pngHasAlpha：唯一能自动发现「框会盖住脸」的手段 ─────────────────────────

describe('pngHasAlpha', () => {
  it('颜色类型 6（真彩+alpha）→ true', () => {
    expect(pngHasAlpha(png(6))).toBe(true);
  });

  it('颜色类型 4（灰度+alpha）→ true', () => {
    expect(pngHasAlpha(png(4))).toBe(true);
  });

  it('颜色类型 2（真彩，无 alpha）→ false —— 这就是「会盖住脸」的那种素材', () => {
    expect(pngHasAlpha(png(2))).toBe(false);
  });

  it('颜色类型 0（灰度，无 alpha）→ false', () => {
    expect(pngHasAlpha(png(0))).toBe(false);
  });

  it('★ 颜色类型 3 + tRNS → true（调色板图靠 tRNS 声明透明色）', () => {
    expect(pngHasAlpha(png(3, { trns: true }))).toBe(true);
  });

  it('颜色类型 3 但没有 tRNS → false', () => {
    expect(pngHasAlpha(png(3))).toBe(false);
  });

  it('★ 真彩 + tRNS 也算有透明（单色抠图）', () => {
    expect(pngHasAlpha(png(2, { trns: true }))).toBe(true);
  });

  it('不是 PNG → null（判不出来，不是「没有透明」）', () => {
    expect(pngHasAlpha(SVG_BYTES)).toBeNull();
    expect(pngHasAlpha(JPEG_BYTES)).toBeNull();
    expect(pngHasAlpha(Buffer.alloc(0))).toBeNull();
  });

  it('PNG 签名对了但头被截断 → null', () => {
    expect(pngHasAlpha(PNG_SIG)).toBeNull();
    expect(pngHasAlpha(png(6).subarray(0, 20))).toBeNull();
  });

  it('签名对了但第一个块不是 IHDR → null（结构不认识就不猜）', () => {
    const bogus = Buffer.concat([PNG_SIG, chunk('tEXt', Buffer.alloc(8))]);
    expect(pngHasAlpha(bogus)).toBeNull();
  });

  it('畸形块长度不会死循环（长度是 uint32，每轮至少前进 12）', () => {
    const ihdr = Buffer.alloc(13);
    ihdr[9] = 2;
    // 一个声称有 0xFFFFFFFF 字节数据的块 —— 走一步就越界退出
    const huge = Buffer.concat([
      PNG_SIG,
      chunk('IHDR', ihdr),
      Buffer.from([0xff, 0xff, 0xff, 0xff]),
      Buffer.from('junk', 'latin1'),
    ]);
    expect(pngHasAlpha(huge)).toBe(false);
  });
});

// ── auditFrameAssets ───────────────────────────────────────────────────────

describe('auditFrameAssets', () => {
  it('覆盖白名单里每一个 key（这是运维发现「白名单有、盘上无」的唯一入口）', () => {
    const rows = auditFrameAssets();
    expect(rows.map((r) => r.key).sort()).toEqual([...FRAME_KEYS].sort());
  });

  it('素材缺席 → available false、hasAlpha null（不报错）', () => {
    const row = auditFrameAssets().find((r) => r.key === KEY)!;
    expect(row.available).toBe(false);
    expect(row.hasAlpha).toBeNull();
    expect(row.bytes).toBeNull();
    // 显示名照常给 —— 面板与 CLI 要能说出「哪个框缺素材」，而不只是一串 key
    expect(row.label.length).toBeGreaterThan(0);
  });

  it('素材在 → 报出字节数与透明通道', () => {
    const bytes = png(6);
    writeAsset(`${KEY}.png`, bytes);
    __resetFrameAssetCacheForTests();
    const row = auditFrameAssets().find((r) => r.key === KEY)!;
    expect(row.available).toBe(true);
    expect(row.hasAlpha).toBe(true);
    expect(row.bytes).toBe(bytes.byteLength);
  });

  it('★ 压平的素材（无 alpha）会被标出来 —— 那正是会盖住所有人脸的那种', () => {
    writeAsset(`${KEY}.png`, png(2));
    __resetFrameAssetCacheForTests();
    expect(auditFrameAssets().find((r) => r.key === KEY)!.hasAlpha).toBe(false);
  });
});

// ── 常量 ───────────────────────────────────────────────────────────────────

describe('下发白名单与上限', () => {
  it('★ ALLOWED_FRAME_MIME 只有 PNG —— SVG 不在里面是 XSS 闸门的关键', () => {
    expect([...ALLOWED_FRAME_MIME]).toEqual(['image/png']);
    expect(ALLOWED_FRAME_MIME.has('image/svg+xml')).toBe(false);
  });

  it('字节上限是个正数天花板', () => {
    expect(MAX_FRAME_BYTES).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 写路径与判定（需要真实 SQLite）
// ═══════════════════════════════════════════════════════════════════════════════

/** 把 `nowForDb()` 之后 n 毫秒的绝对时刻算出来（与 admin-user-service 的 banUntil 同款写法）。 */
const inMs = (ms: number) => new Date(nowForDb().getTime() + ms);
const DAY = 24 * 60 * 60 * 1000;

/** 读回某个用户的装备两列 —— 断言「有没有被写」一律看库，不看返回值。 */
const equipCols = (id: string) =>
  prisma.user.findUnique({
    where: { id },
    select: { equippedFrameKey: true, equippedFrameExpiresAt: true },
  });

/** 读回某人对某框的持有行（含墓碑）—— 「行数恒为 1」那类断言靠它。 */
const holdingRows = (userId: string, frameKey: string) =>
  prisma.userFrame.findMany({ where: { userId, frameKey } });

describe('grantFrame', () => {
  let u: { id: string };
  beforeEach(async () => {
    await resetDb();
    u = await makeUser();
  });

  it('授予新框 → created，行落库且到期时刻与请求一致', async () => {
    const exp = inMs(30 * DAY);
    const res = await grantFrame({ userId: u.id, key: KEY, expiresAt: exp });
    expect(res).toMatchObject({ ok: true, action: 'created', expiresAt: exp });

    const rows = await holdingRows(u.id, KEY);
    expect(rows).toHaveLength(1);
    expect(rows[0].deleted).toBe(false);
    expect(rows[0].expiresAt?.getTime()).toBe(exp.getTime());
    expect(rows[0].source).toBe('cli');
    // 授予 ≠ 装备
    expect((await equipCols(u.id))?.equippedFrameKey).toBeNull();
  });

  it('永久授予 → expiresAt 落 null', async () => {
    await grantFrame({ userId: u.id, key: KEY, expiresAt: null });
    expect((await holdingRows(u.id, KEY))[0].expiresAt).toBeNull();
  });

  it('source 落库（第二版鱼干购买要靠它区分「买的」与「站长发的」）', async () => {
    await grantFrame({ userId: u.id, key: KEY, expiresAt: null, source: 'purchase' });
    expect((await holdingRows(u.id, KEY))[0].source).toBe('purchase');
  });

  it('再授更长的 → extended，取较晚', async () => {
    const near = inMs(1 * DAY);
    const far = inMs(60 * DAY);
    await grantFrame({ userId: u.id, key: KEY, expiresAt: near });
    const res = await grantFrame({ userId: u.id, key: KEY, expiresAt: far });
    expect(res).toMatchObject({ ok: true, action: 'extended' });
    expect((await holdingRows(u.id, KEY))[0].expiresAt?.getTime()).toBe(far.getTime());
  });

  it('★ 只延长不缩短：再授更短的 → noop，库里一点没动', async () => {
    const far = inMs(60 * DAY);
    await grantFrame({ userId: u.id, key: KEY, expiresAt: far });
    const res = await grantFrame({ userId: u.id, key: KEY, expiresAt: inMs(1 * DAY) });
    expect(res).toMatchObject({ ok: true, action: 'noop' });
    expect((await holdingRows(u.id, KEY))[0].expiresAt?.getTime()).toBe(far.getTime());
    // 想缩短只有 revoke 一条路 —— 这条口径要能在下一条用例里被推翻
    expect(res.ok && res.expiresAt?.getTime()).toBe(far.getTime());
  });

  it('★ 已经是永久的，再授 30 天仍是永久（noop）', async () => {
    await grantFrame({ userId: u.id, key: KEY, expiresAt: null });
    const res = await grantFrame({ userId: u.id, key: KEY, expiresAt: inMs(30 * DAY) });
    expect(res).toMatchObject({ ok: true, action: 'noop' });
    expect((await holdingRows(u.id, KEY))[0].expiresAt).toBeNull();
  });

  it('有期的升成永久 → extended，变 null', async () => {
    await grantFrame({ userId: u.id, key: KEY, expiresAt: inMs(1 * DAY) });
    const res = await grantFrame({ userId: u.id, key: KEY, expiresAt: null });
    expect(res).toMatchObject({ ok: true, action: 'extended' });
    expect((await holdingRows(u.id, KEY))[0].expiresAt).toBeNull();
  });

  it('未登记的 key → 400（不静默丢弃）', async () => {
    const res = await grantFrame({ userId: u.id, key: 'no-such-frame', expiresAt: null });
    expect(res).toMatchObject({ ok: false, code: 400 });
    expect(await prisma.userFrame.count()).toBe(0);
  });

  it('用户不存在 → 404', async () => {
    const res = await grantFrame({ userId: 'nobody', key: KEY, expiresAt: null });
    expect(res).toMatchObject({ ok: false, code: 404 });
  });

  it('★ 收回后再授予必须复活墓碑行，行数恒为 1（唯一约束是物理的）', async () => {
    await grantFrame({ userId: u.id, key: KEY, expiresAt: null });
    await revokeFrame({ userId: u.id, key: KEY });
    expect((await holdingRows(u.id, KEY))[0].deleted).toBe(true);

    const res = await grantFrame({ userId: u.id, key: KEY, expiresAt: inMs(7 * DAY) });
    expect(res).toMatchObject({ ok: true, action: 'revived' });

    const rows = await holdingRows(u.id, KEY);
    expect(rows).toHaveLength(1); // ← 新插一行会撞唯一约束 / 或留下两行
    expect(rows[0].deleted).toBe(false);
    expect(rows[0].deletedAt).toBeNull();
  });

  it('★ 墓碑上的旧永久值不参与「取较晚」—— 否则收回过的永久授权会诈尸', async () => {
    await grantFrame({ userId: u.id, key: KEY, expiresAt: null }); // 永久
    await revokeFrame({ userId: u.id, key: KEY }); // 收回
    const exp = inMs(30 * DAY);
    await grantFrame({ userId: u.id, key: KEY, expiresAt: exp });
    // 若与墓碑上的 null 取较晚，结果会是 null（永久）—— 那荒唐：上一次授权已被收回
    expect((await holdingRows(u.id, KEY))[0].expiresAt?.getTime()).toBe(exp.getTime());
  });
});

describe('revokeFrame', () => {
  let u: { id: string };
  beforeEach(async () => {
    await resetDb();
    u = await makeUser();
  });

  it('翻墓碑而不是物删（全站口径 F5）', async () => {
    await grantFrame({ userId: u.id, key: KEY, expiresAt: null });
    const res = await revokeFrame({ userId: u.id, key: KEY });
    expect(res).toEqual({ revoked: true, unequipped: false });

    const rows = await holdingRows(u.id, KEY);
    expect(rows).toHaveLength(1); // 行还在
    expect(rows[0].deleted).toBe(true);
    expect(rows[0].deletedAt).not.toBeNull();
  });

  it('幂等：再收回一次 → revoked false，不报错', async () => {
    await grantFrame({ userId: u.id, key: KEY, expiresAt: null });
    await revokeFrame({ userId: u.id, key: KEY });
    expect(await revokeFrame({ userId: u.id, key: KEY })).toEqual({
      revoked: false,
      unequipped: false,
    });
  });

  it('本来就没持有过 → 同样是干净的 revoked false', async () => {
    expect(await revokeFrame({ userId: u.id, key: KEY })).toEqual({
      revoked: false,
      unequipped: false,
    });
  });

  it('未登记的 key → 不抛，按「没什么可收回的」处理', async () => {
    expect(await revokeFrame({ userId: u.id, key: 'no-such-frame' })).toEqual({
      revoked: false,
      unequipped: false,
    });
  });

  it('★ 正戴着这个框时，收回会顺带卸下（F2）', async () => {
    await grantFrame({ userId: u.id, key: KEY, expiresAt: null });
    await equipFrame(u.id, KEY);
    expect((await equipCols(u.id))?.equippedFrameKey).toBe(KEY);

    expect(await revokeFrame({ userId: u.id, key: KEY })).toEqual({
      revoked: true,
      unequipped: true,
    });
    const cols = await equipCols(u.id);
    expect(cols?.equippedFrameKey).toBeNull();
    expect(cols?.equippedFrameExpiresAt).toBeNull();
  });

  it('戴的是**别的**框时，收回这个框不动装备指针', async () => {
    // 只有一个 key，所以构造「别的框」用一次未登记 key 的装备是不可能的 ——
    // 这里验证的是另一半：没装备任何东西时收回，装备列当然不该被碰。
    await grantFrame({ userId: u.id, key: KEY, expiresAt: null });
    const res = await revokeFrame({ userId: u.id, key: KEY });
    expect(res.unequipped).toBe(false);
    expect((await equipCols(u.id))?.equippedFrameKey).toBeNull();
  });
});

describe('equipFrame', () => {
  let u: { id: string };
  beforeEach(async () => {
    await resetDb();
    u = await makeUser();
  });

  it('未持有 → 403，且**库里一点没写**', async () => {
    const res = await equipFrame(u.id, KEY);
    expect(res).toMatchObject({ ok: false, code: 403 });
    const cols = await equipCols(u.id);
    expect(cols?.equippedFrameKey).toBeNull();
    expect(cols?.equippedFrameExpiresAt).toBeNull();
  });

  it('★ 持有但已过期 → 403，且库里一点没写', async () => {
    await grantFrame({ userId: u.id, key: KEY, expiresAt: inMs(-1000) }); // 一毫秒前就过期了
    const res = await equipFrame(u.id, KEY);
    expect(res).toMatchObject({ ok: false, code: 403 });
    expect((await equipCols(u.id))?.equippedFrameKey).toBeNull();
  });

  it('成功 → users 两列的到期时刻 = 持有行的到期时刻', async () => {
    const exp = inMs(30 * DAY);
    await grantFrame({ userId: u.id, key: KEY, expiresAt: exp });
    const res = await equipFrame(u.id, KEY);
    expect(res).toMatchObject({ ok: true, key: KEY });

    const cols = await equipCols(u.id);
    expect(cols?.equippedFrameKey).toBe(KEY);
    expect(cols?.equippedFrameExpiresAt?.getTime()).toBe(exp.getTime());
  });

  it('永久框 → 装备列的到期时刻是 null', async () => {
    await grantFrame({ userId: u.id, key: KEY, expiresAt: null });
    await equipFrame(u.id, KEY);
    expect((await equipCols(u.id))?.equippedFrameExpiresAt).toBeNull();
  });

  it('收回后就装不上了（持有行已失效）', async () => {
    await grantFrame({ userId: u.id, key: KEY, expiresAt: null });
    await revokeFrame({ userId: u.id, key: KEY });
    expect(await equipFrame(u.id, KEY)).toMatchObject({ ok: false, code: 403 });
  });

  it('未知 key → 400', async () => {
    expect(await equipFrame(u.id, 'no-such-frame')).toMatchObject({ ok: false, code: 400 });
  });

  it('重复装备同一个框是幂等的', async () => {
    await grantFrame({ userId: u.id, key: KEY, expiresAt: null });
    await equipFrame(u.id, KEY);
    expect(await equipFrame(u.id, KEY)).toMatchObject({ ok: true, key: KEY });
  });

  it('卸下 → 两列清空', async () => {
    await grantFrame({ userId: u.id, key: KEY, expiresAt: null });
    await equipFrame(u.id, KEY);
    expect(await equipFrame(u.id, null)).toEqual({ ok: true, key: null, expiresAt: null });
    const cols = await equipCols(u.id);
    expect(cols?.equippedFrameKey).toBeNull();
    expect(cols?.equippedFrameExpiresAt).toBeNull();
  });

  it('★ 卸下无条件成功 —— 即使当前装备的是一个白名单外的（已删/已退役）key', async () => {
    // 这是「退役 key 变成卸不掉的僵尸装备」那条风险的唯一出路。
    // 直接写库来构造这个状态（写路径本身不允许它出现）。
    await prisma.user.update({
      where: { id: u.id },
      data: { equippedFrameKey: 'a-key-that-no-longer-exists', equippedFrameExpiresAt: null },
    });
    expect(await equipFrame(u.id, null)).toMatchObject({ ok: true });
    expect((await equipCols(u.id))?.equippedFrameKey).toBeNull();
  });

  it('没有任何装备时卸下也是成功的', async () => {
    expect(await equipFrame(u.id, null)).toMatchObject({ ok: true });
  });
});

describe('★ F2：持有行的到期时刻变了，装备列的冗余副本必须跟着走', () => {
  let u: { id: string };
  beforeEach(async () => {
    await resetDb();
    u = await makeUser();
  });

  it('★ 装备中 → grant 续期 → equipped_frame_expires_at 跟着变新', async () => {
    // 【这条为什么是本设计最隐蔽的坑】渲染侧读的是 users 上那两个**冗余列**，
    // 它不会回头去看持有行。续期时忘了刷这一列，症状是「用户续期了，
    // 但框到期后永远不出现」—— 看起来像浏览器缓存。
    const first = inMs(1 * DAY);
    await grantFrame({ userId: u.id, key: KEY, expiresAt: first });
    await equipFrame(u.id, KEY);
    expect((await equipCols(u.id))?.equippedFrameExpiresAt?.getTime()).toBe(first.getTime());

    const second = inMs(90 * DAY);
    const res = await grantFrame({ userId: u.id, key: KEY, expiresAt: second });
    expect(res).toMatchObject({ ok: true, action: 'extended', refreshedEquip: true });

    expect((await equipCols(u.id))?.equippedFrameExpiresAt?.getTime()).toBe(second.getTime());
  });

  it('★ 装备中 → 续成永久 → 装备列也变 null', async () => {
    await grantFrame({ userId: u.id, key: KEY, expiresAt: inMs(1 * DAY) });
    await equipFrame(u.id, KEY);
    await grantFrame({ userId: u.id, key: KEY, expiresAt: null });
    expect((await equipCols(u.id))?.equippedFrameExpiresAt).toBeNull();
  });

  it('没装备这个框时，grant 不动装备列（refreshedEquip false）', async () => {
    await grantFrame({ userId: u.id, key: KEY, expiresAt: inMs(1 * DAY) });
    const res = await grantFrame({ userId: u.id, key: KEY, expiresAt: inMs(9 * DAY) });
    expect(res.ok && res.refreshedEquip).toBe(false);
    expect((await equipCols(u.id))?.equippedFrameKey).toBeNull();
  });

  it('★ 续期之后框仍然是显示着的（F2 的行为级断言，不只看库）', async () => {
    writeAsset(`${KEY}.png`, png(6));
    __resetFrameAssetCacheForTests();

    await grantFrame({ userId: u.id, key: KEY, expiresAt: inMs(1 * DAY) });
    await equipFrame(u.id, KEY);
    expect(await frameUrlOfUser(u.id)).not.toBeNull();

    await grantFrame({ userId: u.id, key: KEY, expiresAt: null });
    expect(await frameUrlOfUser(u.id)).not.toBeNull();
  });
});

describe('frameUrlFor —— 唯一的判定出口', () => {
  let u: { id: string };
  beforeEach(async () => {
    await resetDb();
    u = await makeUser();
  });

  it('没装备 → null', () => {
    expect(frameUrlFor(null)).toBeNull();
    expect(frameUrlFor(undefined)).toBeNull();
    expect(frameUrlFor({})).toBeNull();
    expect(frameUrlFor({ equippedFrameKey: null, equippedFrameExpiresAt: null })).toBeNull();
  });

  it('装备了 + 未过期 + 盘上有图 → 贴图地址', () => {
    writeAsset(`${KEY}.png`, png(6));
    __resetFrameAssetCacheForTests();
    expect(frameUrlFor({ equippedFrameKey: KEY, equippedFrameExpiresAt: null })).toBe(
      `/api/frames/${KEY}`
    );
  });

  it('★ 已过期 → null（这就是「到期后不消失」那条风险的闸门）', () => {
    writeAsset(`${KEY}.png`, png(6));
    __resetFrameAssetCacheForTests();
    expect(
      frameUrlFor({ equippedFrameKey: KEY, equippedFrameExpiresAt: new Date(nowForDb().getTime() - 1) })
    ).toBeNull();
  });

  it('★ 盘上没有素材 → null（授权有效，但暂时显示不出来）', () => {
    // 目录是空的（beforeEach 清过）
    expect(frameUrlFor({ equippedFrameKey: KEY, equippedFrameExpiresAt: null })).toBeNull();
  });

  it('不在白名单的 key → null', () => {
    writeAsset(`${KEY}.png`, png(6));
    __resetFrameAssetCacheForTests();
    expect(frameUrlFor({ equippedFrameKey: 'no-such-frame', equippedFrameExpiresAt: null })).toBeNull();
  });

  it('★ 素材补上之后立刻能显示，不需要重新装备（第三道闸是运维事实，不是状态）', () => {
    const fields = { equippedFrameKey: KEY, equippedFrameExpiresAt: null };
    expect(frameUrlFor(fields)).toBeNull(); // 还没传素材
    writeAsset(`${KEY}.png`, png(6));
    __resetFrameAssetCacheForTests();
    expect(frameUrlFor(fields)).toBe(`/api/frames/${KEY}`);
  });

  it('frameUrlOfUser：只有 id 时多查一次主键，结果与 frameUrlFor 一致', async () => {
    writeAsset(`${KEY}.png`, png(6));
    __resetFrameAssetCacheForTests();
    await grantFrame({ userId: u.id, key: KEY, expiresAt: null });
    await equipFrame(u.id, KEY);

    expect(await frameUrlOfUser(u.id)).toBe(`/api/frames/${KEY}`);
    expect(await frameUrlOfUser('nobody')).toBeNull();
  });
});

describe('listMyFrames —— 面板数据源（下发判定后的结果）', () => {
  let u: { id: string };
  beforeEach(async () => {
    await resetDb();
    u = await makeUser();
  });

  it('空持有 → 空列表、equipped null', async () => {
    expect(await listMyFrames(u.id)).toEqual({ frames: [], equipped: null });
  });

  it('只列 alive 的持有行 —— 收回过的不出现', async () => {
    await grantFrame({ userId: u.id, key: KEY, expiresAt: null });
    await revokeFrame({ userId: u.id, key: KEY });
    const view = await listMyFrames(u.id);
    expect(view.frames).toHaveLength(0);
  });

  it('★ 下发的是判定后的结果：url / expired / equipped 都由服务端算好', async () => {
    writeAsset(`${KEY}.png`, png(6));
    __resetFrameAssetCacheForTests();
    await grantFrame({ userId: u.id, key: KEY, expiresAt: null });
    await equipFrame(u.id, KEY);

    const view = await listMyFrames(u.id);
    expect(view.frames).toHaveLength(1);
    expect(view.frames[0]).toMatchObject({
      key: KEY,
      available: true,
      retired: false,
      expired: false,
      equipped: true,
      url: `/api/frames/${KEY}`,
      expiresAt: null, // 永久
    });
    expect(view.equipped).toEqual({ key: KEY, label: expect.any(String), active: true, expiresAt: null });
  });

  it('★ 已过期的框：expired true、url null、但 equipped 仍是 true（装备状态还在）', async () => {
    writeAsset(`${KEY}.png`, png(6));
    __resetFrameAssetCacheForTests();
    await grantFrame({ userId: u.id, key: KEY, expiresAt: inMs(-1) });
    // 过期后装不上，所以直接写库构造「戴着但已过期」这个状态
    await prisma.user.update({
      where: { id: u.id },
      data: { equippedFrameKey: KEY, equippedFrameExpiresAt: inMs(-1) },
    });

    const view = await listMyFrames(u.id);
    expect(view.frames[0]).toMatchObject({ expired: true, url: null, equipped: true });
    // active false = 面板据此显示「已过期」并给出「卸下」
    expect(view.equipped).toMatchObject({ key: KEY, active: false });
  });

  it('★ 素材缺失：available false、url null，但 expired 仍是 false（两件事别混）', async () => {
    await grantFrame({ userId: u.id, key: KEY, expiresAt: null });
    const view = await listMyFrames(u.id);
    expect(view.frames[0]).toMatchObject({ available: false, url: null, expired: false });
  });

  it('展示用的到期时刻走 ymdhms（UTC 口径的字符串，不是 ISO）', async () => {
    const exp = inMs(30 * DAY);
    await grantFrame({ userId: u.id, key: KEY, expiresAt: exp });
    const view = await listMyFrames(u.id);
    expect(view.frames[0].expiresAt).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  it('白名单外的 key（数据脏）也列出来，标 retired，让用户能卸下', async () => {
    await prisma.userFrame.create({
      data: { userId: u.id, frameKey: 'ghost-frame', expiresAt: null, createdAt: nowForDb() },
    });
    const view = await listMyFrames(u.id);
    expect(view.frames).toHaveLength(1);
    expect(view.frames[0]).toMatchObject({ key: 'ghost-frame', retired: true, url: null });
    // 显示名退回 key 本身，不编一个名字
    expect(view.frames[0].label).toBe('ghost-frame');
  });
});
