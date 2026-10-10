#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// copy-converter-assets.mjs —— 把格式转换器（/tool/convert）用到的引擎运行时
// 从 npm 包拷到 public/static/converter/，让浏览器从**同源**加载。
//
// 【为什么要同源拷贝】转换器的全部计算都在用户浏览器里跑（见
// docs/format-converter-plan.md），引擎本体是 wasm + worker：
//   · 默认走 CDN（unpkg / jsdelivr）—— 离线 / 内网部署当场坏，且把「访客在转
//     什么文件」这个信号发给第三方；
//   · 让 Next 去 bundle wasm 则会把它们卷进构建产物与 vercel 式输出跟踪，
//     而这些文件**只在 /tool/convert 动态 import 时才会被取**，不该进主包。
// 所以照 copy-mathjax-fonts / copy-emoji-assets 同款：构建期从锁版本的
// node_modules 拷进 public/，gitignore 掉，postinstall 自动重建。
//
// 【目录布局】（引擎代码按这里取，改布局 = 改所有引擎的 URL 常量）
//   public/static/converter/
//     ffmpeg/<@ffmpeg/core 版本>/ffmpeg-core.js       —— ST 核心加载器
//     ffmpeg/<@ffmpeg/core 版本>/ffmpeg-core.wasm
//     ffmpeg/worker.js + const.js + errors.js        —— @ffmpeg/ffmpeg 的类 worker 及其两个叶子依赖
//                                                        （worker 是 ES module，少一个就起不来）
//     pdfjs/pdf.worker.min.mjs                        —— pdfjs-dist 渲染 worker
//     tesseract/worker.min.js                         —— tesseract.js worker 入口
//     tesseract/tesseract-core-simd-lstm.js           —— LSTM 引擎（SIMD 版）
//     tesseract/tesseract-core-simd-lstm.wasm
//     tesseract/langs/eng.traineddata.gz              —— OCR 语言数据（英）
//     tesseract/langs/chi_sim.traineddata.gz          —— OCR 语言数据（简中）
//     unrar/unrar.wasm                                —— RAR 解包（node-unrar-js，只解不压）
//     7z/7zz.wasm                                     —— 7Z 解包（7z-wasm，只解不压）
//
// 【许可】全部是代码（Apache-2.0 / MIT），与 emoji 那次 CC BY 素材不同，
// 照拷各包自带 LICENSE 并列在 NOTICE.txt 里即可，无署名渲染义务。
// ⚠️ 两个解包器**只能解、不能压**：RAR 的编码器是专有技术（无自由实现），
// 7-Zip 的压缩侧在 wasm 构建里没编进去。所以 RAR / 7Z 的目标只有 ZIP ——
// 这不是偷懒，是许可与构建事实（见 docs/format-converter-plan.md §8.2 同款判据）。
//
// 【注意】`npm ci --ignore-scripts` 会跳过 postinstall —— 那种环境手工跑一次
// `npm run prepare:converter`。缺了文件时页面会显示「引擎加载失败」，
// 文件不出站、功能降级，**不是**安全闸门。
//
// 用法：npm run prepare:converter  /  npm run converter:check
// ─────────────────────────────────────────────────────────────────────────────

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEST = path.join(ROOT, 'public', 'static', 'converter');

const ffmpegCorePkg = JSON.parse(
  fs.readFileSync(
    path.join(ROOT, 'node_modules', '@ffmpeg', 'core', 'package.json'),
    'utf8'
  )
);
const FFMPEG_CORE_VERSION = ffmpegCorePkg.version;

