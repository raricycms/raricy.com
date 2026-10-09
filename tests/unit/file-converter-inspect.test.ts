// file-converter/inspect.ts —— 内容识别（嗅探）。
//
// 【这组用例钉的是什么】plan §3.2「以字节内容为准」：kind 必须由魔数 / 结构给出，
// 与文件名无关。这里喂的全是**构造字节**，不读任何真实样本文件 ——
// 样本文件进仓库只会让测试脆弱（体积、授权、二进制 diff）。
// ZIP 系容器（docx/xlsx/pptx/epub）用 fflate 现构，钉的是中央目录的读法，
// 不是某个真文件长什么样。

import { describe, it, expect } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import { sniffBytes, imageHeaderInfo, buildInspectInfo, readZipCentralDirectory, parseEocd } from '@/lib/file-converter/inspect';

const u8 = (...bytes: number[]) => new Uint8Array(bytes);
const ascii = (s: string) => new Uint8Array([...s].map((c) => c.charCodeAt(0)));
const cat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
};

describe('sniffBytes：魔数识别', () => {
  const cases: Array<[string, Uint8Array, string]> = [
    ['jpeg', u8(0xff, 0xd8, 0xff, 0xe0), 'jpeg'],
    ['png', u8(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a), 'png'],
    ['gif', ascii('GIF89a'), 'gif'],
    ['webp', cat(ascii('RIFF'), u8(0, 0, 0, 0), ascii('WEBP')), 'webp'],
    ['wav', cat(ascii('RIFF'), u8(0, 0, 0, 0), ascii('WAVE')), 'wav'],
    ['avi', cat(ascii('RIFF'), u8(0, 0, 0, 0), ascii('AVI ')), 'avi'],
    ['bmp', ascii('BM'), 'bmp'],
    ['tiff-le', u8(0x49, 0x49, 0x2a, 0x00), 'tiff'],
    ['tiff-be', u8(0x4d, 0x4d, 0x00, 0x2a), 'tiff'],
    ['ico', u8(0x00, 0x00, 0x01, 0x00), 'ico'],
    ['flac', ascii('fLaC'), 'flac'],
    ['ogg', ascii('OggS'), 'ogg'],
    ['mp3-id3', ascii('ID3'), 'mp3'],
    ['mp3-sync', u8(0xff, 0xfb, 0x90, 0x00), 'mp3'],
    ['aiff', cat(ascii('FORM'), u8(0, 0, 0, 0), ascii('AIFF')), 'aiff'],
    ['mkv', u8(0x1a, 0x45, 0xdf, 0xa3), 'mkv'],
    ['flv', ascii('FLV'), 'flv'],
    ['pdf', ascii('%PDF-1.7\n'), 'pdf'],
    ['ole-doc', u8(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1), 'doc'],
    ['gzip', u8(0x1f, 0x8b, 0x08), 'gzip'],
    ['xz', u8(0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00), 'xz'],
    ['7z', u8(0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c), '7z'],
    ['rar4', cat(ascii('Rar!'), u8(0x1a, 0x07, 0x00)), 'rar'],
  ];

  for (const [label, bytes, kind] of cases) {
    it(`${label} → ${kind}`, () => {
      expect(sniffBytes(bytes).kind).toBe(kind);
    });
  }

  it('rar 需要完整签名（Rar!\\x1a\\x07\\x00）', () => {
    expect(sniffBytes(cat(ascii('Rar!'), u8(0x1a, 0x07, 0x00))).kind).toBe('rar');
    expect(sniffBytes(cat(ascii('Rar!'), u8(0x1a, 0x07, 0x01, 0x00))).kind).toBe('rar');
  });

  it('ftyp 品牌：heic / avif / m4a / mov / mp4', () => {
    const ftyp = (brand: string) => cat(u8(0, 0, 0, 0x18), ascii('ftyp'), ascii(brand), u8(0, 0, 0, 0));
    expect(sniffBytes(ftyp('heic')).kind).toBe('heic');
    expect(sniffBytes(ftyp('avif')).kind).toBe('avif');
    expect(sniffBytes(ftyp('M4A ')).kind).toBe('m4a');
    expect(sniffBytes(ftyp('qt  ')).kind).toBe('mov');
    expect(sniffBytes(ftyp('isom')).kind).toBe('mp4');
  });

  it('tar：ustar 魔数在 257 偏移', () => {
    const b = new Uint8Array(300);
    b.set(ascii('ustar'), 257);
    expect(sniffBytes(b).kind).toBe('tar');
  });

  it('空输入与含 NUL 的二进制 → unknown', () => {
    expect(sniffBytes(u8()).kind).toBe('unknown');
    expect(sniffBytes(u8(0x01, 0x00, 0x02)).kind).toBe('unknown');
  });
});

