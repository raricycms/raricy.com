// ─────────────────────────────────────────────────────────────────────────────
// file-converter-image-codecs.test.ts —— 手写图片编解码器的**字节结构**对账。
//
// 【这组用例钉的是什么】image-codecs.ts 里的 BMP / ICO 编码器与 TIFF 封装都是
// 「自己拼字节」，没有上游库替我们把关。拼错一个字段不会抛异常，只会产出一张
// 打不开（或宽高错位）的图 —— 静默坏。所以这里**构造像素 → 编码 → 再用契约层
// inspect.ts 的 sniffBytes / imageHeaderInfo 回读**，让「写出的字节被本站自己的
// 识别器读成什么」成为判据（与 execute.ts 的输出复核同源）。
//
// 纯 node 环境：本文件**不**碰 DOM（image-canvas.ts），只用纯字节模块。
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from 'vitest';
import {
  encodeBmp,
  encodeIcoPng,
  encodeTiffRgba,
  decodeTiffRgba,
  rgbaHasAlpha,
  estimateRasterBytes,
  parseSvgSize,
  ICO_MAX_SIDE,
  type RgbaImage,
} from '@/lib/file-converter/engines/image-codecs';
import { sniffBytes, imageHeaderInfo } from '@/lib/file-converter/inspect';

type Rgba = [number, number, number, number];

/** 按 (x,y) 取色拼出 RGBA 像素缓冲。 */
function makeRgba(width: number, height: number, at: (x: number, y: number) => Rgba): RgbaImage {
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = at(x, y);
      const i = (y * width + x) * 4;
      rgba[i] = r;
      rgba[i + 1] = g;
      rgba[i + 2] = b;
      rgba[i + 3] = a;
    }
  }
  return { width, height, rgba };
}

const u16le = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8);
const u32le = (b: Uint8Array, o: number) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

describe('rgbaHasAlpha', () => {
  it('全不透明 → false；任一像素半透明 / 全透明 → true', () => {
    expect(rgbaHasAlpha(new Uint8Array([1, 2, 3, 255, 4, 5, 6, 255]))).toBe(false);
    expect(rgbaHasAlpha(new Uint8Array([1, 2, 3, 255, 4, 5, 6, 254]))).toBe(true);
    expect(rgbaHasAlpha(new Uint8Array([1, 2, 3, 0]))).toBe(true);
  });
});

describe('encodeBmp：24 位无透明', () => {
  // 2×2 四色，便于按 bottom-up / BGR 逐字节核对
  const img = makeRgba(2, 2, (x, y) =>
    x === 0 && y === 0
      ? [255, 0, 0, 255] // 左上 红
      : x === 1 && y === 0
        ? [0, 255, 0, 255] // 右上 绿
        : x === 0 && y === 1
          ? [0, 0, 255, 255] // 左下 蓝
          : [255, 255, 255, 255] // 右下 白
  );
  const bytes = encodeBmp(img);

  it('被 inspect 识别为 bmp 且回读宽高正确', () => {
    const head = bytes.slice(0, 4096);
    expect(sniffBytes(head).kind).toBe('bmp');
    expect(imageHeaderInfo('bmp', head)).toEqual({ width: 2, height: 2 });
  });

  it('头部字段符合 BI_RGB 规范（行对齐 + 底向上存储）', () => {
    expect(bytes[0]).toBe(0x42); // 'B'
    expect(bytes[1]).toBe(0x4d); // 'M'
    // 行 = 2*3=6 字节，补到 4 字节对齐 = 8；两行 + 14+40 头 = 70
    const rowSize = 8;
    const total = 14 + 40 + rowSize * 2;
    expect(u32le(bytes, 2)).toBe(total); // bfSize
    expect(u32le(bytes, 10)).toBe(14 + 40); // bfOffBits
    expect(u32le(bytes, 14)).toBe(40); // biSize
    expect(u32le(bytes, 18)).toBe(2); // biWidth
    expect(u32le(bytes, 22)).toBe(2); // biHeight（正 = bottom-up）
    expect(u16le(bytes, 28)).toBe(24); // biBitCount
    expect(u32le(bytes, 30)).toBe(0); // biCompression = BI_RGB
    expect(u32le(bytes, 34)).toBe(rowSize * 2); // biSizeImage
  });

  it('像素按 bottom-up + BGR 写出，行末补零', () => {
    const P = 14 + 40;
    // 先写底行（y=1）：左下蓝 → BGR(255,0,0)；右下白 → BGR(255,255,255)
    expect(Array.from(bytes.slice(P, P + 6))).toEqual([255, 0, 0, 255, 255, 255]);
    // 底行剩余 2 字节 padding 为零
    expect(Array.from(bytes.slice(P + 6, P + 8))).toEqual([0, 0]);
    // 再写顶行（y=0）：左上红 → BGR(0,0,255)；右上绿 → BGR(0,255,0)
    expect(Array.from(bytes.slice(P + 8, P + 14))).toEqual([0, 0, 255, 0, 255, 0]);
  });
});

