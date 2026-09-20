// ─────────────────────────────────────────────────────────────────────────────
// fish-amount.ts — 鱼干**金额**的展示与解析（「能有多少位小数」「怎么显示」）
//
// 【为什么单独一个模块】发文表单、讨论、收银台、转账面板、练手盘都是**客户端组件**，
// 而 fish-service 那一侧拖着 prisma 进不了客户端包。这个模块是**零依赖**的
// （只 import fish-units.ts，那个模块自己也不 import 任何东西），两边都能用 ——
// 同 blog-visibility.ts 的做法。
//
// 【它解决的问题】「最多几位小数」这件事原先散在 7 份逐字相同的复制里
// （3 份 fmtFish + 4 份 AMOUNT_RE），改一次精度要改 7 个地方，漏一个就是
// 「服务端收 4 位小数、前端只让你输 1 位」。现在位数只有一个来源：
// fish-units.ts 的 FISH_DECIMALS，这里的正则与文案都由它插值出来。
//
// 【三个函数分别管什么 —— 别混用】
//   • fmtFish      展示用，**固定 4 位小数**（`12` → `"12.0000"`）。全站金额都长这样，
//                  主页余额卡与各面板因此逐字一致。
//   • fmtFishInput **回填输入框**用，去掉无意义的尾零（`12` → `"12"`）。
//                  拿 fmtFish 回填会让用户点一下「+1」就看见 `1.0000` —— 那是表单值，
//                  不是展示。
//   • roundFish    只做 4 位小数的收敛，出的是 number（算「转账后余额」这类投影用）。
//                  两个 4 位小数相减在 double 下会掉渣（0.3 - 0.1 = 0.19999999999999998），
//                  显示前必须过它。
// ─────────────────────────────────────────────────────────────────────────────

import { FISH_DECIMALS, FISH_UNIT_SCALE } from './fish-units';

/**
 * 金额白名单：正整数或最多 FISH_DECIMALS 位小数。
 * 与 fishToUnits 的口径一致 —— 前端先挡一道，服务端仍会复核（两边都不信任对方）。
 */
export const AMOUNT_RE = new RegExp(`^\\d+(\\.\\d{1,${FISH_DECIMALS}})?$`);

/** 格式不合法时的统一文案。服务端那两条在金额前有自己的主语（「转账金额…」），故各自拼。 */
export const AMOUNT_ERROR = `金额最多 ${FISH_DECIMALS} 位小数`;

/**
 * 把输入框文本解析成鱼干金额。格式不合法返回 null。
 *
 * ⚠️ 用 null 而不是 NaN 是刻意的：调用方要能区分「格式不对」（提示位数）与
 * 「数值不对」（提示需大于 0 / 余额不足），NaN 把这两件事混成一个。
 */
export function parseFishAmount(text: string): number | null {
  const trimmed = text.trim();
  return AMOUNT_RE.test(trimmed) ? Number(trimmed) : null;
}

/** 把任意金额收敛到 4 位小数（浮点残差的统一出口）。 */
export function roundFish(n: number): number {
  return Math.round(n * FISH_UNIT_SCALE) / FISH_UNIT_SCALE;
}

/** 展示：固定 4 位小数。 */
export function fmtFish(n: number): string {
  return n.toFixed(FISH_DECIMALS);
}

/** 回填输入框：去掉无意义的尾零（见文件头「三个函数分别管什么」）。 */
export function fmtFishInput(n: number): string {
  return String(roundFish(n));
}
