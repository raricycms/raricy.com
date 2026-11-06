// ─────────────────────────────────────────────────────────────────────────────
// pwa-assets.test.ts —— 静态检查：入库的 PWA 图标必须**就是出图脚本的产物**
//
// 【绊的是什么】public/static/img/pwa/ 的 PNG 随代码入库，是出图脚本那一时刻的
// **独立副本**。改了 scripts/make-pwa-icons.mjs（比例 / 源图 / 尺寸）却忘了重跑，
// 站点会继续显示旧图 —— 不 500、不报错、日志里什么都没有，只有人眼看标签页或
// 「添加到主屏幕」时才可能发现。
//
// 与 frame-assets.test.ts 同属一类（tsc 管不着、构建不报、只有静态检查能钉住），
// 判据也相同：核对「生成这一刻」的台账 public/static/img/pwa/manifest.json ——
//   · `generatorSha256` —— 脚本自身的哈希（LF 归一化后再取）；
//   · `files[name]`     —— 每张产物的哈希。
// 只做两件事：脚本没变过、每张图还是当初生成的那张。**刻意不重新光栅化**：
// SVG/PNG 过 sharp 的预编译二进制不保证逐字节一致，重新生成的守卫会在别人的机器上
// 假红（理由详见 frame-assets.test.ts 头部）。
//
// 第二道是脚本自己的 `node scripts/make-pwa-icons.mjs --check`（只读、不写文件）。
// ─────────────────────────────────────────────────────────────────────────────

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(import.meta.dirname, '../..');
const PWA_DIR = path.join(ROOT, 'public', 'static', 'img', 'pwa');
const MANIFEST = path.join(PWA_DIR, 'manifest.json');
const GENERATOR = path.join(ROOT, 'scripts', 'make-pwa-icons.mjs');
const SOURCE = path.join(ROOT, 'public', 'static', 'img', 'favicon.png');

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** 台账里必须出现、且只能出现这些产物（与 make-pwa-icons.mjs 的 ICONS 同步）。 */
const EXPECTED_FILES = [
  'apple-touch-icon.png',
  'icon-192.png',
  'icon-512.png',
  'icon-maskable-192.png',
  'icon-maskable-512.png',
];

const REMEDY = '跑一次 `node scripts/make-pwa-icons.mjs`，把 public/static/img/pwa/ 的改动一起提交。';

function sha256File(file: string): string {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** 脚本自身的 sha256 —— 先按 LF 归一化，避免 CRLF 检出造成跨平台假红。 */
function generatorSha256(file: string): string {
  return createHash('sha256')
    .update(fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n'))
    .digest('hex');
}

interface Manifest {
  generator: string;
  generatorSha256: string;
  source: string;
  files: Record<string, string>;
}

function readManifest(): Manifest {
  expect(
    fs.existsSync(MANIFEST),
    `缺少 ${path.relative(ROOT, MANIFEST)} —— 它由出图脚本写、随素材入库，` +
      `缺了说明素材不是脚本生成的。${REMEDY}`
  ).toBe(true);
  return JSON.parse(fs.readFileSync(MANIFEST, 'utf8')) as Manifest;
}

describe('入库的 PWA 图标', () => {
  const manifest = readManifest();

  it('★ 出图脚本没被改过（改了就得重跑，否则站点还在用旧图）', () => {
    expect(
      generatorSha256(GENERATOR),
      `scripts/make-pwa-icons.mjs 变了，而素材还是上一次生成的 —— 站点会继续显示旧图，` +
        `且不报任何错。${REMEDY}`
    ).toBe(manifest.generatorSha256);
  });

  it('台账的 generator / source 指向真实路径，源图 favicon.png 仍在', () => {
    expect(manifest.generator).toBe('scripts/make-pwa-icons.mjs');
    expect(manifest.source).toBe('public/static/img/favicon.png');
    expect(fs.existsSync(SOURCE), `源图 ${path.relative(ROOT, SOURCE)} 不存在 —— PWA 图标失去来源`).toBe(
      true
    );
    expect(fs.readFileSync(SOURCE).subarray(0, PNG_SIG.length).equals(PNG_SIG)).toBe(true);
  });

  it('★ 每张图都在，且还是生成时的那一张（手改过 / 被替换过就红）', () => {
    for (const name of EXPECTED_FILES) {
      const file = path.join(PWA_DIR, name);
      expect(fs.existsSync(file), `缺少 ${name} —— ${REMEDY}`).toBe(true);
      // 扩展名只是声明 —— 内容必须是真 PNG（与 frame-assets 同一判据）。
      expect(fs.readFileSync(file).subarray(0, PNG_SIG.length).equals(PNG_SIG), `${name} 的内容不是 PNG`).toBe(
        true
      );
      expect(sha256File(file), `${name} 与台账对不上（被手改过？还是脚本改了没重跑？）`).toBe(
        manifest.files[name]
      );
    }
  });

  it('★ 台账不是空的、没有多余条目，且脚本里确实定义了每一张', () => {
    const names = Object.keys(manifest.files).sort();
    expect(names, '台账里的产物清单与脚本的 ICONS 不一致').toEqual([...EXPECTED_FILES].sort());

    // 反向自检：哈希两条只证明「文件没变」，证明不了「脚本还会生成它们」。
    const src = fs.readFileSync(GENERATOR, 'utf8');
    for (const name of EXPECTED_FILES) {
      expect(src, `出图脚本里找不到 ${name} 的定义`).toMatch(new RegExp(`\\['${name}',\\s*\\d+,\\s*'(?:any|apple|maskable)'\\]`));
    }
  });

  it('--check 模式只读校验同一套判据（脚本自身入口，不依赖本文件）', () => {
    // 不在这里 spawn 子进程（选择与 frame-assets 一致：只读台账 + 脚本字面量）；
    // 命令入口的可用性由 `node scripts/make-pwa-icons.mjs --check` 人工/CI 跑。
    expect(fs.existsSync(GENERATOR)).toBe(true);
    expect(fs.readFileSync(GENERATOR, 'utf8')).toContain("process.argv.includes('--check')");
  });
});
