// ─────────────────────────────────────────────────────────────────────────────
// pwa-metadata.test.ts —— Web App 可安装性的契约
//
// 钉三件事：manifest 的安装必需字段（standalone / 相对根路径 / 192+512 普通与蒙版档）、
// 图标 src 真在盘上且 PNG 尺寸与声明一致、AddToHomeScreenGuide 的独立窗口判定；
// 末尾再跑一次 `node scripts/make-pwa-icons.mjs --check`，确保「脚本 ↔ 已入库台账」的自检真的在跑
// （Round4 移除了 pwa-assets.test.ts 的 sha256 逐文件比对，出图漂移由该脚本自检承接）。
//
// 主题色、逐像素留白属美术细节：改图调色不该让单测红，交给出图流程与页面检查。
// ─────────────────────────────────────────────────────────────────────────────

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import manifest from '@/app/manifest';
import { detectStandalone } from '@/app/components/AddToHomeScreenGuide';

const ROOT = path.resolve(import.meta.dirname, '../..');

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** 从 PNG 的 IHDR 里读宽高（不依赖第三方解码器，跨平台稳定）。 */
function pngSize(buf: Buffer): { width: number; height: number } {
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

describe('Web App 清单（app/manifest.ts）', () => {
  const m = manifest();

  it('身份字段：名字、相对根路径的 id/start_url/scope、standalone、zh-CN', () => {
    expect({ name: m.name, short: m.short_name }).toEqual({ name: '聪明山', short: '聪明山' });
    // 根路径 —— 换域名时仍在当前 origin 下打开
    expect([m.id, m.start_url, m.scope]).toEqual(['/', '/', '/']);
    expect([m.display, m.lang]).toEqual(['standalone', 'zh-CN']);
  });

  it('图标含 192/512 普通档与 192/512 蒙版档', () => {
    const icons = m.icons ?? [];
    const sizes = (purpose: string) =>
      icons.filter((i) => i.purpose === purpose).map((i) => i.sizes);
    expect(sizes('any')).toEqual(expect.arrayContaining(['192x192', '512x512']));
    expect(sizes('maskable')).toEqual(expect.arrayContaining(['192x192', '512x512']));
    // 每条都得有 type，否则部分平台会拒收
    for (const icon of icons) expect(icon.type).toBe('image/png');
  });

  it('清单里的每个 src 磁盘上都真有、且尺寸对得上', () => {
    for (const icon of m.icons ?? []) {
      const file = path.join(ROOT, 'public', icon.src.replace(/^\//, ''));
      expect(fs.existsSync(file), `清单里有 ${icon.src}，盘上却没有`).toBe(true);
      const buf = fs.readFileSync(file);
      expect(buf.subarray(0, 8).equals(PNG_SIG), `${icon.src} 不是 PNG`).toBe(true);
      const { width, height } = pngSize(buf);
      const [w, h] = (icon.sizes ?? '').split('x').map(Number);
      expect({ width, height }, `${icon.src} 的实际尺寸与声明的 ${icon.sizes} 不符`).toEqual({
        width: w,
        height: h,
      });
    }
  });
});

describe('AddToHomeScreenGuide 的独立窗口判定', () => {
  it('iOS 的 navigator.standalone 为 true → 独立窗口', () => {
    expect(detectStandalone({ navigator: { standalone: true } })).toBe(true);
  });

  it('display-mode: standalone 命中 → 独立窗口；两者都不命中 → 否（照常显示引导）', () => {
    expect(detectStandalone({ navigator: {}, matchMedia: () => ({ matches: true }) })).toBe(true);
    expect(detectStandalone({ navigator: {}, matchMedia: () => ({ matches: false }) })).toBe(false);
  });

  it('判不出来（matchMedia 抛异常 / 都没有）也当作不是独立窗口', () => {
    expect(detectStandalone({})).toBe(false);
    const throwing = {
      navigator: {},
      matchMedia: () => {
        throw new Error('boom');
      },
    };
    expect(detectStandalone(throwing)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 出图脚本自检：`--check` 是「生成脚本 ↔ 已入库图标/台账」唯一的自动比对入口。
// Round4 删掉了 pwa-assets.test.ts（逐文件 sha256 台账），这里只保证那道自检真的在跑；
// 它退出码非 0 时把 stderr 原样带进失败信息（否则只有一句 "Command failed"）。
// ─────────────────────────────────────────────────────────────────────────────

describe('make-pwa-icons --check', () => {
  it('退出码 0，且真的打印了「台账一致」的结论（不是空转）', () => {
    let stdout: string;
    try {
      stdout = execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'make-pwa-icons.mjs'), '--check'], {
        cwd: ROOT,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      const e = error as { status?: number; stderr?: string; stdout?: string };
      throw new Error(
        `make-pwa-icons --check 失败（exit ${e.status ?? '?'}）：\n${e.stderr || e.stdout || (error as Error).message}\n` +
          '修复：node scripts/make-pwa-icons.mjs，并把 public/static/img/pwa/ 的改动一起提交'
      );
    }
    expect(stdout).toContain('台账一致');
  });
});
