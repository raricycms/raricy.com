#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// copy-emoji-assets.mjs —— 把内置「黄脸表情」用到的那些 SVG 从 @twemoji/svg
// 拷到 public/static/emoji/，让浏览器从同源加载。
//
// 【拷哪些】由 src/lib/emoji-faces.json 决定（那是**我们自己的**清单：中文名 ↔ 码位，
// 入库）。包里有 3720 个 SVG，我们只用其中约 100 个，没必要整包铺出去。
//
// 【为什么不入库】与 public/static/vditor/ 、public/static/mathjax/ 同款：npm 包的
// 派生产物，package-lock.json 已经钉住版本，由 postinstall 自动重建（见 .gitignore）。
//
// 【许可 —— 这一节别跳过】
// Twemoji 的**代码是 MIT、素材（图形）是 CC BY 4.0**：
//   https://github.com/jdecked/twemoji 的 LICENSE 与 LICENSE-GRAPHICS
// ⚠️ **但 @twemoji/svg 包里那份 license 文件只写了打包者自己的 MIT**
//    （Copyright (c) 2023 Samuel Kopp），**根本没带素材的 CC BY 4.0**。
//    那是打包失误，署名义务不会因此消失。所以本脚本**不照拷**包里那份，而是自己写
//    一份正确的 LICENSE.txt 放进目标目录（见 writeLicense）。
// CC BY 4.0 只需署名、**无传染性**，站点无需因此改许可。
//
// 【SVG 这件事要说清楚】本站对 SVG 一贯警惕：instance/stickers/ 那条字节路由把
// image/svg+xml 排除在白名单外，注释写着「同源存储型 XSS 的唯一闸门」。**那条闸门
// 没有被削弱**，因为它防的是另一回事：
//   · 那边是**运行时目录**，站长随手往里拷文件，没有任何上游校验 → 必须按字节拦；
//   · 这边是**构建期产物**，来源是锁了版本的 npm 包，且下面 scanSvg 还会逐文件扫一遍
//     （有脚本 / 事件属性 / 外链就构建失败）。
// 另外这里只以 `<img src>` 引用，SVG 不进净化后的 HTML 标记 —— 与「把 svg 内联进
// 页面」完全不是一回事。
//
// 【注意】`npm ci --ignore-scripts`、或只从缓存拷 node_modules 的构建会跳过
// postinstall —— 那种环境要手工跑一次 `npm run prepare:emoji`。少了素材，正文里那些
// `[@黄脸/…]` 会**降级回字面量**（不是裂图），评论区与讨论区照常能用。
//
// 用法：npm run prepare:emoji  /  npm run emoji:check
// ─────────────────────────────────────────────────────────────────────────────

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST = path.join(ROOT, 'src', 'lib', 'emoji-faces.json');
const SRC = path.join(ROOT, 'node_modules', '@twemoji', 'svg');
const DEST = path.join(ROOT, 'public', 'static', 'emoji');

// ─── 1. 清单 ────────────────────────────────────────────────────────────────

if (!fs.existsSync(MANIFEST)) {
  console.error(`[copy-emoji-assets] 清单不存在：${MANIFEST}`);
  process.exit(1);
}
const faces = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
if (!Array.isArray(faces) || faces.length === 0) {
  // 哨兵：清单空了就直接失败。静默拷出一个空目录会让面板显示一栏空白，
  // 而那看起来像样式问题，没人会想到是构建脚本。
  console.error('[copy-emoji-assets] emoji-faces.json 为空或不是数组 —— 拒绝继续。');
  process.exit(1);
}

