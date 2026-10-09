// ─────────────────────────────────────────────────────────────────────────────
// file-converter-tar.test.ts —— TAR 读写的逐字节钉死（node 环境）。
//
// 【为什么逐条钉】TAR 是 512 字节定长头 + 校验和，一个字节写错就是「解出来是乱码
//   或整个包被拒」。最容易静默坏掉的三处：中文名的**字节**长度（按字符数判会越界）、
//   长名的 pax / GNU 'L' 两条读取路径、nested 目录成员。
// ─────────────────────────────────────────────────────────────────────────────

import { describe, expect, it } from 'vitest';
import { buildTar, paxRecord, parseTar } from '@/lib/file-converter/engines/tar';

const enc = new TextEncoder();
const dec = new TextDecoder();

function roundTrip(name: string, data: Uint8Array, isDir = false) {
  const tar = buildTar([{ name, data, isDir, mtimeSec: 1700000000 }]);
  return parseTar(tar);
}

describe('buildTar / parseTar 往返', () => {
  it('短名文件：路径与字节一致', () => {
    const data = enc.encode('hello world');
    const members = roundTrip('notes/readme.txt', data);
    expect(members).toHaveLength(1);
    expect(members[0].path).toBe('notes/readme.txt');
    expect(members[0].isDir).toBe(false);
    expect(dec.decode(members[0].data)).toBe('hello world');
    expect(members[0].data.byteLength).toBe(data.byteLength);
  });

  it('中文文件名按 UTF-8 字节量长度（不按字符数）', () => {
    const name = '文档/这是一个比较长的中文文件名但仍在 100 字节内.txt';
    const members = roundTrip(name, enc.encode('内容'));
    expect(members[0].path).toBe(name);
    expect(dec.decode(members[0].data)).toBe('内容');
  });

  it('目录成员：路径以 / 结尾，data 为空', () => {
    const tar = buildTar([
      { name: 'dir/', data: new Uint8Array(0), isDir: true },
      { name: 'dir/a.txt', data: enc.encode('x') },
    ]);
    const members = parseTar(tar);
    expect(members.map((m) => [m.path, m.isDir])).toEqual([
      ['dir/', true],
      ['dir/a.txt', false],
    ]);
  });

  it('超长名（>100 字节）走 pax 头，读回原名', () => {
    const longName = 'very/long/path/' + 'x'.repeat(140) + '/file.txt';
    expect(enc.encode(longName).length).toBeGreaterThan(100);
    const members = roundTrip(longName, enc.encode('long'));
    expect(members[0].path).toBe(longName);
    expect(dec.decode(members[0].data)).toBe('long');
  });

  it('能塞进 ustar prefix 字段的名（100–255 字节）也读回原名', () => {
    const name = 'p'.repeat(120) + '/' + 'b'.repeat(60) + '.txt';
    expect(enc.encode(name).length).toBeGreaterThan(100);
    expect(enc.encode(name).length).toBeLessThanOrEqual(255);
    const members = roundTrip(name, enc.encode('prefixed'));
    expect(members[0].path).toBe(name);
  });

  it('校验和错误（篡改头）→ 抛 corrupt', () => {
    const tar = buildTar([{ name: 'a.txt', data: enc.encode('hi') }]);
    tar[0] = tar[0] ^ 0xff; // 翻一个名字字节，校验和必然对不上
    let err: unknown;
    try {
      parseTar(tar);
    } catch (e) {
      err = e;
    }
    expect((err as { kind?: string })?.kind).toBe('corrupt');
  });

  it('成员尺寸越界 → 抛 corrupt', () => {
    const tar = buildTar([{ name: 'a.txt', data: enc.encode('hi') }]);
    // 把 size 字段（124..136）改成一个大得越界的值；同时修正校验和以通过第一步
    const big = (9999).toString(8).padStart(11, '0');
    for (let i = 0; i < 11; i++) tar[124 + i] = big.charCodeAt(i);
    tar[135] = 0;
    // 重算校验和，让失败点落在尺寸检查而不是校验和
    for (let i = 148; i < 156; i++) tar[i] = 0x20;
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += tar[i];
    const oct = sum.toString(8).padStart(6, '0');
    for (let i = 0; i < 6; i++) tar[148 + i] = oct.charCodeAt(i);
    tar[154] = 0;
    tar[155] = 0x20;
    let err: unknown;
    try {
      parseTar(tar);
    } catch (e) {
      err = e;
    }
    expect((err as { kind?: string }).kind).toBe('corrupt');
  });
});

