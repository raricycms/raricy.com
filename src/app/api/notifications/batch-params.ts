// 两个 batch 端点（batch-mark-read / batch-delete）共用的入参解析。
// 两段校验与返回文案（两个端点共用这一份）：
//   1. body 缺失或没有 notification_ids → 「缺少必要的参数」
//   2. notification_ids 不是数组       → 「通知ID必须是数组」

export type ParsedIds = { ids: string[] } | { error: string };

export async function parseNotificationIds(req: Request): Promise<ParsedIds> {
  // body 非法（读不出 JSON / 不是对象）时统一落到「缺少必要的参数」，不单独报解析错
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== 'object' || !('notification_ids' in body)) {
    return { error: '缺少必要的参数' };
  }

  const raw = body.notification_ids;
  if (!Array.isArray(raw)) return { error: '通知ID必须是数组' };

  // 先滤掉非字符串项：留着会让 Prisma 因类型不符直接抛 500（不是「匹配不到」那么轻）。
  return { ids: raw.filter((x): x is string => typeof x === 'string') };
}
