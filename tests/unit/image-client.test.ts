// ─────────────────────────────────────────────────────────────────────────────
// image-client.test.ts —— 上传前的归一化（按字节认类型 / 纠正声明 / HEIC → JPEG）
//
// 【为什么用 node 环境而不是 jsdom】这段代码只碰 File / Blob / slice / arrayBuffer，
// Node 20+ 全都原生有；而 jsdom 的 Blob **没有 `arrayBuffer()`**（真实浏览器有），
// 用它反而要额外垫一层 —— 测的就不再是线上那条路了。
//
// 【为什么这段值得单独钉】它就是「文件内容与声明的格式不匹配」这条报错的解药：
//   · 位图的声明错了（PNG 存成 .jpg、Windows 给不出 type）→ **按内容纠正**，不拒；
//   · iPhone 的 HEIC → 浏览器里就地转 JPEG（服务端没有 HEVC 解码器）；
//   · 实况照片的 .MOV / AVIF → 讲清楚它是什么，并指到 /tool/convert；
//   · SVG 在只收位图的入口（讨论 / 评论 / 编辑器）挡掉 —— raw 路由对它强制附件，
//     <img> 内联必然失败，放进去只会得到一张裂图。
//
// heic2any 是 WASM + Worker 的浏览器引擎，node 里跑不起来 —— 这里用 vi.mock 替掉它，
// 只验「转出来之后我们怎么包装」这一段（真解码由 /tool/convert 那条路长期在跑）。
// ─────────────────────────────────────────────────────────────────────────────

import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const { heic2anyMock } = vi.hoisted(() => ({
  heic2anyMock: vi.fn(
    async () => new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], { type: 'image/jpeg' })
  ),
}));
vi.mock('heic2any', () => ({ default: heic2anyMock }));

import { isUploadableImage, prepareImageFile } from '@/lib/image-client';

const PNG_SIG: Uint8Array<ArrayBuffer> = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0,
]);
const SVG: Uint8Array<ArrayBuffer> = new TextEncoder().encode(
  '<svg xmlns="http://www.w3.org/2000/svg"></svg>'
);

/** 最小 ISOBMFF 头（ftyp）。HEIC / MOV 的识别依据就是主品牌。 */
function ftyp(majorBrand: string): Uint8Array<ArrayBuffer> {
  const head = new Uint8Array(20);
  const view = new DataView(head.buffer);
  view.setUint32(0, 20);
  head.set(new TextEncoder().encode('ftyp'), 4);
  head.set(new TextEncoder().encode(majorBrand.padEnd(4, ' ').slice(0, 4)), 8);
  head.set(new TextEncoder().encode('mif1'), 16);
  return head;
}

function file(bytes: Uint8Array<ArrayBuffer>, name: string, type: string): File {
  return new File([bytes], name, { type });
}

describe('isUploadableImage（批次闸门用）', () => {
  it('四种位图收', () => {
    for (const [type, name] of [
      ['image/png', 'a.png'],
      ['image/jpeg', 'a.jpg'],
      ['image/gif', 'a.gif'],
      ['image/webp', 'a.webp'],
    ]) {
      expect(isUploadableImage(file(PNG_SIG, name, type)), type).toBe(true);
    }
  });

  it('HEIC 收（会在浏览器里转码），SVG / 文本不收', () => {
    expect(isUploadableImage(file(ftyp('heic'), 'IMG_0001.HEIC', 'image/heic'))).toBe(true);
    expect(isUploadableImage(file(SVG, 'a.svg', 'image/svg+xml'))).toBe(false);
    expect(isUploadableImage(file(PNG_SIG, 'a.txt', 'text/plain'))).toBe(false);
  });

  it('浏览器给不出 type 时看后缀 —— 否则 Windows 上的 HEIC 根本进不了闸门', () => {
    expect(isUploadableImage(file(ftyp('heic'), 'IMG_0001.HEIC', ''))).toBe(true);
    expect(isUploadableImage(file(PNG_SIG, 'shot.png', ''))).toBe(true);
    expect(isUploadableImage(file(PNG_SIG, 'note.txt', ''))).toBe(false);
  });

  it('★ 「没有声明」的口径与服务端同一份（binary/octet-stream 也是）', () => {
    // 服务端与 uploadImageFile 都收，编辑器闸门却把它丢掉的话，那张图在编辑器里
    // 会静默消失 —— 两处必须认同一组「无声明」值。
    for (const type of ['application/octet-stream', 'binary/octet-stream']) {
      expect(isUploadableImage(file(PNG_SIG, 'shot.png', type)), type).toBe(true);
    }
  });

  it('★ 空 type + 发不出去的格式不算 —— 别把 BMP / TIFF 算进批次体积', () => {
    expect(isUploadableImage(file(PNG_SIG, 'scan.bmp', ''))).toBe(false);
    expect(isUploadableImage(file(PNG_SIG, 'photo.tiff', ''))).toBe(false);
    expect(isUploadableImage(file(PNG_SIG, 'anim.avif', ''))).toBe(false);
  });

  it('零字节的"文件"不算（浏览器有时会给一个空壳）', () => {
    expect(isUploadableImage(file(new Uint8Array(0), 'a.png', 'image/png'))).toBe(false);
  });
});

