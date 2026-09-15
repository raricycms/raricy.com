import { apiOk, apiErr } from '@/lib/format';
import { getTransactions, getTransactionsSince } from '@/lib/fish-service';
import { requireMarketActor } from '../_auth';

// POST /api/fish/market/transactions — 查流水（站外脚本用；网页走 GET /api/fish/balance）。
//
// 两种模式，用 `since_id` 区分：
//   · 翻页模式  body: { page?, per_page?, type? }        —— 人看，倒序、带总数
//   · 游标模式  body: { since_id, limit?, type? }        —— **对账机器人用**：返回
//     id > since_id 的流水（升序），响应带 next_cursor / has_more。取回 → 处理 →
//     存下游标，构造上不会漏也不会重（见 fish-service.getTransactionsSince 的注释）。
//   type 与网页筛选条同口径：checkin | feed_all | transfer_all | admin_grant | …
//
// 【为什么是 POST】同 ../balance/route.ts：凭据不能进 URL（会落到 access log）。
export const runtime = 'nodejs';

const DEFAULT_PER_PAGE = 20;
const DEFAULT_CURSOR_LIMIT = 100;

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

  const type = typeof body.type === 'string' && body.type ? body.type : null;

  // ── 游标模式（对账方）────────────────────────────────────────────────────
  // 只认「显式传了 since_id」：它合法就游标模式，非法就 400 —— 不静默退回翻页模式，
  // 那会让对账方以为自己在推进游标、其实每轮都从头拿，是漏记客户钱的经典姿势。
  if (body.since_id !== undefined && body.since_id !== null) {
    const sinceId = Number(body.since_id);
    if (!Number.isInteger(sinceId) || sinceId < 0) {
      return apiErr(400, 'since_id 必须是非负整数');
    }
    const limitRaw = Number(body.limit);
    const limit = Number.isInteger(limitRaw) && limitRaw > 0 ? limitRaw : DEFAULT_CURSOR_LIMIT;

    const rows = await getTransactionsSince(actor.id, sinceId, limit, type);
    const last = rows.length ? rows[rows.length - 1].id : sinceId;
    return apiOk({
      user_id: actor.id,
      username: actor.username,
      mode: 'cursor',
      transactions: rows,
      next_cursor: last,
      has_more: rows.length >= Math.min(100, limit),
    });
  }

  // ── 翻页模式（人看）──────────────────────────────────────────────────────
  // 非法页码一律回落到默认值（与 GET 接口同款：分区页的输入不值得 400）
  const pageRaw = Number(body.page);
  const page = Number.isInteger(pageRaw) && pageRaw > 0 ? pageRaw : 1;
  const perPageRaw = Number(body.per_page);
  const perPage =
    Number.isInteger(perPageRaw) && perPageRaw > 0 ? perPageRaw : DEFAULT_PER_PAGE;

  const data = await getTransactions(actor.id, page, perPage, type);
  return apiOk({
    user_id: actor.id,
    username: actor.username,
    mode: 'page',
    transactions: data.transactions,
    total: data.total,
    page: data.page,
    per_page: data.perPage,
    pages: data.pages,
    has_prev: data.hasPrev,
    has_next: data.hasNext,
  });
}
