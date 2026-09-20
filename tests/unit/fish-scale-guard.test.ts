// 鱼干标度的**旁路守卫**（静态）。
//
// 【为什么要静态守卫】`FISH_UNIT_SCALE` 是编译期常量。任何**手写**了标度的地方，
// 在它改动时都**不会报错** —— tsc 看不出来，运行时也不抛：
//
//   • 脚本里写死 `const UNIT = 10`   → 精度提升后每笔少发 1000 倍，
//     而它自己的 dry-run 展示与写库是同比例错的，**输出看起来完全合理**。
//   • 组件里写死 `Math.round(x * 10) / 10` → 界面上的估算值静默错 1000 倍。
//
// 这两类都真实发生过（2026-09 把精度从 0.1 抬到 0.0001 时挨个排查出来的）。
// 已修掉的那些，靠这个文件钉住，防止下次又被"顺手写回来"。
//
// 判据是**文件文本**，不跑代码 —— 与 db-time-guard / blog-visibility-guard 同款。
// 新增写死标度的地方时，往下面的清单里加一条。

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { FISH_DECIMALS, FISH_UNIT_SCALE } from '@/lib/fish-units';

const ROOT = path.resolve(import.meta.dirname, '../..');

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

/** 递归列出某目录下的源码文件（跳过 node_modules / .next / 迁移与测试产物）。 */
function sourceFiles(dir: string, exts: string[]): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (['node_modules', '.next', 'migrations'].includes(entry.name)) continue;
      out.push(...sourceFiles(rel, exts));
    } else if (exts.some((e) => entry.name.endsWith(e))) {
      out.push(rel);
    }
  }
  return out;
}

describe('手写标度的旁路（改 FISH_UNIT_SCALE 时不会报错的地方）', () => {
  it('compensate-unclaimed-fortunes.mjs 的 UNIT 与 FISH_UNIT_SCALE 一致', () => {
    // 这个脚本不 import TS（它是裸 .mjs，靠 node 直接跑），所以标度只能手写 ——
    // 于是必须由本用例替编译器盯着。它写库时用 `p.value * UNIT`，写错就是**少发/多发鱼干**，
    // 且 dry-run 的展示用的是同一个 UNIT，两边同比例错，人眼看不出异常。
    const src = read('scripts/compensate-unclaimed-fortunes.mjs');
    const m = /^const UNIT = (\d+);/m.exec(src);
    expect(m, 'compensate 脚本里找不到 `const UNIT = <数字>;`').not.toBeNull();
    expect(Number(m![1])).toBe(FISH_UNIT_SCALE);
  });

  it('src/ 里没有第二份 fmtFish 定义（展示口径只有 src/lib/fish-amount.ts 一处）', () => {
    // 曾经有 3 份逐字相同的 fmtFish 散在三个面板里，各自靠注释声明「与 fish-units 口径一致」。
    // 改精度时要改 3 个地方，漏一个就是「同一个余额在 /fish 和 /fish/market 显示得不一样」。
    const offenders = sourceFiles('src', ['.ts', '.tsx']).filter(
      (f) => f.replace(/\\/g, '/') !== 'src/lib/fish-amount.ts' && /function fmtFish\b/.test(read(f))
    );
    expect(offenders, `这些文件又自己定义了 fmtFish：${offenders.join(', ')}`).toEqual([]);
  });

  it('src/ 里没有写死位数的金额白名单正则', () => {
    // 曾经有 4 份 `const AMOUNT_RE = /^\d+(\.\d)?$/;`。位数写死成 `\d` 的后果是
    // 「服务端收了 4 位小数、前端只让输 1 位」—— 表现是「功能在 UI 上不存在」，
    // 而且服务端不报错，所以查起来毫无线索。
    const offenders = sourceFiles('src', ['.ts', '.tsx']).filter(
      (f) => f.replace(/\\/g, '/') !== 'src/lib/fish-amount.ts' && /AMOUNT_RE\s*=\s*\/\^/.test(read(f))
    );
    expect(offenders, `这些文件又自己写了金额正则：${offenders.join(', ')}`).toEqual([]);
  });

  it('src/ 里没有 `Math.round(x * 10) / 10` 这类写死标度的收敛式', () => {
    // 客户端的金额收敛一律走 fish-amount 的 roundFish / fmtFishInput。
    // 写死 10 的那几处（转账后余额、练手盘持仓估算）在精度提升后**静默错 1000 倍**，
    // 其中持仓估算那处尤其危险：用户是看着「可卖」那个数决定要不要平仓的。
    // ⚠️ 用 `.*` 而不是 `[^)]*`：真实的违规长这样 ——
    //   `Math.round((balance - parsed) * 10) / 10`
    // 里层还有一对括号，`[^)]*` 会在第一个 `)` 就停下，正好漏掉要抓的那一行。
    // 逐行匹配，所以 `.*` 不会跨行。
    const offenders: string[] = [];
    for (const f of sourceFiles('src', ['.ts', '.tsx'])) {
      const src = read(f);
      src.split('\n').forEach((line, i) => {
        if (/Math\.round\(.*\*\s*10\s*\)\s*\/\s*10/.test(line)) {
          offenders.push(`${f}:${i + 1}`);
        }
      });
    }
    expect(offenders, `这些行写死了标度 10：${offenders.join(', ')}`).toEqual([]);
  });

  it('FISH_DECIMALS 与标度同源（这个前提不成立时上面的判据全要重写）', () => {
    expect(FISH_UNIT_SCALE).toBe(10 ** FISH_DECIMALS);
  });
});
