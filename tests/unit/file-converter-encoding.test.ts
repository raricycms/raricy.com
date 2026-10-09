// ─────────────────────────────────────────────────────────────────────────────
// file-converter-encoding.test.ts —— 字符编码解码 / 编码 / 检测（node 环境）。
//
// 【为什么逐个钉】字符编码是「猜错不报错，只是整篇乱码」的典型：
//   · BOM 必须剥掉且要如实报告（剥漏了会在正文首行留一个不可见字符）；
//   · UTF-16 BE 的字节序自写换序，代理对 / 单双字节都要对；
//   · 自动检测是**候选判断**，GBK 双字节布局要能被识别为「猜的，不确信」。
// iconv-lite 在 node 下可用，所以非 UTF 系往返是真的在与库对账。
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from 'vitest';
import {
  decodeText,
  detectBom,
  detectEncoding,
  encodeText,
  encodingSupportsBom,
  hasUnrepresentable,
} from '@/lib/file-converter/engines/encoding';
import { CATEGORY } from '@/lib/file-converter/categories/text';
import { registryProblems } from '@/lib/file-converter/registry';
import type { InspectInfo } from '@/lib/file-converter/types';

const utf8 = (s: string) => new TextEncoder().encode(s);

// ─── 非 UTF 系往返（iconv-lite）──────────────────────────────────────────────

describe('非 UTF 编码往返', () => {
  it('GBK 往返中文', async () => {
    const bytes = await encodeText('中文测试，标点。', 'gbk');
    expect(bytes.length).toBeGreaterThan(0);
    const { text } = await decodeText(bytes, 'gbk');
    expect(text).toBe('中文测试，标点。');
  });

  it('GB18030 往返中文', async () => {
    const bytes = await encodeText('中文，端到端', 'gb18030');
    const { text } = await decodeText(bytes, 'gb18030');
    expect(text).toBe('中文，端到端');
  });

  it('Big5 往返繁体', async () => {
    const bytes = await encodeText('繁體中文', 'big5');
    const { text } = await decodeText(bytes, 'big5');
    expect(text).toBe('繁體中文');
  });

  it('Shift_JIS 往返日文', async () => {
    const bytes = await encodeText('日本語ABC', 'shift_jis');
    const { text } = await decodeText(bytes, 'shift_jis');
    expect(text).toBe('日本語ABC');
  });

  it('GBK 编码的「中文」字节确定（D6 D0 CE C4）', async () => {
    const bytes = await encodeText('中文', 'gbk');
    expect([...bytes]).toEqual([0xd6, 0xd0, 0xce, 0xc4]);
  });
});

// ─── UTF-16 LE / BE 的手写编解码 ─────────────────────────────────────────────

describe('UTF-16 手写编解码', () => {
  it('utf-16le 往返（含代理对 emoji）', async () => {
    const s = 'A你😀';
    const bytes = await encodeText(s, 'utf-16le');
    // 'A'=41 00，'你'=60 4F，😀=U+1F600 → D83D DE00 → 3D D8 00 DE
    expect([...bytes]).toEqual([0x41, 0x00, 0x60, 0x4f, 0x3d, 0xd8, 0x00, 0xde]);
    const { text } = await decodeText(bytes, 'utf-16le');
    expect(text).toBe(s);
  });

  it('utf-16be 往返（字节序与 LE 相反）', async () => {
    const s = 'A你😀';
    const bytes = await encodeText(s, 'utf-16be');
    expect([...bytes]).toEqual([0x00, 0x41, 0x4f, 0x60, 0xd8, 0x3d, 0xde, 0x00]);
    const { text } = await decodeText(bytes, 'utf-16be');
    expect(text).toBe(s);
  });

  it('utf-16be 解码走自写换序（TextDecoder 不保证支持 BE）', async () => {
    // 直接给 BE 字节：FEFF 是无 BOM 的 'A'(0041) + '你'(4F60)
    const bytes = new Uint8Array([0x00, 0x41, 0x4f, 0x60]);
    const { text } = await decodeText(bytes, 'utf-16be');
    expect(text).toBe('A你');
  });
});

// ─── BOM ─────────────────────────────────────────────────────────────────────

describe('BOM：一律剥掉并如实报告', () => {
  it('detectBom 三种签名', () => {
    expect(detectBom(new Uint8Array([0xef, 0xbb, 0xbf, 0x41]))).toEqual({ encoding: 'utf-8', length: 3 });
    expect(detectBom(new Uint8Array([0xff, 0xfe, 0x41, 0x00]))).toEqual({ encoding: 'utf-16le', length: 2 });
    expect(detectBom(new Uint8Array([0xfe, 0xff, 0x41, 0x00]))).toEqual({ encoding: 'utf-16be', length: 2 });
    expect(detectBom(utf8('hello'))).toBeNull();
  });

  it('UTF-8 BOM 被剥掉，正文不含 BOM', async () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...utf8('hello')]);
    const r = await decodeText(bytes, 'utf-8');
    expect(r.text).toBe('hello');
    expect(r.detectedBom).toBe('utf-8');
    expect(r.text.charCodeAt(0)).not.toBe(0xfeff);
  });

  it('utf-16le / utf-16be 带 BOM 的编解码往返', async () => {
    const le = await encodeText('hi', 'utf-16le', { bom: true });
    expect([...le.slice(0, 2)]).toEqual([0xff, 0xfe]);
    const rle = await decodeText(le, 'utf-16le');
    expect(rle.text).toBe('hi');
    expect(rle.detectedBom).toBe('utf-16le');

    const be = await encodeText('hi', 'utf-16be', { bom: true });
    expect([...be.slice(0, 2)]).toEqual([0xfe, 0xff]);
    const rbe = await decodeText(be, 'utf-16be');
    expect(rbe.text).toBe('hi');
    expect(rbe.detectedBom).toBe('utf-16be');
  });

  it("auto 解码按 BOM 选编码", async () => {
    const be = await encodeText('你好', 'utf-16be', { bom: true });
    const r = await decodeText(be, 'auto');
    expect(r.text).toBe('你好');
    expect(r.encoding).toBe('utf-16be');
  });

  it('非 UTF 目标加 BOM 选项无效（不产生额外字节）', async () => {
    const a = await encodeText('中文', 'gbk');
    const b = await encodeText('中文', 'gbk', { bom: true });
    expect([...b]).toEqual([...a]);
    expect(encodingSupportsBom('gbk')).toBe(false);
    expect(encodingSupportsBom('utf-8')).toBe(true);
  });
});

