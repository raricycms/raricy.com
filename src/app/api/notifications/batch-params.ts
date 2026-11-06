// 两个 batch 端点（batch-mark-read / batch-delete）共用的入参解析。
// 校验与返回文案（两个端点共用这一份）：
//   1. body 缺失或没有 notification_ids → 「缺少必要的参数」
//   2. notification_ids 不是数组       → 「通知ID必须是数组」
//   3. 数组超过上限                     → 400（不落到 Prisma 绑定变量上限的未捕获 500）
//   4. 数组里有非字符串项               → 400（不再静默滤掉：静默过滤会让调用方以为全处理了）

/**
 * 单次批量上限。
 *
 * 与仓内其它批量语义一致（≤200）：超过它的 `IN (?,…)` 会撞 SQLite/Prisma 的绑定变量
 * 上限，原先无人接住就是一个框架 500（非 JSON）。正常调用方一次只勾选当前页
 * （通知每页 20），200 条已是 10 页的全选量，足够宽。
 */
export const MAX_BATCH_NOTIFICATION_IDS = 200;

export type ParsedIds = { ids: string[] } | { error: string };

export async function parseNotificationIds(req: Request): Promise<ParsedIds> {
  // body 非法（读不出 JSON / 不是对象）时统一落到「缺少必要的参数」，不单独报解析错
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== 'object' || !('notification_ids' in body)) {
    return { error: '缺少必要的参数' };
  }

  const raw = body.notification_ids;
  if (!Array.isArray(raw)) return { error: '通知ID必须是数组' };
  if (raw.length > MAX_BATCH_NOTIFICATION_IDS) {
    return { error: `一次最多处理 ${MAX_BATCH_NOTIFICATION_IDS} 条通知` };
  }
  // 逐元素校验：留着非字符串项会让 Prisma 因类型不符直接抛 500（不是「匹配不到」那么轻）；
  // 也不能静默滤掉 —— 调用方会以为它们也被处理了。
  if (!raw.every((x): x is string => typeof x === 'string')) {
    return { error: '通知ID必须都是字符串' };
  }
  return { ids: raw as string[] };
}