// [源（相对 node_modules），目标（相对 DEST），说明]
const FILES = [
  [
    `@ffmpeg/core/dist/esm/ffmpeg-core.js`,
    `ffmpeg/${FFMPEG_CORE_VERSION}/ffmpeg-core.js`,
    'FFmpeg.wasm 单线程核心加载器',
  ],
  [
    `@ffmpeg/core/dist/esm/ffmpeg-core.wasm`,
    `ffmpeg/${FFMPEG_CORE_VERSION}/ffmpeg-core.wasm`,
    'FFmpeg.wasm 单线程核心',
  ],
  // @ffmpeg/ffmpeg 的类 worker：load({ classWorkerURL }) 指过来，
  // 避免 bundler 处理 `new URL('./worker.js', import.meta.url)` 的不可靠性。
  //
  // ⚠️ **worker.js 是 ES module，它自己 `import './const.js'` 与 `'./errors.js'`** ——
  // 那两个文件必须一起拷到同目录。漏了它们，worker 以 `type:"module"` 起不来
  // （相对 import 404），而**症状是「转换引擎加载失败（约 30MB…）」**：
  // 看起来像网络问题或核心太大，实际是我们少拷了两个几 KB 的叶子模块。
  // 它是唯二依赖（两文件都无进一步 import），所以只补这两个、不必拷整个 esm/。
  [
    `@ffmpeg/ffmpeg/dist/esm/worker.js`,
    `ffmpeg/worker.js`,
    '@ffmpeg/ffmpeg 类 worker（ES module，会 import 下面两个）',
  ],
  [`@ffmpeg/ffmpeg/dist/esm/const.js`, `ffmpeg/const.js`, 'worker 的常量表（叶子模块）'],
  [`@ffmpeg/ffmpeg/dist/esm/errors.js`, `ffmpeg/errors.js`, 'worker 的错误常量（叶子模块）'],
  [
    `pdfjs-dist/build/pdf.worker.min.mjs`,
    `pdfjs/pdf.worker.min.mjs`,
    'pdf.js 渲染 worker（GlobalWorkerOptions.workerSrc 指过来）',
  ],
  [`tesseract.js/dist/worker.min.js`, `tesseract/worker.min.js`, 'tesseract.js worker'],
  [
    `tesseract.js-core/tesseract-core-simd-lstm.js`,
    `tesseract/tesseract-core-simd-lstm.js`,
    'Tesseract LSTM 引擎（SIMD）',
  ],
  [
    `tesseract.js-core/tesseract-core-simd-lstm.wasm`,
    `tesseract/tesseract-core-simd-lstm.wasm`,
    'Tesseract LSTM 引擎 wasm',
  ],
  [
    `@tesseract.js-data/eng/4.0.0/eng.traineddata.gz`,
    `tesseract/langs/eng.traineddata.gz`,
    'OCR 语言数据：英文',
  ],
  [
    `@tesseract.js-data/chi_sim/4.0.0/chi_sim.traineddata.gz`,
    `tesseract/langs/chi_sim.traineddata.gz`,
    'OCR 语言数据：简体中文',
  ],
  // 两个解包器的 wasm。**必须显式拷**：包自己的加载器在打包环境里找 wasm 的方式
  // 不可靠（7z-wasm 尤甚，它的 UMD/ESM 构建都在探 Node 的 fs 路径），所以引擎侧
  // 是自己 fetch 同源文件再把 wasmBinary 传进去 —— 路径由
  // src/lib/file-converter/engines/archive.ts 的 UNRAR_WASM_URL / SEVENZ_WASM_URL 决定，
  // **改这里的目标路径就要同步改那两个常量**（两处不一致 = RAR/7Z 报组件加载失败，
  // 其它能力区一切正常，所以很容易漏）。
  [
    `node-unrar-js/esm/js/unrar.wasm`,
    `unrar/unrar.wasm`,
    'RAR 解包组件（node-unrar-js）',
  ],
  [`7z-wasm/7zz.wasm`, `7z/7zz.wasm`, '7Z 解包组件（7z-wasm）'],
];

// tesseract.js-core 是 tesseract.js 的**传递依赖**：哪天上游改了依赖结构，
// 这里会以「源文件缺失」当场炸，而不是静默拷出一个缺引擎的目录。
const missing = FILES.filter(
  ([src]) => !fs.existsSync(path.join(ROOT, 'node_modules', src))
);
if (missing.length > 0) {
  console.error(`[copy-converter-assets] ${missing.length} 个源文件不存在：`);
  for (const [src] of missing) console.error(`  ✗ node_modules/${src}`);
  console.error('[copy-converter-assets] 依赖没装全（先 npm ci）或上游包结构变了。');
  process.exit(1);
}

// ─── 自检模式：CI / 升级依赖后验证产物齐全 ────────────────────────────────────
if (process.argv.includes('--check')) {
  const absent = FILES.filter(([, dest]) => !fs.existsSync(path.join(DEST, dest)));
  if (absent.length > 0) {
    console.error(`[check] 缺 ${absent.length} 个产物：`);
    for (const [, dest] of absent) console.error('  ✗', dest);
    console.error('[check] 请先 npm run prepare:converter');
    process.exit(1);
  }
  console.log(`[check] OK，${FILES.length} 个转换器引擎文件齐全。`);
  process.exit(0);
}

fs.mkdirSync(DEST, { recursive: true });
// 先清空再拷：升级 @ffmpeg/core 后版本目录会变，残留旧版本只会白白增大体积。
for (const f of fs.readdirSync(DEST)) {
  fs.rmSync(path.join(DEST, f), { recursive: true, force: true });
}

let bytes = 0;
for (const [src, dest] of FILES) {
  const from = path.join(ROOT, 'node_modules', src);
  const to = path.join(DEST, dest);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
  bytes += fs.statSync(from).size;
  console.log(`  ✓ ${dest}`);
}

console.log(
  `[copy-converter-assets] 完成。${FILES.length} 个文件，约 ${(bytes / 1024 / 1024).toFixed(1)}MB → public/static/converter/`
);