describe('encodeBmp：32 位带透明', () => {
  const img = makeRgba(2, 1, (x) => (x === 0 ? [10, 20, 30, 128] : [40, 50, 60, 0]));
  const bytes = encodeBmp(img, { withAlpha: true });

  it('biBitCount=32，行天然对齐（无 padding）', () => {
    expect(u16le(bytes, 28)).toBe(32);
    const rowSize = 8; // 2 * 4
    expect(u32le(bytes, 2)).toBe(14 + 40 + rowSize);
    expect(u32le(bytes, 34)).toBe(rowSize);
  });

  it('保留 alpha 字节，BGRA 顺序', () => {
    const P = 14 + 40;
    // bottom-up：唯一一行，左像素 BGRA(30,20,10,128) 右像素 BGRA(60,50,40,0)
    expect(Array.from(bytes.slice(P, P + 8))).toEqual([30, 20, 10, 128, 60, 50, 40, 0]);
  });

  it('被 inspect 回读宽高仍正确', () => {
    expect(imageHeaderInfo('bmp', bytes.slice(0, 4096))).toEqual({ width: 2, height: 1 });
  });
});

describe('encodeBmp：参数守卫', () => {
  it('尺寸非正整数抛错', () => {
    expect(() => encodeBmp({ width: 0, height: 1, rgba: new Uint8Array(0) })).toThrow();
  });
  it('像素长度与尺寸不符抛错', () => {
    expect(() => encodeBmp({ width: 2, height: 2, rgba: new Uint8Array(4) })).toThrow();
  });
});

describe('encodeIcoPng：PNG-in-ICO 容器', () => {
  // 一张假的 PNG 载荷（编码器不解析 PNG，只按长度打包；用真签名让 sniff 更贴实）
  const pngPayload = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
  ]);

  it('被 inspect 识别为 ico，且回读宽高（64×48）正确', () => {
    const bytes = encodeIcoPng(pngPayload, 64, 48);
    const head = bytes.slice(0, 4096);
    expect(sniffBytes(head).kind).toBe('ico');
    expect(imageHeaderInfo('ico', head)).toEqual({ width: 64, height: 48, animated: false });
  });

  it('ICONDIR / ICONDIRENTRY 字段正确，PNG 载荷拼在 22 字节头之后', () => {
    const bytes = encodeIcoPng(pngPayload, 64, 48);
    expect(u16le(bytes, 0)).toBe(0); // idReserved
    expect(u16le(bytes, 2)).toBe(1); // idType = 图标
    expect(u16le(bytes, 4)).toBe(1); // idCount
    expect(bytes[6]).toBe(64); // bWidth
    expect(bytes[7]).toBe(48); // bHeight
    expect(bytes[8]).toBe(0); // bColorCount（≥8bpp 为 0）
    expect(u16le(bytes, 10)).toBe(1); // wPlanes
    expect(u16le(bytes, 12)).toBe(32); // wBitCount
    expect(u32le(bytes, 14)).toBe(pngPayload.length); // dwBytesInRes
    expect(u32le(bytes, 18)).toBe(22); // dwImageOffset
    expect(Array.from(bytes.slice(22))).toEqual(Array.from(pngPayload));
    expect(bytes.length).toBe(22 + pngPayload.length);
  });

  it('256 尺寸按 ICO 约定记 0，回读仍为 256', () => {
    const bytes = encodeIcoPng(pngPayload, ICO_MAX_SIDE, ICO_MAX_SIDE);
    expect(bytes[6]).toBe(0);
    expect(bytes[7]).toBe(0);
    expect(imageHeaderInfo('ico', bytes.slice(0, 4096))).toEqual({ width: 256, height: 256, animated: false });
  });

  it('超出 1–256 的尺寸抛错', () => {
    expect(() => encodeIcoPng(pngPayload, 300, 10)).toThrow();
    expect(() => encodeIcoPng(pngPayload, 0, 10)).toThrow();
  });
});