describe('prepareImageFile（按字节纠正）', () => {
  it('声明错了就按内容纠正，不拒（PNG 存成 .jpg 是用户最常撞的一种）', async () => {
    const out = await prepareImageFile(file(PNG_SIG, 'photo.jpg', 'image/jpeg'));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.file.type).toBe('image/png');
    expect(out.file.name).toBe('photo.png');
  });

  it('浏览器给不出 type → 照收', async () => {
    const out = await prepareImageFile(file(PNG_SIG, 'shot', ''));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.file.type).toBe('image/png');
    expect(out.file.name).toBe('shot.png');
  });

  it('★ SVG 在只收位图的入口被挡（raw 路由对它强制附件，内联必裂）', async () => {
    const out = await prepareImageFile(file(SVG, 'a.svg', 'image/svg+xml'));
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.message).toContain('PNG');
  });

  it('图床页（allowSvg）可以传 SVG', async () => {
    const out = await prepareImageFile(file(SVG, 'a.svg', 'image/svg+xml'), { allowSvg: true });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.file.type).toBe('image/svg+xml');
  });

  it('★ 实况照片的 .MOV → 说明它是动态部分，不是图片', async () => {
    const out = await prepareImageFile(file(ftyp('qt  '), 'IMG_0003.MOV', 'video/quicktime'));
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.message).toContain('实况照片');
  });

  it('AVIF → 指到站内格式转换器', async () => {
    const out = await prepareImageFile(file(ftyp('avif'), 'a.avif', 'image/avif'));
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.message).toContain('/tool/convert');
  });

  it('★ HEIC → 转成 JPEG（类型与后缀一起改，否则服务端又会拿到一个错名字）', async () => {
    heic2anyMock.mockClear();
    const out = await prepareImageFile(file(ftyp('heic'), 'IMG_0001.HEIC', 'image/heic'));
    expect(heic2anyMock).toHaveBeenCalledTimes(1);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.file.type).toBe('image/jpeg');
    expect(out.file.name).toBe('IMG_0001.jpg');
  });

  it('HEIC 解码失败 → 不抛，回一句能行动的话', async () => {
    heic2anyMock.mockRejectedValueOnce(new Error('boom'));
    const out = await prepareImageFile(file(ftyp('heic'), 'broken.heic', 'image/heic'));
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.message).toContain('/tool/convert');
  });
});

describe('接线：图床页是唯一放行 SVG 的入口', () => {
  // 这条是**静态接线断言**：allowSvg 是参数，删掉实参测试照样全绿，而图床页会静默
  // 变成「SVG 传不上去」—— 页面没报错，用户只看到一句「仅支持 PNG / JPEG…」。
  it('ImageUploader 调 prepareImageFile 时带 allowSvg: true', () => {
    const src = fs.readFileSync(
      path.resolve(import.meta.dirname, '../../src/app/components/ImageUploader.tsx'),
      'utf8'
    );
    expect(src).toMatch(/prepareImageFile\(file,\s*\{\s*allowSvg:\s*true\s*\}\)/);
  });
});