// ─── 2. 安全扫描 ────────────────────────────────────────────────────────────
//
// 上游哪天塞了脚本进来，要**在构建期当场炸**，而不是静默上线。这些模式在正常的
// Twemoji 素材里一个都不会命中（它们只有 path/circle/ellipse/g + fill/d）。
const DANGEROUS = [
  [/<script/i, '<script>'],
  [/<foreignObject/i, '<foreignObject>'],
  [/<!ENTITY|<!DOCTYPE/i, '<!ENTITY / <!DOCTYPE>'],
  [/\son[a-z]+\s*=/i, '事件属性（onXXX=）'],
  [/javascript:/i, 'javascript:'],
  // 外链一律拒；`href="#id"` 这种文档内引用放行（Twemoji 目前一个 href 都没有）
  [/href\s*=\s*["'](?!#)/i, '外部 href'],
];

function scanSvg(file, text) {
  for (const [re, label] of DANGEROUS) {
    if (re.test(text)) return label;
  }
  return null;
}

/** 没有 xmlns 的 SVG 用 <img> 引用时**根本不渲染**（不是裂图，是空白）。 */
function checkSvgShape(text) {
  if (!text.startsWith('<svg')) return '开头不是 <svg';
  if (!text.includes('xmlns=')) return '缺 xmlns';
  if (!text.includes('viewBox=')) return '缺 viewBox';
  return null;
}

// ─── 3. 许可证（自己写，不照拷包里那份 MIT）─────────────────────────────────

const LICENSE = `Twemoji 图形素材 —— CC BY 4.0
================================================================

本目录下的 .svg 文件是 Twemoji 项目的图形素材，**原样使用、未作修改**
（仅按站点需要挑选了其中一部分）。

  项目    https://github.com/jdecked/twemoji
  许可    Creative Commons Attribution 4.0 International (CC BY 4.0)
          https://creativecommons.org/licenses/by/4.0/
  版权    Copyright 2014-2021 Twitter, Inc. 及 Twemoji 贡献者
          Copyright 2022-present Jason Sofonia & Justine De Caires

素材经由 npm 包 @twemoji/svg@15.0.0 分发。

⚠️ 该 npm 包内自带的 license 文件只声明了打包者自己的 MIT
   （Copyright (c) 2023 Samuel Kopp），**并未包含上述 CC BY 4.0 说明**。
   那份文件不能作为本目录素材的授权依据，本文件才是。

站点侧的署名落在源码注释里：src/lib/emoji-faces.ts 与 scripts/copy-emoji-assets.mjs
（Twemoji 官方明示接受这种形式）。
`;

function writeLicense() {
  fs.writeFileSync(path.join(DEST, 'LICENSE.txt'), LICENSE, 'utf8');
}

// ─── 4. 拷贝 ────────────────────────────────────────────────────────────────

if (!fs.existsSync(SRC)) {
  console.error(`[copy-emoji-assets] 源目录不存在：${SRC}`);
  console.error('[copy-emoji-assets] 请先 npm install @twemoji/svg。');
  process.exit(1);
}

// 清单里的文件必须一个不缺。这条顺带把「码位写错」当场抓出来 ——
// 否则那个表情会在面板里显示成一张空白格，且**不报任何错**。
const missing = faces.filter((f) => !fs.existsSync(path.join(SRC, f.file)));
if (missing.length > 0) {
  console.error(`[copy-emoji-assets] 清单里有 ${missing.length} 项在包里找不到：`);
  for (const m of missing) console.error(`  ✗ ${m.name} → ${m.file}`);
  console.error('[copy-emoji-assets] 码位可能写错了，或 @twemoji/svg 的目录结构变了。');
  process.exit(1);
}

fs.mkdirSync(DEST, { recursive: true });
// 先清空再拷：改清单时表情会增减，残留旧文件会让人以为改动没生效。
// 另外 LICENSE.txt 也一并删掉，由下面重写（免得留下上一次的内容）。
for (const f of fs.readdirSync(DEST)) fs.rmSync(path.join(DEST, f), { force: true });

let bytes = 0;
const problems = [];
for (const f of faces) {
  const from = path.join(SRC, f.file);
  const text = fs.readFileSync(from, 'utf8');

  const danger = scanSvg(f.file, text);
  if (danger) {
    problems.push(`${f.file}：含有 ${danger}`);
    continue;
  }
  const shape = checkSvgShape(text);
  if (shape) {
    problems.push(`${f.file}：${shape}`);
    continue;
  }

  fs.copyFileSync(from, path.join(DEST, f.file));
  bytes += Buffer.byteLength(text);
}

if (problems.length > 0) {
  console.error(`[copy-emoji-assets] ${problems.length} 个文件没通过检查：`);
  for (const p of problems) console.error('  ✗', p);
  console.error('[copy-emoji-assets] 上游包可能被换过内容 —— 不要就这么上线。');
  process.exit(1);
}

writeLicense();
console.log(
  `[copy-emoji-assets] 完成。${faces.length} 个 SVG，约 ${(bytes / 1024).toFixed(0)}KB → public/static/emoji/`
);

// ─── 5. 自检模式：CI / 升级 @twemoji/svg 后验证素材齐全 ──────────────────────

if (process.argv.includes('--check')) {
  const absent = faces.filter((f) => !fs.existsSync(path.join(DEST, f.file)));
  if (absent.length > 0) {
    console.error(`[check] 缺 ${absent.length} 个素材：`);
    for (const a of absent) console.error('  ✗', a.file);
    console.error('[check] 请先 npm run prepare:emoji');
    process.exit(1);
  }
  if (!fs.existsSync(path.join(DEST, 'LICENSE.txt'))) {
    // 署名文件缺失是**许可问题**，不是美观问题，单独报一条
    console.error('[check] 缺 LICENSE.txt（CC BY 4.0 要求署名，这个文件不能少）');
    process.exit(1);
  }
  console.log(`[check] OK，${faces.length} 个素材与 LICENSE.txt 齐全。`);
}