describe('TIFF（utif 封装）：RGBA 往返', () => {
  const img = makeRgba(4, 3, (x, y) => [x * 20, y * 40, (x + y) * 10, 255]);

  it('编码后被 inspect 识别为 tiff', async () => {
    const bytes = await encodeTiffRgba(img);
    expect(sniffBytes(bytes.slice(0, 4096)).kind).toBe('tiff');
  });

  it('解码回读尺寸与像素逐字节一致，且页数为 1', async () => {
    const bytes = await encodeTiffRgba(img);
    const back = await decodeTiffRgba(bytes);
    expect(back.width).toBe(4);
    expect(back.height).toBe(3);
    expect(back.pages).toBe(1);
    expect(Array.from(back.rgba)).toEqual(Array.from(img.rgba));
  });

  it('损坏字节解码抛错（调用方归类为 corrupt）', async () => {
    await expect(decodeTiffRgba(new Uint8Array([1, 2, 3, 4]))).rejects.toThrow();
  });
});

describe('estimateRasterBytes：量级与边界', () => {
  it('有损 0.25 B/px、PNG 1.5 B/px、BMP 按 RGBA 上界', () => {
    expect(estimateRasterBytes('jpeg', 100, 100)).toBe(2500);
    expect(estimateRasterBytes('webp', 100, 100)).toBe(2500);
    expect(estimateRasterBytes('png', 100, 100)).toBe(15000);
    expect(estimateRasterBytes('bmp', 100, 100)).toBe(54 + 100 * 100 * 4);
  });

  it('非法尺寸返回 null', () => {
    expect(estimateRasterBytes('png', 0, 100)).toBeNull();
    expect(estimateRasterBytes('png', NaN, 100)).toBeNull();
  });

  it('ico 先收敛到 256 再估', () => {
    const big = estimateRasterBytes('ico', 1000, 1000);
    const at256 = estimateRasterBytes('ico', 256, 256);
    expect(big).toBe(at256);
  });
});

describe('parseSvgSize：自身尺寸解析', () => {
  it('width / height 属性（含 px 单位）', () => {
    expect(parseSvgSize('<svg width="120" height="80"></svg>')).toEqual({ width: 120, height: 80 });
    expect(parseSvgSize("<svg width='120px' height='80px'/>")).toEqual({ width: 120, height: 80 });
  });

  it('缺属性时回退 viewBox 后两个数', () => {
    expect(parseSvgSize('<svg viewBox="0 0 300 200"></svg>')).toEqual({ width: 300, height: 200 });
  });

  it('单侧属性 + viewBox 补另一侧', () => {
    expect(parseSvgSize('<svg width="50" viewBox="0 0 300 200"></svg>')).toEqual({ width: 50, height: 200 });
  });

  it('相对单位（%）无法换算为像素 → null', () => {
    expect(parseSvgSize('<svg width="50%" height="50%"></svg>')).toEqual({ width: null, height: null });
  });

  it('没有 svg 根标签 → 全 null', () => {
    expect(parseSvgSize('<html></html>')).toEqual({ width: null, height: null });
  });
});