describe('sniffBytes：文本启发式', () => {
  const sniffText = (s: string) => sniffBytes(new TextEncoder().encode(s));

  it('WEBVTT / SRT / ASS', () => {
    expect(sniffText('WEBVTT\n\n00:00.000 --> 00:01.000\nhi').kind).toBe('vtt');
    expect(sniffText('1\n00:00:01,000 --> 00:00:02,000\n你好').kind).toBe('srt');
    expect(sniffText('[Script Info]\nTitle: x').kind).toBe('ass');
  });

  it('JSON / NDJSON / 坏了的 JSON 仍是 json（带说明）', () => {
    expect(sniffText('{"a": 1}').kind).toBe('json');
    expect(sniffText('{"a":1}\n{"b":2}\n').kind).toBe('ndjson');
    const broken = sniffText('{"a": ');
    expect(broken.kind).toBe('json');
    expect(broken.detail).toContain('未能完整解析');
  });

  it('CSV / TSV：多行且分隔符数量一致', () => {
    expect(sniffText('a,b,c\n1,2,3\n4,5,6').kind).toBe('csv');
    expect(sniffText('a\tb\n1\t2').kind).toBe('tsv');
  });

  it('Markdown / XML / HTML / 纯文本', () => {
    expect(sniffText('# 标题\n正文').kind).toBe('markdown');
    expect(sniffText('<?xml version="1.0"?><root></root>').kind).toBe('xml');
    expect(sniffText('<!DOCTYPE html>\n<html><body></body></html>').kind).toBe('html');
    expect(sniffText('就是一段普通的话。').kind).toBe('text');
  });

  it('UTF-8 BOM 剥落后继续按内容识别', () => {
    const withBom = cat(u8(0xef, 0xbb, 0xbf), new TextEncoder().encode('{"a": 1}'));
    expect(sniffBytes(withBom).kind).toBe('json');
  });
});

describe('imageHeaderInfo：尺寸与动画标记（plan §3.1 的动画闸）', () => {
  const pngHeader = (w: number, h: number, extra: Uint8Array = u8()) => {
    const wh = u8((w >>> 24) & 255, (w >>> 16) & 255, (w >>> 8) & 255, w & 255, (h >>> 24) & 255, (h >>> 16) & 255, (h >>> 8) & 255, h & 255);
    // IHDR 数据必须凑满 13 字节（宽高 8 + 位深/色彩等 5）并带 4 字节 CRC ——
    // 块遍历按 len+type+data+crc（12+len）跳步，缺了 CRC 后面的 acTL 就永远走不到。
    return cat(u8(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a), u8(0, 0, 0, 13), ascii('IHDR'), wh, u8(8, 6, 0, 0, 0), u8(0, 0, 0, 0), extra);
  };

  it('PNG 宽高（BE，偏移 16/20）', () => {
    const h = imageHeaderInfo('png', pngHeader(640, 480));
    expect(h.width).toBe(640);
    expect(h.height).toBe(480);
    expect(h.animated).toBeUndefined();
  });

  it('APNG：acTL 块 → animated', () => {
    const actl = cat(u8(0, 0, 0, 8), ascii('acTL'), u8(0, 0, 0, 0, 0, 0, 0, 0));
    expect(imageHeaderInfo('png', cat(pngHeader(10, 10), actl)).animated).toBe(true);
  });

  it('GIF：宽高 LE；第二个 0x2C → animated', () => {
    const still = cat(ascii('GIF89a'), u8(0x80, 0x02, 0xe0, 0x01), u8(0, 0, 0));
    const h1 = imageHeaderInfo('gif', still);
    expect(h1.width).toBe(640);
    expect(h1.height).toBe(480);
    expect(h1.animated).toBe(false);
    const anim = cat(still, u8(0x2c, 1, 2, 0x2c));
    expect(imageHeaderInfo('gif', anim).animated).toBe(true);
  });

  it('JPEG：扫到 SOF0 取宽高', () => {
    // FF D8 | FF C0 len=17 08 | H(2BE) W(2BE) | 分量数 —— 尾部多给一字节，
    // jpegHeader 的循环条件要求 off+9 < length，短一字节整段扫不到。
    const jpg = cat(u8(0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08), u8(0x01, 0xe0, 0x02, 0x80), u8(0x03));
    const h = imageHeaderInfo('jpeg', jpg);
    expect(h.width).toBe(640);
    expect(h.height).toBe(480);
  });

  it('ICO：取第一张的宽高；多尺寸**不算动画**（那是分辨率变体，不是帧）', () => {
    const ico = u8(0, 0, 1, 0, 2, 0, 32, 32);
    const h = imageHeaderInfo('ico', ico);
    expect(h.width).toBe(32);
    // 曾经这里断言 true —— 那是一个错的口径：多尺寸 .ico 会被静态边当成动图拒掉，
    // 而真正要挡的是 GIF / APNG / 动图 WebP。判据是容器语义，不是「装了几张图」。
    expect(h.animated).toBe(false);
  });

  it('TIFF：宽高按**字段类型**读 —— SHORT 两种字节序都要对，LONG 也行', () => {
    // ★ 这组用例钉的是一个只在**大端**下现形的读法错误 ★
    // 基线 TIFF 的宽高是 SHORT（类型 3，2 字节），值内联在 12 字节条目的值域里。
    // 一律按 u32 读的话，大端文件里那 2 字节落在值域高位 → 宽度变成 w<<16；
    // 小端恰好读对，所以这个错在只有小端样本时完全看不出来（utif 写的正是大端）。
    const entry = (tag: number, type: number, value: number, be: boolean): number[] => {
      const u16 = (n: number) => (be ? [n >> 8, n & 0xff] : [n & 0xff, n >> 8]);
      const u32 = (n: number) => (be ? [n >>> 24, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff] : [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, n >>> 24]);
      // 值域恒 4 字节：SHORT(count=1) 写在前两字节（该文件字节序）、后两字节留零；
      // LONG 占满 4 字节。类型不同、值域的用法就不同 —— 这正是被测的那点。
      const valueField = type === 3 ? [...u16(value), 0, 0] : u32(value);
      return [...u16(tag), ...u16(type), ...u32(1), ...valueField];
    };
    const tiff = (be: boolean, w: number, h: number, type = 3): Uint8Array => {
      const u16 = (n: number) => (be ? [n >> 8, n & 0xff] : [n & 0xff, n >> 8]);
      const u32 = (n: number) => (be ? [n >>> 24, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff] : [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, n >>> 24]);
      return u8(
        ...(be ? [0x4d, 0x4d] : [0x49, 0x49]),
        ...u16(42),
        ...u32(8),
        ...u16(2),
        ...entry(256, type, w, be),
        ...entry(257, type, h, be),
        ...u32(0)
      );
    };
    // 大端 SHORT（utif 的产物）—— 修复前这里会得到 640<<16
    expect(imageHeaderInfo('tiff', tiff(true, 640, 480))).toEqual({ width: 640, height: 480 });
    // 小端 SHORT：修复前后都对，留作回归
    expect(imageHeaderInfo('tiff', tiff(false, 640, 480))).toEqual({ width: 640, height: 480 });
    // LONG（类型 4，4 字节）两种字节序
    expect(imageHeaderInfo('tiff', tiff(true, 800, 600, 4))).toEqual({ width: 800, height: 600 });
    expect(imageHeaderInfo('tiff', tiff(false, 800, 600, 4))).toEqual({ width: 800, height: 600 });
  });

  it('非图片 kind → {}', () => {
    expect(imageHeaderInfo('mp3', u8(1, 2, 3))).toEqual({});
  });
});

