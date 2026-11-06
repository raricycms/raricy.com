// ─────────────────────────────────────────────────────────────────────────────
// pagination.ts —— 分页参数的**唯一归一入口**（R3-412 / C11）
//
// 【为什么需要】各 service 此前一律写 `Math.max(1, params.page ?? 1)`：
//   · `??` 只兜 null / undefined，兜不住 `parseInt('abc')` 得到的 NaN；
//   · `Math.max(1, NaN)` 仍是 NaN → `skip: (NaN - 1) * perPage = NaN`，
//     Prisma 客户端校验失败 → 页面 / 接口 500，把「参数写错」报成服务故障。
//   · 同式的 `perPage` 在 NaN 下也会是 NaN。
//
// 【对外行为】分页是**展示参数**，不是业务入参：非法 / 非正数一律按第 1 页，
// perPage 夹到 [1, max]（与既有 `Math.max(1, …)` 的语义一致），**不新增 400**。
// 越界的大页码仍按现状返回空页（是否收敛到末页属于另一个产品决定，本文件不处理）。
// ─────────────────────────────────────────────────────────────────────────────

/** 页码归一：非法 / 非正数 → fallback（默认 1）。接受 number 或字符串（页面/路由的 parseInt 结果）。 */
export function parsePage(raw: unknown, fallback = 1): number {
  const n = typeof raw === 'number' ? raw : Number.parseInt(String(raw ?? ''), 10);
  return Number.isSafeInteger(n) && n >= 1 ? n : fallback;
}

/** 每页条数归一：非数字 → fallback；非正数夹到 1（与既有 Math.max(1, …) 一致）；合法值夹到 [1, max]。 */
export function parsePerPage(raw: unknown, fallback: number, max: number): number {
  const n = typeof raw === 'number' ? raw : Number.parseInt(String(raw ?? ''), 10);
  if (!Number.isSafeInteger(n)) return fallback;
  if (n < 1) return 1;
  return Math.min(max, n);
}
