import { apiOk, apiErr } from '@/lib/format';
import { getTransactions } from '@/lib/fish-service';
import { requireMarketActor } from '../_auth';

// POST /api/fish/market/transactions — 查流水（站外脚本用；网页走 GET /api/fish/balance）。
//
// body: { username?, password?, page?, per_page?, type? }
//   type 与网页筛选条同口径：checkin | feed_all | transfer_all | admin_grant | …
// 响应形状与 GET /api/fish/balance 的流水部分**逐字段相同** —— 站外脚本只学一套。
//
// 【为什么是 POST】同 ../balance/route.ts：凭据不能进 URL（会落到 access log）。
export const runtime = 'nodejs';

const DEFAULT_PER_PAGE = 20;

export async function POST(req: Request) {
  let body: Record<string, unknown> = {};
  try {
    const raw = await req.text();
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        return apiErr(400, '无效的请求');
      }
      body = parsed as Record<string, unknown>;
    }
  } catch {
    return apiErr(400, '请求体格式错误');
  }

  const actor = await requireMarketActor(req, body);
  if (actor instanceof Response) return actor;

  // 非法页码一律回落到默认值（与 GET 接口同款：分区页的输入不值得 400）
  const pageRaw = Number(body.page);
  const page = Number.isInteger(pageRaw) && pageRaw > 0 ? pageRaw : 1;
  const perPageRaw = Number(body.per_page);
  const perPage =
    Number.isInteger(perPageRaw) && perPageRaw > 0 ? perPageRaw : DEFAULT_PER_PAGE;
  const type = typeof body.type === 'string' && body.type ? body.type : null;

  const data = await getTransactions(actor.id, page, perPage, type);
  return apiOk({
    user_id: actor.id,
    username: actor.username,
    transactions: data.transactions,
    total: data.total,
    page: data.page,
    per_page: data.perPage,
    pages: data.pages,
    has_prev: data.hasPrev,
    has_next: data.hasNext,
  });
}
