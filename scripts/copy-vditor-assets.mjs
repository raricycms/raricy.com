#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// copy-vditor-assets.mjs —— 把 vditor 运行时需要的 icon sprite / KaTeX 从
// node_modules 拷贝到 public/static/vditor/，让浏览器从同源加载。
//
// 【为什么】vditor 默认 cdn: 'https://unpkg.com/vditor@3.10.7'，编辑器初始化时
// 会动态拉 ${cdn}/dist/js/icons/ant.js 和（用户输入数学公式时）${cdn}/dist/js/katex/*。
// 我们把项目从 CDN 改 npm 后，必须把这两个静态资源搬到 /public 下，并通过
// 把 vditor 配置的 cdn 指向 '/static/vditor' 来让编辑器从同源取。
//
// 【为什么不在仓库里提交 public/static/vditor/】这些 684KB 的资源是 npm 包的
// 派生产物，跟 package-lock.json 重复了；/public/static/vditor/ 已经被 .gitignore
// 排除，install 时由 npm run postinstall 自动重建。
//
// 用法：npm run prepare:vditor  （手动重跑；正常 install 流程会自动调用）
// ─────────────────────────────────────────────────────────────────────────────

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'node_modules', 'vditor', 'dist');
const DEST = path.join(ROOT, 'public', 'static', 'vditor', 'dist');

if (!fs.existsSync(path.join(SRC, 'js', 'icons', 'ant.js'))) {
  console.error('[copy-vditor-assets] node_modules/vditor/dist 缺失。请先 npm install vditor。');
  process.exit(1);
}

const targets = [
  { rel: 'js/icons/ant.js', label: 'icon sprite (43KB)' },
  { rel: 'js/katex/katex.min.css', label: 'KaTeX CSS (23KB)' },
  { rel: 'js/katex/katex.min.js', label: 'KaTeX JS (277KB)' },
  { rel: 'js/katex/mhchem.min.js', label: 'KaTeX mhchem (34KB)' },
  { rel: 'js/katex/fonts', label: 'KaTeX woff2 fonts (1.2MB → 仅 woff2)', filter: /\.woff2$/ },
];

function rimraf(p) {
  if (!fs.existsSync(p)) return;
  for (const f of fs.readdirSync(p)) {
    const full = path.join(p, f);
    const s = fs.statSync(full);
    if (s.isDirectory()) rimraf(full);
    else fs.unlinkSync(full);
  }
  fs.rmdirSync(p);
}

function copyFile(srcFile, destFile) {
  fs.mkdirSync(path.dirname(destFile), { recursive: true });
  fs.copyFileSync(srcFile, destFile);
}

function copyDir(srcDir, destDir, filter) {
  fs.mkdirSync(destDir, { recursive: true });
  for (const f of fs.readdirSync(srcDir)) {
    const full = path.join(srcDir, f);
    const s = fs.statSync(full);
    if (s.isDirectory()) copyDir(full, path.join(destDir, f), filter);
    else if (!filter || filter.test(f)) {
      fs.mkdirSync(destDir, { recursive: true });
      fs.copyFileSync(full, path.join(destDir, f));
    }
  }
}

// 清理旧产物再重建 —— 防止旧版本残留导致 stale 资源
rimraf(DEST);

let totalBytes = 0;
for (const t of targets) {
  const src = path.join(SRC, t.rel);
  const dest = path.join(DEST, t.rel);
  if (!fs.existsSync(src)) {
    console.warn(`[copy-vditor-assets] 跳过缺失：${t.rel}`);
    continue;
  }
  if (t.filter) {
    copyDir(src, dest, t.filter);
  } else {
    copyFile(src, dest);
  }
  const size = fs.statSync(dest).size;
  totalBytes += size;
  console.log(`  ✓ ${t.label}`);
}

console.log(`[copy-vditor-assets] 完成。目标：public/static/vditor/dist/`);
console.log(`[copy-vditor-assets] 顶层文件总 ${(totalBytes / 1024).toFixed(1)}KB；fonts 目录另计 ~600KB woff2。`);
