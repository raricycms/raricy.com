#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// copy-vditor-assets.mjs —— 把 vditor 运行时需要的资源从 node_modules 拷到
// public/static/vditor/，让浏览器从同源加载。
//
// 【为什么】vditor 初始化 / 用户输入公式 / 代码块 / 点 export 时，会按
// `${cdn}/dist/...` 路径动态加载 icons、language、katex、mermaid、lute，
// 或在导出 HTML 里内嵌图片。改 cdn 为本地 '/static/vditor' 后，必须把这些
// 资源落到 public/ 下，否则一访问就 404。
//
// 【targets 怎么来】脚本第一阶段扫 node_modules/vditor/dist/index.js 里所有
// 以 "/dist/" 开头的字符串字面量（vditor 编译器把所有运行时拼路径都留字面量），
// 自动转成拷贝目标。第二阶段附加 EXTRAS，比如 katex/fonts 是浏览器解析
// katex.min.css 的 @font-face 时拉的，不会出现在 index.js 字面量里。
//
// 【为什么不在仓库里提交 public/static/vditor/】这些是 npm 包的派生产物，
// 跟 package-lock.json 重复了；已经 .gitignore 排除，由 npm run postinstall
// 自动重建。
//
// 用法：npm run prepare:vditor  （手动重跑；正常 install 流程会自动调用）
// ─────────────────────────────────────────────────────────────────────────────

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'node_modules', 'vditor', 'dist');
const DEST = path.join(ROOT, 'public', 'static', 'vditor', 'dist');

// 哨兵检查：vditor 没装好就直接 fail，不要静默建一个空目录
if (!fs.existsSync(path.join(SRC, 'js', 'icons', 'ant.js'))) {
  console.error('[copy-vditor-assets] node_modules/vditor/dist 缺失。请先 npm install vditor。');
  process.exit(1);
}

// ─── 自动 audit：扫 vditor dist 里 addScript / 内嵌引用涉及的字符串 ───────
function auditVditorPaths() {
  const indexJs = path.join(SRC, 'index.js');
  const text = fs.readFileSync(indexJs, 'utf8');
  // 匹配 '/dist/...' 字符串字面量；vditor 编译器把所有运行时拼路径都留字面量
  const re = /"\/dist\/[^"\\]+"/g;
  const seen = new Set();
  let m;
  while ((m = re.exec(text)) !== null) {
    const p = m[0].slice(1, -1); // 去首尾引号
    // 主 css 已经走 'import vditor/dist/index.css' 进 bundle，不重复拷
    if (p === '/dist/index.css') continue;
    // method bundle 由 'import "vditor/method"' 单独取，不通过 cdn 拉
    if (p === '/dist/method.min.js') continue;
    seen.add(p);
  }
  return [...seen].sort();
}

// 把 audit 路径转成拷贝目标；用磁盘 stat 决定是文件还是目录（裸路径
// 如 css/content-theme 在 src 是目录，但 audit 字符串不带尾斜杠）
function buildTargetsFromAudit(audited) {
  const targets = [];
  for (const p of audited) {
    const rel = p.replace(/^\/dist\//, '').replace(/\?.*$/, '');
    const absSrc = path.join(SRC, rel);
    if (fs.existsSync(absSrc) && fs.statSync(absSrc).isDirectory()) {
      targets.push({ rel, kind: 'dir' });
    } else {
      targets.push({ rel, kind: 'file' });
    }
  }
  return targets;
}

// ─── 附加条目：CSS @font-face 引用的资源不出现在 JS 字面量里 ────────────
const EXTRAS = [
  // katex.min.css 里的 @font-face 引到 js/katex/fonts/*.woff2
  { rel: 'js/katex/fonts', kind: 'dir', filter: /\.woff2$/, label: 'KaTeX woff2 fonts' },
];

// ─── 文件系统工具 ──────────────────────────────────────────────────────────
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
  if (!fs.existsSync(srcDir)) return 0;
  fs.mkdirSync(destDir, { recursive: true });
  let count = 0;
  for (const f of fs.readdirSync(srcDir)) {
    const full = path.join(srcDir, f);
    const s = fs.statSync(full);
    if (s.isDirectory()) {
      count += copyDir(full, path.join(destDir, f), filter);
    } else if (!filter || filter.test(f)) {
      fs.mkdirSync(destDir, { recursive: true });
      fs.copyFileSync(full, path.join(destDir, f));
      count += 1;
    }
  }
  return count;
}

function sizeOf(p) {
  if (!fs.existsSync(p)) return 0;
  const s = fs.statSync(p);
  if (!s.isDirectory()) return s.size;
  let total = 0;
  for (const f of fs.readdirSync(p)) {
    total += sizeOf(path.join(p, f));
  }
  return total;
}

// ─── 主流程 ────────────────────────────────────────────────────────────────
const audited = auditVditorPaths();
console.log(`[copy-vditor-assets] audit: 扫到 ${audited.length} 条 vditor 运行时资源路径`);

const allTargets = [
  ...buildTargetsFromAudit(audited),
  ...EXTRAS,
];

// 清理旧产物再重建 —— 防止旧版本残留导致 stale 资源
rimraf(DEST);

let totalBytes = 0;
let totalFiles = 0;
for (const t of allTargets) {
  const src = path.join(SRC, t.rel);
  const dest = path.join(DEST, t.rel);
  if (!fs.existsSync(src)) {
    console.warn(`  · 跳过缺失源：${t.rel}`);
    continue;
  }
  let count = 0;
  if (t.kind === 'dir') {
    count = copyDir(src, dest, t.filter || null);
  } else {
    copyFile(src, dest);
    count = 1;
  }
  const size = sizeOf(dest);
  totalBytes += size;
  totalFiles += count;
  const label = t.label ? ` (${t.label})` : '';
  console.log(`  ✓ ${t.rel.padEnd(40)} ${count} files${label}`);
}

console.log(`[copy-vditor-assets] 完成。共 ${totalFiles} 文件，约 ${(totalBytes / 1024 / 1024).toFixed(2)}MB。`);
console.log(`[copy-vditor-assets] 目标：public/static/vditor/dist/`);

// ─── 自检模式：vditor 升级后用 --check 验证 dest 是否覆盖所有 audit 路径 ──
// 不写盘，只 read 一次 dest，对比 audit 期望路径。配合 CI / 升级流程跑。
if (process.argv.includes('--check')) {
  console.log('\n[check] 验证 dest 与 audit 一致...');
  const expected = new Set(audited.map((p) => p.replace(/^\/dist\//, '').replace(/\?.*$/, '')));
  // 加上 EXTRAS（katex/fonts）
  for (const e of EXTRAS) expected.add(e.rel);
  const missing = [];
  for (const rel of expected) {
    const p = path.join(DEST, rel);
    // 文件或目录任一存在即可
    const exists = fs.existsSync(p);
    if (!exists) {
      missing.push(rel);
      continue;
    }
    // 目录里要有至少一个文件
    if (fs.statSync(p).isDirectory() && fs.readdirSync(p).length === 0) {
      missing.push(rel + ' (empty dir)');
    }
  }
  if (missing.length > 0) {
    console.error(`[check] 缺 ${missing.length} 项：`);
    for (const m of missing) console.error('  ✗', m);
    console.error('[check] 请先 npm run prepare:vditor');
    process.exit(1);
  }
  console.log(`[check] OK，${expected.size} 条 audit 路径全部覆盖。`);
}
