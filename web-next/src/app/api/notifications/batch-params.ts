// 两个 batch 端点（batch-mark-read / batch-delete）共用的入参解析。
// 对齐 Flask notifications.api_batch_mark_read / api_batch_delete 的两段校验与文案：
//   1. body 缺失或没有 notification_ids → 「缺少必要的参数」
//   2. notification_ids 不是数组       → 「通知ID必须是数组」

export type ParsedIds = { ids: string[] } | { error: string };

export async function parseNotificationIds(req: Request): Promise<ParsedIds> {
  // Flask 的 request.get_json() 在 body 非法时抛/返回 None，统一落到「缺少必要的参数」
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== 'object' || !('notification_ids' in body)) {
    return { error: '缺少必要的参数' };
  }

  const raw = body.notification_ids;
  if (!Array.isArray(raw)) return { error: '通知ID必须是数组' };

  // Flask 直接把列表塞进 id.in_()，非字符串项在 SQLite 里只是匹配不到；
  // 这里先滤掉非字符串，避免 Prisma 因类型不符直接抛 500。
  return { ids: raw.filter((x): x is string => typeof x === 'string') };
}
