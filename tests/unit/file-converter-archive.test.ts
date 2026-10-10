// ─────────────────────────────────────────────────────────────────────────────
// file-converter-archive.test.ts —— 压缩包安全闸与 fflate 往返（node 环境）。
//
// 【为什么先钉安全闸】解压是本工具集里最容易被一行构造字节打爆内存的操作：
//   一个 42KB 的 ZIP 能解成 4GB。validateMembers 在**解压前**（只读中央目录）
//   把成员数 / 总量 / 深度 / 压缩比 / zip-slip 路径一次判完，全部由构造字节直接驱动。
//   fflate 的 zip/gzip 往返则钉住「我们交给引擎的字节与拿回来的字节一致」。
// ─────────────────────────────────────────────────────────────────────────────

import { describe, expect, it } from 'vitest';
import {
  gzipBytes,
  gzipIsize,
  gunzipBytes,
  sanitizeMemberPath,
  unzipAll,
  validateMembers,
  zipHasEncryptedEntry,
  zipMemberMetas,
  zipMembers,
} from '@/lib/file-converter/engines/archive';

const enc = new TextEncoder();
const dec = new TextDecoder();

// ─── sanitizeMemberPath（zip-slip / 绝对路径 / 盘符 / 反斜杠 / NUL）───────────

describe('sanitizeMemberPath', () => {
  it('正常相对路径保留（去掉 ./）', () => {
    expect(sanitizeMemberPath('a/b/c.txt')).toBe('a/b/c.txt');
    expect(sanitizeMemberPath('./a/./b.txt')).toBe('a/b.txt');
    expect(sanitizeMemberPath('单文件.txt')).toBe('单文件.txt');
  });

  it('拒绝上级目录（zip-slip）', () => {
    expect(sanitizeMemberPath('../evil')).toBeNull();
    expect(sanitizeMemberPath('a/../../evil')).toBeNull();
    expect(sanitizeMemberPath('..')).toBeNull();
  });

  it('拒绝绝对路径', () => {
    expect(sanitizeMemberPath('/etc/passwd')).toBeNull();
  });

  it('拒绝盘符', () => {
    expect(sanitizeMemberPath('C:/Windows')).toBeNull();
    expect(sanitizeMemberPath('d:file.txt')).toBeNull();
  });

  it('拒绝反斜杠混用', () => {
    expect(sanitizeMemberPath('a\\b.txt')).toBeNull();
    expect(sanitizeMemberPath('dir\\..\\evil')).toBeNull();
  });

  it('拒绝 NUL', () => {
    expect(sanitizeMemberPath('safe.txt\u0000.png')).toBeNull();
  });

  it('空 / 只有分隔符 → null', () => {
    expect(sanitizeMemberPath('///')).toBeNull();
    expect(sanitizeMemberPath('.')).toBeNull();
  });
});

// ─── validateMembers（硬上限）────────────────────────────────────────────────

const LIM = { maxMembers: 10, maxTotalUncompressed: 1_000_000, maxDepth: 10, maxRatio: 100 };

