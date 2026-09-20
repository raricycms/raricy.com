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
  frameAssetAvailable,
  pngHasAlpha,
  resolveFrameAsset,
} from '@/lib/frame-service';
import { FRAME_KEYS } from '@/lib/frame-refs';

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
    expect(fs.statSync(TEST_FRAMES_DIR).mtimeMs).toBe(m0); // 归整确实生效了

    __resetFrameAssetCacheForTests();
    expect(frameAssetAvailable(KEY)).toBe(false); // 空目录，缓存记下 m0

    writeAsset(`${KEY}.png`, png(6));
    // 强行把 mtime 按回 m0 —— 模拟 Windows 8.3 短名缓存的「隧道」效应：
    // 目录内容确实变了，但时间戳没跟着动。
    fs.utimesSync(TEST_FRAMES_DIR, new Date(m0), new Date(m0));
    expect(fs.statSync(TEST_FRAMES_DIR).mtimeMs).toBe(m0);

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
