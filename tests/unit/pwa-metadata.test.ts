// ─────────────────────────────────────────────────────────────────────────────
// pwa-metadata.test.ts —— Web App 元数据（第一档）的三件事
//
//   1. app/manifest.ts 的字段与图标清单符合预期（相对根路径、standalone、zh-CN…）；
//   2. public/static/img/pwa/ 里入库的 PNG **就是出图脚本的产物**、尺寸 / 不透明性 /
//      安全区留白都对（同 frame-assets.test.ts 那道台账守卫的思路）；
//   3. app/layout.tsx 的 viewport / Apple 元数据没被改坏，且**没有**顺手禁用缩放；
//   4. AddToHomeScreenGuide 的独立窗口判定在四种输入下的行为。
//
// 为什么不 import layout.tsx 而扫源码：它 import 了 SCSS 与拖 prisma 的服务端模块，
// 在 vitest 的 node 环境里根本加载不起来。这类「静态契约」用源码扫描钉，与
// avatar-sites-guard / blog-visibility-guard 同款。
// ─────────────────────────────────────────────────────────────────────────────

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import manifest from '@/app/manifest';
import { detectStandalone } from '@/app/components/AddToHomeScreenGuide';

const ROOT = path.resolve(import.meta.dirname, '../..');
const PWA_DIR = path.join(ROOT, 'public', 'static', 'img', 'pwa');
const LEDGER = path.join(PWA_DIR, 'manifest.json');
const GENERATOR = path.join(ROOT, 'scripts', 'make-pwa-icons.mjs');
const LAYOUT = path.join(ROOT, 'src', 'app', 'layout.tsx');

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** 站点浅色页面底色，与 manifest 的 background_color 同值。 */
const BG = [0xf8, 0xfa, 0xfc];

function sha256(file: string): string {
  const bytes = fs.readFileSync(file);
  const content = file === GENERATOR ? bytes.toString('utf8').replace(/\r\n/g, '\n') : bytes;
  return createHash('sha256').update(content).digest('hex');
}