// ─── 自动检测（候选 + 置信度）────────────────────────────────────────────────

describe('detectEncoding：确定性判据', () => {
  it('空内容与 ASCII 按 UTF-8 且确信', () => {
    expect(detectEncoding(new Uint8Array())).toEqual({ encoding: 'utf-8', confident: true, reason: 'utf-8' });
    expect(detectEncoding(utf8('hello world'))).toEqual({ encoding: 'utf-8', confident: true, reason: 'utf-8' });
  });

  it('合法 UTF-8 中文 → utf-8 且确信', () => {
    const d = detectEncoding(utf8('中文字符'));
    expect(d.encoding).toBe('utf-8');
    expect(d.confident).toBe(true);
  });

  it('BOM 优先于试解', () => {
    const bytes = new Uint8Array([0xfe, 0xff, 0x00, 0x41]);
    expect(detectEncoding(bytes)).toEqual({ encoding: 'utf-16be', confident: true, reason: 'bom' });
  });

  it('GBK 中文（非法 UTF-8）→ 猜 GBK 且不确信', async () => {
    const bytes = await encodeText('中文测试', 'gbk');
    const d = detectEncoding(bytes);
    expect(d.encoding).toBe('gbk');
    expect(d.confident).toBe(false);
    expect(d.reason).toBe('heuristic');
  });
});

// ─── 目标编码写不出的字符 ────────────────────────────────────────────────────

describe('hasUnrepresentable（不能静默变问号）', () => {
  it('UTF 目标永不丢失', async () => {
    expect(await hasUnrepresentable('任意中文😀', 'utf-8')).toBe(false);
    expect(await hasUnrepresentable('任意中文😀', 'utf-16le')).toBe(false);
  });

  it('Latin-1 写不出中文 → 判为有损', async () => {
    expect(await hasUnrepresentable('中文', 'iso-8859-1')).toBe(true);
  });

  it('GBK 能表示的纯中文 → 无损', async () => {
    expect(await hasUnrepresentable('中文', 'gbk')).toBe(false);
  });
});

// ─── text 类别登记表体检（只体检本模块，不跑别人的用例）──────────────────────

describe('text 类别登记（本模块自洽）', () => {
  it('registryProblems 对本类别无问题', () => {
    expect(registryProblems([CATEGORY])).toEqual([]);
  });

  it('边界与参数形状', () => {
    expect(CATEGORY.key).toBe('text');
    const byId = new Map(CATEGORY.edges.map((e) => [e.id, e]));
    for (const id of [
      'text:convert-encoding',
      'text:txt-to-md',
      'text:txt-to-html',
      'text:subtitle-to-srt',
      'text:subtitle-to-vtt',
      'text:subtitle-to-ass',
    ]) {
      expect(byId.has(id), `缺边 ${id}`).toBe(true);
      expect(byId.get(id)!.status).toBe('live');
    }

    const enc = byId.get('text:convert-encoding')!;
    const keys = Object.fromEntries(enc.params.map((p) => [p.key, p]));
    expect(keys.fromEncoding.defaultValue).toBe('auto');
    expect(keys.toEncoding.defaultValue).toBe('utf-8');
    expect(keys.bom.defaultValue).toBe(false);
    const fromOpts = keys.fromEncoding.options as { value: string }[];
    expect(fromOpts[0].value).toBe('auto');
    expect(fromOpts.some((o) => o.value === 'gbk')).toBe(true);
  });

  it('字幕边的 match 排除同格式', () => {
    const at = (kind: InspectInfo['sniff']['kind']): InspectInfo => ({
      sniff: { kind, mime: 'text/plain', ext: kind },
      name: 'x',
      size: 1,
    });
    const matchOf = (id: string) => CATEGORY.edges.find((e) => e.id === id)!.match!;
    expect(matchOf('text:subtitle-to-srt')(at('srt'))).toBe(false);
    expect(matchOf('text:subtitle-to-srt')(at('vtt'))).toBe(true);
    expect(matchOf('text:subtitle-to-vtt')(at('vtt'))).toBe(false);
    expect(matchOf('text:subtitle-to-ass')(at('ass'))).toBe(false);
    expect(matchOf('text:subtitle-to-ass')(at('srt'))).toBe(true);
  });
});
