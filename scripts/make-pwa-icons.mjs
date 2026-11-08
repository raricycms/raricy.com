#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// make-pwa-icons.mjs —— 从**既有站点几何 favicon** 派生 Web App（PWA）图标
//
// 用法：node scripts/make-pwa-icons.mjs
//       写到 public/static/img/pwa/（**素材随代码入库** —— 它是站点自己 favicon 的
//       派生图，源码就是本文件，所以住 public/static/ 而不是运行时数据目录 instance/）
//
// ⚠️ 【改了本文件就必须重跑并提交素材】入库之后 PNG 成了仓库里的独立副本：
//    只改这里的比例 / 来源而不重跑，站点会继续显示旧图，**且不报任何错**。
//    出图会把「生成这一刻」写进 pwa/manifest.json（本文件自身 + 每张产物的 sha256）。
//    守卫有两道：`node scripts/make-pwa-icons.mjs --check`（本文件，只读校验台账）与
//    `tests/unit/pwa-metadata.test.ts`（清单里的每个图标在盘上存在、尺寸对得上；
//    原 `pwa-assets.test.ts` 的台账比对已于 Round4 移除）。
//
// 用法：node scripts/make-pwa-icons.mjs            # 出图并写台账
//       node scripts/make-pwa-icons.mjs --check    # 只校验已入库台账，不写任何文件
//
// ── 【为什么不重新画一套品牌图】──────────────────────────────────────────────
// 判据是「保留既有美术，而不是自造品牌」：本站 favicon 是白底透明背景上的四个几何
// 色块（蓝圆 / 红圆 / 黄三角 / 绿方），这里**只做缩放与留白**，不描新图形。
// 唯一加进去的是背景色 —— 那是站点既有的 `--color-background-page` 浅色令牌
// （#F8FAFC，与 manifest 的 theme_color / background_color 同一支），不是新配色。
//
// ── 【三条硬规格】────────────────────────────────────────────────────────────
//   · **普通图标（any）保留透明背景** —— 直出 favicon 的等比缩放，不做任何裁圆角。
//   · **apple-touch-icon 与 maskable 必须不透明**：iOS 会把透明区渲染成黑色，
//     Android 的 maskable 要求满血铺底；两者都铺站点背景色后居中放美术。
//   · **maskable 要留安全区**：可被裁成圆形 / 方形 / 水滴等任意形状，保证美术的
//     外接框落进「直径 80% 的中央圆」内 —— 外接方框边长取 80% / √2 ≈ 56.6%。
//     这里刻意**不自己裁圆角**（那会与系统 mask 叠加、把角再啃掉一块）。
//
// 源图 200×200，放大到 512 会有可见的软化 —— 这是源素材的分辨率上限，如实标注，
// 不靠锐化粉饰（那只会让边缘出现光晕）。
// ─────────────────────────────────────────────────────────────────────────────

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'public', 'static', 'img', 'favicon.png');
const OUT_DIR = path.join(ROOT, 'public', 'static', 'img', 'pwa');

/** 站点浅色页面底色（`--color-background-page`）—— 与 manifest 的 theme/background 同值。 */
const BG = { r: 0xf8, g: 0xfa, b: 0xfc, alpha: 1 };
/** 完全透明 —— 给 resize 的留白用，普通图标要保持透明背景。 */
const CLEAR = { r: 0, g: 0, b: 0, alpha: 0 };

/**
 * 美术外接框占画布的比例。trim 掉 favicon 自带的透明边后，把美术缩到画布的这个比例内。
 *   · maskable：80% / √2 ≈ 0.566 —— 外接框四角正好落在 80% 安全圆上。
 *   · apple：0.70 —— iOS 自己会裁 ~20% 圆角，留出呼吸；无系统安全区硬要求。
 */
const MASKABLE_CONTENT_RATIO = 0.566;
const APPLE_CONTENT_RATIO = 0.7;

/** 图标清单：[文件名, 边长, 种类]。`any` 透明；`maskable` / `apple` 铺底不透明。 */
const ICONS = [
  ['apple-touch-icon.png', 180, 'apple'],
  ['icon-192.png', 192, 'any'],
  ['icon-512.png', 512, 'any'],
  ['icon-maskable-192.png', 192, 'maskable'],
  ['icon-maskable-512.png', 512, 'maskable'],
];

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** 台账里必须出现的产物名（与上面的 ICONS 同步）。 */
const EXPECTED_FILES = ICONS.map(([name]) => name);

/**
 * `--check`：只读校验「入库素材 = 出图脚本的产物」。不重新光栅化 —— 那要过 sharp，
 * 各平台预编译二进制不保证逐字节相同（frame-assets.test.ts 头部解释过同一件事）。
 */