/** 从 PNG 的 IHDR 里读宽高（不定位于任何第三方解码器，跨平台稳定）。 */
function pngSize(buf: Buffer): { width: number; height: number } {
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

interface Ledger {
  generator: string;
  generatorSha256: string;
  files: Record<string, string>;
}

function readLedger(): Ledger {
  expect(
    fs.existsSync(LEDGER),
    `缺少 ${path.relative(ROOT, LEDGER)} —— 它由出图脚本写、随素材入库。` +
      `跑一次 \`node scripts/make-pwa-icons.mjs\`。`
  ).toBe(true);
  return JSON.parse(fs.readFileSync(LEDGER, 'utf8')) as Ledger;
}

/** 解码成 RGBA 原始像素，便于逐像素检查不透明性与安全区留白。 */
async function rawRgba(file: string) {
  const { data, info } = await sharp(file)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

describe('Web App 清单（app/manifest.ts）', () => {
  const m = manifest();

  it('身份字段：名字、相对根路径的 id/start_url/scope、standalone、zh-CN', () => {
    expect(m.name).toBe('聪明山');
    expect(m.short_name).toBe('聪明山');
    // 根路径 —— 换域名时仍在当前 origin 下打开
    expect(m.id).toBe('/');
    expect(m.start_url).toBe('/');
    expect(m.scope).toBe('/');
    expect(m.display).toBe('standalone');
    expect(m.lang).toBe('zh-CN');
  });

  it('主题 / 底色是与站点一致的浅色页面底色', () => {
    expect(m.theme_color).toBe('#F8FAFC');
    expect(m.background_color).toBe('#F8FAFC');
  });

  it('图标含 192/512 普通档与 192/512 蒙版档', () => {
    const icons = m.icons ?? [];
    const any = icons.filter((i) => i.purpose === 'any').map((i) => i.sizes);
    const maskable = icons.filter((i) => i.purpose === 'maskable').map((i) => i.sizes);
    expect(any).toEqual(expect.arrayContaining(['192x192', '512x512']));
    expect(maskable).toEqual(expect.arrayContaining(['192x192', '512x512']));
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

describe('入库的 PWA 图标素材', () => {
  const ledger = readLedger();

  it('★ 出图脚本没被改过（改了就得重跑，否则站点还在用旧图）', () => {
    expect(
      sha256(GENERATOR),
      'scripts/make-pwa-icons.mjs 变了，而素材还是上一次生成的 —— 站点会继续显示旧图，' +
        '且不报任何错。跑一次 `node scripts/make-pwa-icons.mjs` 并提交。'
    ).toBe(ledger.generatorSha256);
  });

  it('★ 每张图都还是生成时的那一张（手改过 / 被替换过就红）', () => {
    expect(Object.keys(ledger.files).length, '台账里一张图都没有').toBeGreaterThan(0);
    for (const [name, hash] of Object.entries(ledger.files)) {
      const file = path.join(PWA_DIR, name);
      expect(fs.existsSync(file), `台账里有 ${name}，盘上却没有`).toBe(true);
      expect(sha256(file), `${name} 与台账对不上（被手改过？还是脚本改了没重跑？）`).toBe(hash);
    }
  });

  it('普通图标保留透明背景（就是 favicon 的等比缩放）', async () => {
    for (const name of ['icon-192.png', 'icon-512.png']) {
      const { data } = await rawRgba(path.join(PWA_DIR, name));
      let anyTransparent = false;
      for (let i = 3; i < data.length; i += 4) {
        if (data[i] < 255) {
          anyTransparent = true;
          break;
        }
      }
      expect(anyTransparent, `${name} 应当是透明背景，却整张不透明`).toBe(true);
    }
  });

  it('apple / maskable 不透明，且美术被安全区留白包住', async () => {
    // [文件, 外边留白阈值比例]：这圈带状区域内必须**全是底色**。
    // maskable 美术外接框 ≤ 56.6% → 20% 环安全；apple 是 70% → 用 10% 环。
    const cases: Array<[string, number]> = [
      ['icon-maskable-192.png', 0.2],
      ['icon-maskable-512.png', 0.2],
      ['apple-touch-icon.png', 0.1],
    ];
    for (const [name, ring] of cases) {
      const { data, width, height } = await rawRgba(path.join(PWA_DIR, name));
      const at = (x: number, y: number) => {
        const i = (y * width + x) * 4;
        return [data[i], data[i + 1], data[i + 2], data[i + 3]];
      };
      // 全图不透明
      let transparentPixels = 0;
      for (let i = 3; i < data.length; i += 4) {
        if (data[i] !== 255) transparentPixels++;
      }
      expect(transparentPixels, `${name} 必须完全不透明`).toBe(0);
      // 外圈必须是纯底色
      const marginX = Math.floor(width * ring);
      const marginY = Math.floor(height * ring);
      let unsafePixels = 0;
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const inRing = x < marginX || x >= width - marginX || y < marginY || y >= height - marginY;
          if (!inRing) continue;
          const px = at(x, y);
          if (px[0] !== BG[0] || px[1] !== BG[1] || px[2] !== BG[2] || px[3] !== 255) unsafePixels++;
        }
      }
      expect(unsafePixels, `${name} 的安全区外必须全部为底色`).toBe(0);
      // 中间确实有美术（不是一张纯底色板）：外圈以内至少有一撮非底色像素
      let artPixels = 0;
      for (let y = marginY; y < height - marginY; y++) {
        for (let x = marginX; x < width - marginX; x++) {
          const px = at(x, y);
          if (px[0] !== BG[0] || px[1] !== BG[1] || px[2] !== BG[2]) artPixels++;
        }
      }
      expect(artPixels, `${name} 中央没有美术像素 —— 是不是只铺了一层底色？`).toBeGreaterThan(
        width * height * 0.01
      );
    }
  });
});

describe('layout.tsx 的 viewport 与 Apple 元数据（源码契约）', () => {
  const src = fs.readFileSync(LAYOUT, 'utf8');

  it('导出了 viewport：device-width / initialScale 1 / viewportFit cover / 单一 themeColor', () => {
    expect(src).toMatch(/export const viewport: Viewport\s*=/);
    expect(src).toMatch(/width:\s*'device-width'/);
    expect(src).toMatch(/initialScale:\s*1/);
    expect(src).toMatch(/viewportFit:\s*'cover'/);
    expect(src).toContain("m.setAttribute('name','theme-color')");
  });

  it('没有禁用缩放（viewport 对象里不设 maximumScale / userScalable）', () => {
    // 只查 viewport 对象体，不查全文件 —— 注释里正大光明写了「不设 maximumScale /
    // userScalable」来解释这个决定，整文件扫描会被那句注释误伤。
    const block = src.match(/export const viewport: Viewport\s*=\s*\{[\s\S]*?\n\};/)?.[0] ?? '';
    expect(block, '没找到 viewport 对象字面量').not.toBe('');
    expect(block).not.toMatch(/maximumScale/);
    expect(block).not.toMatch(/userScalable/);
  });

  it('Apple 独立 App 元数据齐全（capable / title / statusBarStyle / apple 图标）', () => {
    expect(src).toMatch(/appleWebApp:\s*\{[^}]*capable:\s*true/);
    expect(src).toMatch(/appleWebApp:\s*\{[^}]*title:\s*'聪明山'/);
    expect(src).toMatch(/statusBarStyle:\s*'default'/);
    expect(src).toMatch(/apple:\s*\[\{[^}]*\/static\/img\/pwa\/apple-touch-icon\.png/);
  });

  it('首帧前把 theme-color 设成与主题一致（明暗两支都在内联脚本里）', () => {
    expect(src).toContain('meta[name="theme-color"]');
    expect(src).toContain('#F8FAFC');
    expect(src).toContain('#131517');
  });
});

describe('AddToHomeScreenGuide 的独立窗口判定', () => {
  it('iOS 的 navigator.standalone 为 true → 独立窗口', () => {
    expect(detectStandalone({ navigator: { standalone: true } })).toBe(true);
  });

  it('display-mode: standalone 命中 → 独立窗口', () => {
    expect(
      detectStandalone({ navigator: {}, matchMedia: () => ({ matches: true }) })
    ).toBe(true);
  });

  it('两者都不命中 → 不是独立窗口（照常显示引导）', () => {
    expect(
      detectStandalone({ navigator: {}, matchMedia: () => ({ matches: false }) })
    ).toBe(false);
  });

  it('判不出来（matchMedia 抛异常 / 都没有）也当作不是独立窗口', () => {
    expect(detectStandalone({})).toBe(false);
    expect(
      detectStandalone({
        navigator: {},
        matchMedia: () => {
          throw new Error('boom');
        },
      })
    ).toBe(false);
  });
});
