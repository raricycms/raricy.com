// sticker-service.ts —— 表情素材的扫盘 / 缓存 / 查表。
//
// 【为什么值得重点测】
//  1. **路径穿越免疫**：素材是运行时扫盘的，而查表模型的全部安全性都押在
//     「collection / name 只当 key、永不拼进路径」这一条上。它一旦被人为了
//     「支持多级合集」改成 path.join，洞就开了，而且**没有任何别的测试会红**。
//  2. **SVG XSS**：表情目录没有任何上游校验（图床那边有 verifyImageMime 在入口验过
//     字节并落库）。所以「按字节嗅探、拒绝 SVG」这条闸门只在 raw 路由里，一旦回退
//     就是同源存储型 XSS。这里把 ALLOWED_STICKER_MIME 与 detectImageMime 的配合钉死。
//  3. **ignore**：隐藏合集若只在列表接口过滤，手打 `[@私密合集/x]` 照样能把图取出来。
//
// 【磁盘安全】只碰 tests/.tmp/stickers-test/，绝不碰 ./instance/stickers 里的真实素材
// —— 见下方 TEST_STICKERS_DIR 与 assertTempDir()。

import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';

import {
  ALLOWED_STICKER_MIME,
  MAX_STICKER_BYTES,
  __resetStickerCacheForTests,
  hasNoStickers,
  listStickerCollections,
  resolveSticker,
} from '@/lib/sticker-service';
import { detectImageMime } from '@/lib/image-upload';
import { stickerUrl } from '@/lib/sticker-refs';

// ── 磁盘隔离 ────────────────────────────────────────────────────────────────

const TEST_STICKERS_DIR = path.resolve(import.meta.dirname, '../.tmp/stickers-test');
process.env.STICKERS_DIR = TEST_STICKERS_DIR;

/** 硬校验：素材目录必须在 tests/.tmp/ 下，否则直接抛（防止误动真实素材）。 */
function assertTempDir() {
  if (!TEST_STICKERS_DIR.includes(`${path.sep}tests${path.sep}.tmp${path.sep}`)) {
    throw new Error(`拒绝在非临时目录上跑表情用例：${TEST_STICKERS_DIR}`);
  }
}

