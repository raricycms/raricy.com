#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// copy-mathjax-fonts.mjs —— 把 MathJax CHTML 的 woff 字体从 mathjax-full 拷到
// public/static/mathjax/，让浏览器从同源加载。
//
// 【为什么需要】MarkdownRenderer 用 mathjax-full 的 CHTML 输出排版公式，它注入
// 的样式表里带 @font-face，而 fontURL 默认是相对路径
// `js/output/chtml/fonts/tex-woff-v2` —— 按**当前页面**解析，在 /clipboard/xxx
// 下就变成 /clipboard/js/…，一律 404，公式只能用回退字体渲染（字形与间距都不对）。
// 组件里已把 fontURL 显式指到 /static/mathjax/woff-v2，这个脚本负责把文件放过去。
//
// 【为什么不入库】与 public/static/vditor/ 同款：npm 包的派生产物，
// package-lock.json 已经钉住版本，由 postinstall 自动重建（见 .gitignore）。
//
// 【注意】`npm ci --ignore-scripts`、或只从缓存拷 node_modules 的构建会跳过
// postinstall —— 那种环境要手工跑一次 `npm run prepare:mathjax`。少了字体公式
// 仍会显示，但用的是回退字体。
//
// 用法：npm run prepare:mathjax  /  npm run mathjax:check
// ─────────────────────────────────────────────────────────────────────────────

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// ts/ 与 es5/ 下各有一份相同的 woff。取 ts/（源码目录）：es5/ 是打包产物，
// 未来版本调整打包方式时可能被裁掉。
const SRC = path.join(ROOT, 'node_modules', 'mathjax-full', 'ts', 'output', 'chtml', 'fonts', 'tex-woff-v2');
const DEST = path.join(ROOT, 'public', 'static', 'mathjax', 'woff-v2');

if (!fs.existsSync(SRC)) {
  console.error(`[copy-mathjax-fonts] 源目录不存在：${SRC}`);
  console.error('[copy-mathjax-fonts] 请先 npm install mathjax-full。');
  process.exit(1);
}

// 哨兵：mathjax-full 换了目录结构 / 不再带 woff 时立刻失败，不要静默建一个空目录
const fonts = fs.readdirSync(SRC).filter((f) => f.endsWith('.woff'));
if (fonts.length === 0) {
  console.error(`[copy-mathjax-fonts] ${SRC} 里没有 .woff 文件 —— mathjax-full 的目录结构可能变了。`);
  process.exit(1);
}

fs.mkdirSync(DEST, { recursive: true });
// 先清空再拷：升级 mathjax-full 时字体名可能增减，残留旧文件会让人误以为已更新
for (const f of fs.readdirSync(DEST)) fs.rmSync(path.join(DEST, f), { force: true });

let bytes = 0;
for (const f of fonts) {
  fs.copyFileSync(path.join(SRC, f), path.join(DEST, f));
  bytes += fs.statSync(path.join(DEST, f)).size;
}
console.log(
  `[copy-mathjax-fonts] 完成。${fonts.length} 个 woff，约 ${(bytes / 1024).toFixed(0)}KB → public/static/mathjax/woff-v2/`
);

// ─── 自检模式：CI / 升级 mathjax-full 后验证字体齐全 ──────────────────────
if (process.argv.includes('--check')) {
  const missing = fonts.filter((f) => !fs.existsSync(path.join(DEST, f)));
  if (missing.length > 0) {
    console.error(`[check] 缺 ${missing.length} 个字体：`);
    for (const m of missing) console.error('  ✗', m);
    console.error('[check] 请先 npm run prepare:mathjax');
    process.exit(1);
  }
  console.log(`[check] OK，${fonts.length} 个字体齐全。`);
}