describe('ZIP 中央目录与容器细分', () => {
  const zip = (entries: Record<string, string>) =>
    zipSync(Object.fromEntries(Object.entries(entries).map(([k, v]) => [k, strToU8(v)])));

  it('普通 zip：members 读出、container=zip', () => {
    const b = zip({ 'a.txt': 'hello', 'dir/b.txt': 'world' });
    const cd = readZipCentralDirectory(b);
    expect(cd).not.toBeNull();
    expect(cd!.container).toBe('zip');
    expect(cd!.members.map((m) => m.path).sort()).toEqual(['a.txt', 'dir/b.txt']);
  });

  it('docx / xlsx / pptx / epub / odt 按成员名单细分', () => {
    expect(readZipCentralDirectory(zip({ 'word/document.xml': '<x/>' }))!.container).toBe('docx');
    expect(readZipCentralDirectory(zip({ 'xl/workbook.xml': '<x/>' }))!.container).toBe('xlsx');
    expect(readZipCentralDirectory(zip({ 'ppt/presentation.xml': '<x/>' }))!.container).toBe('pptx');
    expect(
      readZipCentralDirectory(zip({ mimetype: 'application/epub+zip', 'OEBPS/content.opf': '<x/>' }))!.container
    ).toBe('epub');
    expect(readZipCentralDirectory(zip({ 'content.xml': '<x/>', 'styles.xml': '<y/>' }))!.container).toBe('odt');
  });

  it('损坏结构（无 EOCD）返回 null', () => {
    expect(readZipCentralDirectory(u8(0x50, 0x4b, 0x03, 0x04, 1, 2, 3))).toBeNull();
  });

  it('parseEocd 从尾窗读成员数与 CD 偏移', () => {
    const b = zip({ 'a.txt': 'x', 'b.txt': 'y' });
    const tail = b.subarray(Math.max(0, b.length - 4096));
    const eocd = parseEocd(tail);
    expect(eocd).not.toBeNull();
    expect(eocd!.count).toBe(2);
  });

  it('buildInspectInfo：docx 的 sniff.kind 被细分为 docx，members 填充', () => {
    const b = zip({ 'word/document.xml': '<x/>' });
    const info = buildInspectInfo('报告.zip', b.length, b, b);
    expect(info.sniff.kind).toBe('docx');
    expect(info.members?.length).toBe(1);
  });

  it('buildInspectInfo：图片带上宽高；动画标记进入 InspectInfo', () => {
    const png = cat(
      u8(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a),
      u8(0, 0, 0, 13),
      ascii('IHDR'),
      u8(0, 0, 0, 100, 0, 0, 0, 50)
    );
    const info = buildInspectInfo('x.png', png.length, png, null);
    expect(info.sniff.kind).toBe('png');
    expect(info.width).toBe(100);
    expect(info.height).toBe(50);
  });
});
