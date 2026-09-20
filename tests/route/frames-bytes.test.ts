// GET /api/frames/:key —— 头像框素材的字节路由（route handler 层）
//
// 【为什么单独一个文件，service 的单测不够】
// 素材域的查表（白名单 / 扫盘 / 缓存）在 frame-service 里已经测透了，但这条路由上
// 还有**三道只有在这一层才存在的闸门**，而它们全都是「错了不报错」的那种：
//
//  1. ★ **按字节复核 MIME 并拒绝 SVG** ★ —— 框目录没有任何上游校验（站长直接拷文件
//     进去）。往目录里丢一个内容是 `<svg onload=...>` 的 `demo.png`，按扩展名下发的
//     实现会以 image/svg+xml 内联返回 = **同源存储型 XSS**。ALLOWED_FRAME_MIME 只有
//     image/png，这道闸门只在路由里。service 的单测碰不到它。
//  2. **Cache-Control 不许写 immutable** —— 写了之后站长换图一年不生效，清缓存也没用。
//  3. **素材在扫盘之后被删 / 读不了 → 404 而不是 500** —— 站长换文件时会撞上。
//
// 【磁盘安全】只碰 tests/.tmp/ 下的目录（见 TEST_FRAMES_DIR 与 assertTempDir）。

import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';

const TEST_FRAMES_DIR = path.resolve(import.meta.dirname, '../.tmp/frames-route-test');
process.env.FRAMES_DIR = TEST_FRAMES_DIR;

import { GET as frameBytes } from '@/app/api/frames/[key]/route';
import { MAX_FRAME_BYTES, __resetFrameAssetCacheForTests } from '@/lib/frame-service';
import { FRAME_KEYS } from '@/lib/frame-refs';

function assertTempDir() {
  if (!TEST_FRAMES_DIR.includes(`${path.sep}tests${path.sep}.tmp${path.sep}`)) {
    throw new Error(`拒绝在非临时目录上跑头像框用例：${TEST_FRAMES_DIR}`);
  }
}

const KEY = FRAME_KEYS[0];

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG = Buffer.concat([PNG_SIG, Buffer.alloc(40)]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>');
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(40)]);
const GIF = Buffer.from('GIF89a...................', 'latin1');

function writeAsset(name: string, data: Buffer) {
  fs.mkdirSync(TEST_FRAMES_DIR, { recursive: true });
  fs.writeFileSync(path.join(TEST_FRAMES_DIR, name), data);
}

/** Next 15 的 params 是 Promise。 */
const ctx = (key: string) => ({ params: Promise.resolve({ key }) });
const get = (key: string) => frameBytes(new Request('http://localhost/api/frames/x'), ctx(key));

beforeAll(() => {
  assertTempDir();
  fs.rmSync(TEST_FRAMES_DIR, { recursive: true, force: true });
});

afterAll(() => {
  assertTempDir();
  fs.rmSync(TEST_FRAMES_DIR, { recursive: true, force: true });
});

beforeEach(() => {
  assertTempDir();
  fs.rmSync(TEST_FRAMES_DIR, { recursive: true, force: true });
  __resetFrameAssetCacheForTests();
});

describe('正常下发', () => {
  it('白名单内的 key + 盘上有 PNG → 200 且字节一致', async () => {
    writeAsset(`${KEY}.png`, PNG);
    __resetFrameAssetCacheForTests();
    const res = await get(KEY);
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer()).equals(PNG)).toBe(true);
  });

  it('响应头：Content-Type / nosniff / Cache-Control', async () => {
    writeAsset(`${KEY}.png`, PNG);
    __resetFrameAssetCacheForTests();
    const res = await get(KEY);
    expect(res.headers.get('Content-Type')).toBe('image/png');
    // 内容是照字节嗅探出来的，明确告诉浏览器别再自己猜
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=86400');
  });

  it('★ Cache-Control 里**不许**出现 immutable', async () => {
    // immutable 会让浏览器一年都不来看一眼，而站长的工作流正是「往目录里拷文件」。
    // 换图不生效时用户清缓存也没用 —— 这条是那份困惑的唯一防线。
    writeAsset(`${KEY}.png`, PNG);
    __resetFrameAssetCacheForTests();
    expect((await get(KEY)).headers.get('Cache-Control')).not.toMatch(/immutable/i);
  });
});