// ── 最小合法图片字节 ────────────────────────────────────────────────────────
//
// 只用到文件头（detectImageMime 也只看头），不需要真能解码的完整文件。

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const GIF = Buffer.from('GIF89a............', 'latin1');
const WEBP = Buffer.concat([
  Buffer.from('RIFF', 'latin1'),
  Buffer.from([0, 0, 0, 0]),
  Buffer.from('WEBP', 'latin1'),
]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>');

function write(rel: string, data: Buffer | string) {
  const full = path.join(TEST_STICKERS_DIR, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, data);
}

beforeAll(() => {
  assertTempDir();
  fs.rmSync(TEST_STICKERS_DIR, { recursive: true, force: true });
});

afterAll(() => {
  assertTempDir();
  fs.rmSync(TEST_STICKERS_DIR, { recursive: true, force: true });
});

beforeEach(() => {
  assertTempDir();
  fs.rmSync(TEST_STICKERS_DIR, { recursive: true, force: true });
  __resetStickerCacheForTests();
});

// ── 扫盘 ────────────────────────────────────────────────────────────────────

describe('sticker-service 扫盘', () => {
  it('根目录不存在时返回空，不抛', () => {
    expect(listStickerCollections()).toEqual([]);
    expect(hasNoStickers()).toBe(true);
    expect(resolveSticker('猫猫', '开心')).toBeNull();
  });

  it('扫出合集与表情，名字是去扩展名的', () => {
    write('猫猫/开心.png', PNG);
    write('猫猫/难过.gif', GIF);
    const cols = listStickerCollections();
    expect(cols).toHaveLength(1);
    expect(cols[0].key).toBe('猫猫');
    expect(cols[0].title).toBe('猫猫'); // 没有 info.json → 显示名回落成目录名
    expect(cols[0].stickers.map((s) => s.name)).toEqual(['开心', '难过']);
    expect(cols[0].stickers[0].url).toBe(stickerUrl('猫猫', '开心'));
  });

  it('info.json 的 title / priority 生效，并按 priority 降序排', () => {
    write('甲/图.png', PNG);
    write('甲/info.json', JSON.stringify({ title: '甲组', priority: 1 }));
    write('乙/图.png', PNG);
    write('乙/info.json', JSON.stringify({ title: '乙组', priority: 9 }));
    const cols = listStickerCollections();
    expect(cols.map((c) => c.title)).toEqual(['乙组', '甲组']);
    expect(cols[0].key).toBe('乙');
  });

  it('★ info.json 的 ignore 隐藏合集：列表里没有，**查表也取不到**', () => {
    write('公开/图.png', PNG);
    write('私密/图.png', PNG);
    write('私密/info.json', JSON.stringify({ ignore: true }));

    expect(listStickerCollections().map((c) => c.key)).toEqual(['公开']);
    // 关键：绕过面板手打 token 也必须取不到 —— 否则「隐藏」只是不出现在列表里
    expect(resolveSticker('私密', '图')).toBeNull();
    expect(resolveSticker('公开', '图')).not.toBeNull();
  });

  it('跳过点 / 下划线开头的文件与目录，以及 Thumbs.db', () => {
    write('猫猫/开心.png', PNG);
    write('猫猫/.DS_Store', 'x');
    write('猫猫/_wip.png', PNG);
    write('猫猫/Thumbs.db', 'x');
    write('_草稿/图.png', PNG);
    write('.git/图.png', PNG);

    expect(listStickerCollections().map((c) => c.key)).toEqual(['猫猫']);
    expect(resolveSticker('猫猫', '.DS_Store')).toBeNull();
    expect(resolveSticker('猫猫', '_wip')).toBeNull();
    expect(resolveSticker('_草稿', '图')).toBeNull();
  });

  it('非图片扩展名一律不扫进来', () => {
    write('猫猫/开心.png', PNG);
    write('猫猫/说明.txt', 'x');
    write('猫猫/源文件.psd', 'x');
    expect(listStickerCollections()[0].stickers.map((s) => s.name)).toEqual(['开心']);
    expect(resolveSticker('猫猫', '说明')).toBeNull();
  });

  it('★ 同名多扩展名按固定优先级取（gif > webp > png），不随 readdir 顺序变', () => {
    write('猫猫/开心.png', PNG);
    write('猫猫/开心.gif', GIF);
    write('猫猫/开心.webp', WEBP);
    const hit = resolveSticker('猫猫', '开心');
    expect(hit?.file).toBe('开心.gif');
    expect(hit?.mime).toBe('image/gif');
  });

  it('★ NFC 归一化：用 NFD 形式查得到磁盘上的 NFC 文件', () => {
    write('猫猫/café.png', PNG); // NFC（é 单码点）
    expect(resolveSticker('猫猫', 'café'.normalize('NFD'))).not.toBeNull();
    expect(resolveSticker('猫猫', 'café'.normalize('NFC'))).not.toBeNull();
  });

  it('空文件名的基名（`​.gif`）不产生条目', () => {
    write('猫猫/.gif', GIF); // 点开头，先被 isSkippedName 挡掉
    expect(listStickerCollections()).toEqual([]);
  });
});

// ── 查表：路径穿越免疫 ──────────────────────────────────────────────────────

describe('sticker-service 查表安全性', () => {
  it('★ 穿越形态的名字一律查不到（collection / name 只当 key，不拼路径）', () => {
    write('猫猫/开心.png', PNG);
    for (const evil of [
      '../开心',
      '../../etc/passwd',
      '..',
      '.',
      'a/../../b',
      '猫猫/../猫猫',
      '\\..\\..\\x',
    ]) {
      expect(resolveSticker(evil, '开心'), evil).toBeNull();
      expect(resolveSticker('猫猫', evil), evil).toBeNull();
    }
  });

  it('命中时返回的磁盘路径确实在该合集目录内', () => {
    write('猫猫/开心.png', PNG);
    const hit = resolveSticker('猫猫', '开心')!;
    expect(path.dirname(path.resolve(hit.absPath))).toBe(path.resolve(hit.dir));
    expect(path.resolve(hit.absPath).startsWith(path.resolve(TEST_STICKERS_DIR))).toBe(true);
  });

  it('不存在的合集 / 表情返回 null', () => {
    write('猫猫/开心.png', PNG);
    expect(resolveSticker('狗子', '开心')).toBeNull();
    expect(resolveSticker('猫猫', '生气')).toBeNull();
  });
});

// ── 缓存 ────────────────────────────────────────────────────────────────────

describe('sticker-service 缓存', () => {
  it('TTL 内新加的文件不会被立刻看见（缓存命中）', () => {
    write('猫猫/开心.png', PNG);
    expect(resolveSticker('猫猫', '开心')).not.toBeNull();
    write('猫猫/新来的.png', PNG);
    // 刚扫过、TTL 未到 → 走缓存，看不见新文件
    expect(resolveSticker('猫猫', '新来的')).toBeNull();
  });

  it('★ 覆盖同名文件的内容不需要失效缓存（manifest 只存名字，字节每次现读）', () => {
    write('猫猫/开心.png', PNG);
    const before = resolveSticker('猫猫', '开心')!;
    // 换成另一张完全不同的图，同名同路径
    fs.writeFileSync(before.absPath, GIF);
    __resetStickerCacheForTests(); // 模拟缓存过期
    const after = resolveSticker('猫猫', '开心')!;
    // manifest 里的路径没变，磁盘上已经是新字节 —— 这一条说明「换图」为什么不需要失效
    expect(after.absPath).toBe(before.absPath);
    expect(detectImageMime(fs.readFileSync(after.absPath))).toBe('image/gif');
  });
});

// ── SVG 闸门（raw 路由的安全依据）────────────────────────────────────────────

describe('sticker-service SVG 闸门', () => {
  it('★ ALLOWED_STICKER_MIME 不含 svg —— 这是同源 XSS 的唯一闸门', () => {
    expect(ALLOWED_STICKER_MIME.has('image/svg+xml')).toBe(false);
    for (const ok of ['image/png', 'image/gif', 'image/webp', 'image/jpeg']) {
      expect(ALLOWED_STICKER_MIME.has(ok), ok).toBe(true);
    }
  });

  it('★ 即便目录里放了 .svg，字节嗅探也会认出它是 svg 并被闸门拒绝', () => {
    // 注意：.svg 不在 EXT_PRIORITY 里，所以根本扫不进来 —— 但闸门是**第二道**，
    // 防的是「有人把 svg 内容改名成 .png 丢进来」这种绕过扩展名的情况。
    expect(detectImageMime(SVG)).toBe('image/svg+xml');
    expect(ALLOWED_STICKER_MIME.has(detectImageMime(SVG)!)).toBe(false);

    // 改名成 .png 也一样：闸门看的是字节
    write('猫猫/伪装的.png', SVG);
    const hit = resolveSticker('猫猫', '伪装的');
    // manifest 里 mime 按扩展名声明是 png（那只是声明）
    expect(hit?.mime).toBe('image/png');
    // 而按字节复核会认出 svg → 被 ALLOWED_STICKER_MIME 拒绝
    expect(detectImageMime(fs.readFileSync(hit!.absPath))).toBe('image/svg+xml');
  });

  it('不是图片的字节识别为 null（同样会被闸门拒绝）', () => {
    expect(detectImageMime(Buffer.from('not an image at all'))).toBeNull();
  });

  it('MAX_STICKER_BYTES 是个正数上限', () => {
    expect(MAX_STICKER_BYTES).toBeGreaterThan(0);
  });
});