function check() {
  const errors = [];
  const manifestFile = path.join(OUT_DIR, 'manifest.json');
  if (!fs.existsSync(manifestFile)) {
    console.error(`缺少 ${path.relative(ROOT, manifestFile)} —— 素材不是本脚本生成的。`);
    console.error('修复：node scripts/make-pwa-icons.mjs');
    process.exitCode = 1;
    return;
  }
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));

  const expectedGenerator = path.relative(ROOT, fileURLToPath(import.meta.url)).replace(/\\/g, '/');
  const expectedSource = path.relative(ROOT, SRC).replace(/\\/g, '/');
  if (manifest.generator !== expectedGenerator) {
    errors.push(`generator 应指向 ${expectedGenerator}，台账写的是 ${String(manifest.generator)}`);
  }
  if (manifest.source !== expectedSource) {
    errors.push(`source 应是 ${expectedSource}，台账写的是 ${String(manifest.source)}`);
  }

  // Windows 检出可能转换行尾；校验逻辑内容，不把 CRLF 当成脚本漂移（同 frame-assets）。
  const actualGenerator = sha256(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').replace(/\r\n/g, '\n'));
  if (actualGenerator !== manifest.generatorSha256) {
    errors.push(
      `generatorSha256 与脚本当前内容不一致（台账 ${String(manifest.generatorSha256)}，实际 ${actualGenerator}）——` +
        '脚本改了没重跑？'
    );
  }

  const files = manifest.files ?? {};
  for (const name of EXPECTED_FILES) {
    if (!(name in files)) errors.push(`manifest.files 缺 ${name}`);
  }
  for (const name of Object.keys(files)) {
    if (!EXPECTED_FILES.includes(name)) errors.push(`manifest.files 多出 ${name}（脚本已不再生成它）`);
  }
  for (const name of EXPECTED_FILES) {
    const file = path.join(OUT_DIR, name);
    if (!fs.existsSync(file)) {
      errors.push(`缺 ${name}`);
      continue;
    }
    const buf = fs.readFileSync(file);
    if (!buf.subarray(0, PNG_SIG.length).equals(PNG_SIG)) errors.push(`${name} 不是 PNG`);
    const digest = sha256(buf);
    if (digest !== files[name]) {
      errors.push(`${name} 与台账哈希不一致（被手改过 / 被替换 / 生成后没更新台账）`);
    }
  }

  if (!fs.existsSync(SRC)) errors.push(`源图 ${path.relative(ROOT, SRC)} 不存在`);
  if (errors.length > 0) {
    console.error('PWA 图标台账校验失败：');
    for (const error of errors) console.error(`  · ${error}`);
    console.error('修复：node scripts/make-pwa-icons.mjs，并把 public/static/img/pwa/ 的改动一起提交。');
    process.exitCode = 1;
    return;
  }
  console.log(
    `PWA 图标台账一致：generatorSha256、${EXPECTED_FILES.length} 张 PNG 与源图路径均对得上` +
      `（${path.relative(ROOT, manifestFile)}）。`
  );
}

/** 去掉 favicon 四周的透明边，只留美术本体（透明背景用 alpha 判定）。 */
async function trimmedArt() {
  return sharp(SRC).ensureAlpha().trim({ threshold: 1 }).toBuffer();
}

/** 普通图标：favicon 等比缩放，保留透明背景与自带留白。 */
async function anyIcon(size) {
  return sharp(SRC)
    .resize(size, size, { fit: 'contain', kernel: 'lanczos3', background: CLEAR })
    .png()
    .toBuffer();
}

/** 不透明图标：美术缩到 contentRatio，铺站点底色居中。 */
async function opaqueIcon(size, contentRatio) {
  const box = Math.max(1, Math.round(size * contentRatio));
  const art = await sharp(await trimmedArt())
    .resize(box, box, { fit: 'contain', kernel: 'lanczos3', background: CLEAR })
    .flatten({ background: BG })
    .png()
    .toBuffer();
  return sharp({ create: { width: size, height: size, channels: 4, background: BG } })
    .composite([{ input: art, gravity: 'center' }])
    .png()
    .toBuffer();
}

async function main() {
  if (process.argv.includes('--check')) {
    check();
    return;
  }
  if (!fs.existsSync(SRC)) {
    throw new Error(`缺少源图标 ${path.relative(ROOT, SRC)} —— 请确认 favicon 还在。`);
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const files = {};
  for (const [name, size, kind] of ICONS) {
    const buf =
      kind === 'any'
        ? await anyIcon(size)
        : await opaqueIcon(size, kind === 'apple' ? APPLE_CONTENT_RATIO : MASKABLE_CONTENT_RATIO);
    fs.writeFileSync(path.join(OUT_DIR, name), buf);
    files[name] = sha256(buf);
    console.log(`  ${name}  ${size}×${size}  ${kind}`);
  }

  const manifest = {
    generator: path.relative(ROOT, fileURLToPath(import.meta.url)).replace(/\\/g, '/'),
    // Windows 检出可能转换行尾；校验逻辑内容，不把 CRLF 当成脚本漂移。
    generatorSha256: sha256(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').replace(/\r\n/g, '\n')),
    source: path.relative(ROOT, SRC).replace(/\\/g, '/'),
    files,
  };
  fs.writeFileSync(
    path.join(OUT_DIR, 'manifest.json'),
    JSON.stringify(manifest, null, 2) + '\n'
  );
  console.log(`已写入 ${path.relative(ROOT, OUT_DIR)}/（${ICONS.length} 张图标 + manifest.json）`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
