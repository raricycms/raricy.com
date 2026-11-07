#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// check-font-assets.mjs —— 校验入库字体资产（R3-620）
//
// 【为什么需要】public/static/fonts/ 下的 11 个 WOFF2 是**随代码入库的二进制**：
//   · 4 个 JetBrains Mono（代码块/编辑器）
//   · 2 个 Kumbh Sans + 1 个 Outfit（正文 / 英文品牌名）
//   · 4 个 Raricy Numeric（由 scripts/make-numeric-fonts.py 生成的数字子集）
// 它们没有任何编译期检查：文件被删、被截断、被误替换成都市不会报错——只会等到
// 浏览器 404 或字重/字形悄悄变化。`make-numeric-fonts.py --check` 能验证可复现性，
// 但需要 Python + fonttools；本守卫只用 Node，作为默认的 `npm run fonts:check`。
//
// 【哈希从哪来】下面 HASHES 是入库文件的 SHA-256：资产变更（重新生成/升级字体）
// 是**有意的**动作，届时同步更新这里的哈希即可；非有意改动会被这条守卫拦住。
//
// 用法：npm run fonts:check
// 重新生成 + 可复现校验（需要 Python）：npm run fonts:check:regen
// ─────────────────────────────────────────────────────────────────────────────

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FONT_DIR = path.join(ROOT, 'public', 'static', 'fonts');

/** 入库 WOFF2 → SHA-256（相对 public/static/fonts/）。改字体时同步更新。 */
const HASHES = {
  'jetbrains-mono/JetBrainsMono-Bold.woff2': 'c503cc5ec5f8b2c7666b7ecda1adf44bd45f2e6579b2eba0fc292150416588a2',
  'jetbrains-mono/JetBrainsMono-BoldItalic.woff2': '3a013466c0eee979fb9d42c2d7a8887cd3645dc8b897cfc5b71781cf982efc5a',
  'jetbrains-mono/JetBrainsMono-Italic.woff2': 'cb6a1b246318ed3885d7dffa14a2609297fe80e9b8e500bea33b52fa312a36a4',
  'jetbrains-mono/JetBrainsMono-Regular.woff2': 'a9cb1cd82332b23a47e3a1239d25d13c86d16c4220695e34b243effa999f45f2',
  'kumbh-sans/KumbhSans-Latin-Variable.woff2': 'd253244d475e8b0d5c521b1742f1ae3ec29280c113a6f29dad54bc4f320311d1',
  'kumbh-sans/KumbhSans-LatinExt-Variable.woff2': '51076410948bef96b68d11b95d5fce879d3f738298c125d3aa0e510870cf41b6',
  'outfit/Outfit-Latin-Variable.woff2': '6c18d579fd87c3776be068b762cbc83fde3acb543d49eabd3ade842eb987e887',
  'raricy-numeric/RaricyNumeric-Bold.woff2': '8546858d6c0005b90ed4900cef7d3c9eecbee8adab0235fe88693cfa3aef29d9',
  'raricy-numeric/RaricyNumeric-BoldItalic.woff2': '85c897980e863a9b1e6f175cfa5020305ec4fd7b31c027d00548079d87748090',
  'raricy-numeric/RaricyNumeric-Italic.woff2': '9263b871c3722609759bfe8a7ac2330969829d23c49fdd209e19b58a10030163',
  'raricy-numeric/RaricyNumeric-Regular.woff2': '13c1bf0d486ce9ef3a5ed5003e808a5a1833299b4e525dc79bdad2f63ff4519d',
};

/** 每个家族都要带 OFL 许可正文（README 的再分发依据）。 */
const FAMILIES = ['jetbrains-mono', 'kumbh-sans', 'outfit', 'raricy-numeric'];
/** 生成子集保持很小：单个文件超过这个体积说明不是预期的 22 字符子集。 */
const SUBSET_MAX_BYTES = 10_000;

const errors = [];
for (const [rel, expected] of Object.entries(HASHES)) {
  const full = path.join(FONT_DIR, rel);
  let buf;
  try {
    buf = readFileSync(full);
  } catch {
    errors.push(`缺少文件：${rel}`);
    continue;
  }
  if (buf.subarray(0, 4).toString('latin1') !== 'wOF2') errors.push(`${rel}：不是 WOFF2（魔数不符）`);
  if (rel.startsWith('raricy-numeric/') && buf.length >= SUBSET_MAX_BYTES) {
    errors.push(`${rel}：${buf.length} 字节，超过数字子集上限 ${SUBSET_MAX_BYTES}`);
  }
  const actual = createHash('sha256').update(buf).digest('hex');
  if (actual !== expected) errors.push(`${rel}：哈希不符（内容被改动/重生成后未更新守卫）`);
}
for (const family of FAMILIES) {
  try {
    const txt = readFileSync(path.join(FONT_DIR, family, 'OFL.txt'), 'utf8');
    if (!txt.trim()) errors.push(`${family}/OFL.txt 为空`);
  } catch {
    errors.push(`缺少许可：${family}/OFL.txt`);
  }
}

if (errors.length) {
  console.error(`[fonts:check] ${errors.length} 处问题：`);
  for (const e of errors) console.error('  ✗ ' + e);
  process.exit(1);
}
console.log(`[fonts:check] ✓ ${Object.keys(HASHES).length} 个 WOFF2 与 ${FAMILIES.length} 份 OFL 校验通过`);