describe('validateMembers', () => {
  it('正常成员通过，safePath 就是净化后的路径', () => {
    const r = validateMembers([{ path: 'a.txt', size: 100 }, { path: 'dir/b.txt', size: 200, compressedSize: 100 }], LIM);
    expect(r.ok).toBe(true);
    expect(r.members.map((m) => m.safePath)).toEqual(['a.txt', 'dir/b.txt']);
  });

  it('成员数超限 → oversize', () => {
    const members = Array.from({ length: 5 }, (_, i) => ({ path: `f${i}.txt`, size: 1 }));
    const r = validateMembers(members, { ...LIM, maxMembers: 3 });
    expect(r.ok).toBe(false);
    expect(r.error?.kind).toBe('oversize');
  });

  it('解压总量超限 → oversize', () => {
    const r = validateMembers([{ path: 'a', size: 800 }, { path: 'b', size: 800 }], { ...LIM, maxTotalUncompressed: 1000 });
    expect(r.ok).toBe(false);
    expect(r.error?.kind).toBe('oversize');
  });

  it('目录层级超限 → oversize', () => {
    const r = validateMembers([{ path: 'a/b/c/d.txt', size: 1 }], { ...LIM, maxDepth: 2 });
    expect(r.ok).toBe(false);
    expect(r.error?.kind).toBe('oversize');
  });

  it('单成员压缩比超限（压缩炸弹）→ oversize', () => {
    const r = validateMembers([{ path: 'bomb', size: 100_000, compressedSize: 10 }], { ...LIM, maxRatio: 100, maxTotalUncompressed: 1_000_000 });
    expect(r.ok).toBe(false);
    expect(r.error?.kind).toBe('oversize');
    expect(r.error?.message).toContain('压缩比');
  });

  it('压缩后为 0 但有原始大小 = 无穷压缩比 → oversize', () => {
    const r = validateMembers([{ path: 'bomb', size: 1000, compressedSize: 0 }], LIM);
    expect(r.ok).toBe(false);
    expect(r.error?.kind).toBe('oversize');
  });

  it('压缩比在阈值内则通过（60x < 100）', () => {
    const r = validateMembers([{ path: 'ok', size: 600, compressedSize: 10 }], { ...LIM, maxRatio: 100, maxTotalUncompressed: 1_000_000 });
    expect(r.ok).toBe(true);
  });

  it('zip-slip 路径 → unsupported', () => {
    const r = validateMembers([{ path: '../../evil', size: 1 }], LIM);
    expect(r.ok).toBe(false);
    expect(r.error?.kind).toBe('unsupported');
  });

  it('重复名加序号（去重后 safePath 唯一）', () => {
    const r = validateMembers([{ path: 'a.txt', size: 1 }, { path: 'a.txt', size: 2 }], LIM);
    expect(r.ok).toBe(true);
    const paths = r.members.map((m) => m.safePath);
    expect(new Set(paths).size).toBe(2);
    expect(paths[0]).toBe('a.txt');
    expect(paths[1]).toBe('a-2.txt');
  });
});

// ─── fflate ZIP / GZIP 往返 ──────────────────────────────────────────────────

describe('fflate ZIP / GZIP', () => {
  it('zip → unzip 往返（路径与字节一致）', async () => {
    const a = enc.encode('hello');
    const b = enc.encode('世界');
    const zip = await zipMembers(
      [
        { path: 'a.txt', data: a },
        { path: 'dir/b.bin', data: b },
      ],
      6
    );
    // 首字节是 ZIP 签名
    expect(zip[0]).toBe(0x50);
    expect(zip[1]).toBe(0x4b);
    const out = await unzipAll(zip);
    const map = new Map(out.map((e) => [e.path, dec.decode(e.data)]));
    expect(map.get('a.txt')).toBe('hello');
    expect(map.get('dir/b.bin')).toBe('世界');
  });

  it('zipMemberMetas 读出成员体积', async () => {
    const data = enc.encode('1234567890');
    const zip = await zipMembers([{ path: 'x.txt', data }, { path: 'y.txt', data }], 6);
    const metas = zipMemberMetas(zip);
    expect(metas).not.toBeNull();
    expect(metas!.map((m) => m.path).sort()).toEqual(['x.txt', 'y.txt']);
    for (const m of metas!) {
      expect(m.size).toBe(10);
      expect(m.compressedSize).toBeGreaterThan(0);
    }
  });

  it('gzip → gunzip 往返；isize 正确', async () => {
    const data = enc.encode('gzip me please, gzip me please, gzip me please');
    const gz = await gzipBytes(data, 6);
    expect(gz[0]).toBe(0x1f);
    expect(gz[1]).toBe(0x8b);
    expect(gzipIsize(gz)).toBe(data.length);
    const back = await gunzipBytes(gz);
    expect(dec.decode(back)).toBe(dec.decode(data));
  });

  it('加密探测：正常 ZIP 返回 false，CD 标志位被翻起返回 true', async () => {
    const zip = await zipMembers([{ path: 'a.txt', data: enc.encode('hi') }], 6);
    expect(zipHasEncryptedEntry(zip)).toBe(false);
    // 找到中央目录头 PK\x01\x02，翻 GP 标志位 0（偏移 +8）
    let cdOff = -1;
    for (let i = 0; i + 4 <= zip.length; i++) {
      if (zip[i] === 0x50 && zip[i + 1] === 0x4b && zip[i + 2] === 0x01 && zip[i + 3] === 0x02) {
        cdOff = i;
        break;
      }
    }
    expect(cdOff).toBeGreaterThanOrEqual(0);
    zip[cdOff + 8] |= 0x01;
    expect(zipHasEncryptedEntry(zip)).toBe(true);
  });
});