describe('★ XSS 闸门：扩展名只是声明，字节才是事实', () => {
  it('内容是 <svg onload> 的 demo.png → 404（不是以 image/svg+xml 下发）', async () => {
    writeAsset(`${KEY}.png`, SVG);
    __resetFrameAssetCacheForTests();
    const res = await get(KEY);
    expect(res.status).toBe(404);
    // 连字节都不该漏出去 —— 曾经有实现会在 404 里带上原内容
    expect(await res.text()).not.toContain('<svg');
  });

  it('内容是 JPEG 的 demo.png → 404（白名单只有 PNG）', async () => {
    writeAsset(`${KEY}.png`, JPEG);
    __resetFrameAssetCacheForTests();
    expect((await get(KEY)).status).toBe(404);
  });

  it('内容是 GIF 的 demo.png → 404', async () => {
    writeAsset(`${KEY}.png`, GIF);
    __resetFrameAssetCacheForTests();
    expect((await get(KEY)).status).toBe(404);
  });

  it('纯文本的 demo.png → 404（不是 500）', async () => {
    writeAsset(`${KEY}.png`, Buffer.from('这不是图片'));
    __resetFrameAssetCacheForTests();
    expect((await get(KEY)).status).toBe(404);
  });

  it('空文件 → 404', async () => {
    writeAsset(`${KEY}.png`, Buffer.alloc(0));
    __resetFrameAssetCacheForTests();
    expect((await get(KEY)).status).toBe(404);
  });
});

describe('404 的各种来源（都不该是 500）', () => {
  it('未登记的 key', async () => {
    writeAsset('not-in-whitelist.png', PNG);
    __resetFrameAssetCacheForTests();
    expect((await get('not-in-whitelist')).status).toBe(404);
  });

  it('白名单里有这个 key、盘上却没有图（站长还没传素材）', async () => {
    expect((await get(KEY)).status).toBe(404);
  });

  it('素材目录整个不存在', async () => {
    fs.rmSync(TEST_FRAMES_DIR, { recursive: true, force: true });
    __resetFrameAssetCacheForTests();
    expect((await get(KEY)).status).toBe(404);
  });

  it('★ 扫盘说有、读的时候没了（站长正在换文件）→ 404，不抛', async () => {
    writeAsset(`${KEY}.png`, PNG);
    __resetFrameAssetCacheForTests();
    expect((await get(KEY)).status).toBe(200);

    fs.rmSync(path.join(TEST_FRAMES_DIR, `${KEY}.png`));
    // 缓存还没过期 → 仍然认为「有」，于是走到 readFile 并失败的那条路
    expect((await get(KEY)).status).toBe(404);
  });

  it('超过字节上限 → 404', async () => {
    writeAsset(`${KEY}.png`, Buffer.concat([PNG_SIG, Buffer.alloc(MAX_FRAME_BYTES + 1)]));
    __resetFrameAssetCacheForTests();
    expect((await get(KEY)).status).toBe(404);
  });

  it('★ 目录穿越的各种写法都落在白名单外 → 404', async () => {
    // 这些是 Next 解码 params 之后可能交给 handler 的形状。
    // 白名单是手写的源码常量，所以它们在查表那一步就被挡掉了 —— 免疫的来源。
    for (const evil of [
      '..',
      '../..',
      '../../users',
      '../../etc/passwd',
      '/etc/passwd',
      `${KEY}/../${KEY}`,
      `${KEY}\0`,
      '..%2f..%2fetc',
    ]) {
      expect((await get(evil)).status, evil).toBe(404);
    }
  });

  it('带扩展名不算命中（key 是去扩展名的基名）', async () => {
    writeAsset(`${KEY}.png`, PNG);
    __resetFrameAssetCacheForTests();
    expect((await get(`${KEY}.png`)).status).toBe(404);
  });
});