// ─── GNU 'L' 长名头（读端必须认）──────────────────────────────────────────────
//
// 手搓一个 GNU 长名 TAR：typeflag 'L' 的成员，正文是长名（NUL 结尾），覆盖下一个成员。

function mkHeader(name: string, size: number, typeflag: number): Uint8Array {
  const h = new Uint8Array(512);
  const nb = enc.encode(name);
  h.set(nb.subarray(0, Math.min(nb.length, 100)), 0);
  const octal = (off: number, len: number, v: number) => {
    const s = v.toString(8).padStart(len - 1, '0');
    for (let i = 0; i < len - 1; i++) h[off + i] = s.charCodeAt(i);
    h[off + len - 1] = 0;
  };
  octal(100, 8, 0o644);
  octal(124, 12, size);
  octal(136, 12, 0);
  h[156] = typeflag;
  h.set(enc.encode('ustar'), 257);
  h[263] = 0x30;
  h[264] = 0x30;
  for (let i = 148; i < 156; i++) h[i] = 0x20;
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += h[i];
  const oct = sum.toString(8).padStart(6, '0');
  for (let i = 0; i < 6; i++) h[148 + i] = oct.charCodeAt(i);
  h[154] = 0;
  h[155] = 0x20;
  return h;
}

function pad512(data: Uint8Array): Uint8Array {
  const pad = (512 - (data.length % 512)) % 512;
  const out = new Uint8Array(data.length + pad);
  out.set(data, 0);
  return out;
}

describe('GNU / pax 长名读取', () => {
  it("GNU 'L' 长名头：下一个成员用长名", () => {
    const longName = 'gnu/' + 'z'.repeat(130) + '.txt';
    const nameBytes = enc.encode(longName + '\0');
    const content = enc.encode('gnu-body');
    const parts = [
      mkHeader('././@LongLink', nameBytes.length, 0x4c),
      pad512(nameBytes),
      mkHeader('trunc', content.length, 0x30),
      pad512(content),
      new Uint8Array(1024),
    ];
    const total = parts.reduce((s, p) => s + p.length, 0);
    const tar = new Uint8Array(total);
    let off = 0;
    for (const p of parts) {
      tar.set(p, off);
      off += p.length;
    }
    const members = parseTar(tar);
    expect(members).toHaveLength(1);
    expect(members[0].path).toBe(longName);
    expect(dec.decode(members[0].data)).toBe('gnu-body');
  });

  it('paxRecord 的长度前缀自洽', () => {
    const rec = paxRecord('path', 'abc/def');
    const text = dec.decode(rec);
    const len = parseInt(text.slice(0, text.indexOf(' ')), 10);
    expect(len).toBe(rec.length);
    expect(text.endsWith('\n')).toBe(true);
    expect(text).toContain('path=abc/def');
  });
});

describe('parseTar 限额', () => {
  it('成员数超限 → oversize', () => {
    const entries = Array.from({ length: 5 }, (_, i) => ({ name: `f-${i}.txt`, data: enc.encode(String(i)) }));
    const tar = buildTar(entries);
    let err: unknown;
    try {
      parseTar(tar, { maxMembers: 3 });
    } catch (e) {
      err = e;
    }
    expect((err as { kind?: string }).kind).toBe('oversize');
  });

  it('目录层级超限 → oversize', () => {
    const tar = buildTar([{ name: 'a/b/c/d/e/deep.txt', data: enc.encode('x') }]);
    let err: unknown;
    try {
      parseTar(tar, { maxDepth: 3 });
    } catch (e) {
      err = e;
    }
    expect((err as { kind?: string }).kind).toBe('oversize');
  });

  it('解压总量超限 → oversize', () => {
    const tar = buildTar([{ name: 'big.txt', data: new Uint8Array(4096) }]);
    let err: unknown;
    try {
      parseTar(tar, { maxTotalBytes: 100 });
    } catch (e) {
      err = e;
    }
    expect((err as { kind?: string }).kind).toBe('oversize');
  });
});
