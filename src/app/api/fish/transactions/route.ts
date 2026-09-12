import { getCurrentUser } from '@/lib/auth';
import { apiOk, apiErr } from '@/lib/format';
import { getTransactions } from '@/lib/fish-service';

// GET /api/fish/transactions — 当前用户流水分页（对齐 /fish/api/transactions，需登录）。
// query: ?page=1&per_page=20&type=checkin|feed_all|admin_grant|purchase|...
// 返回字段与 Flask 一致（snake_case，供外部项目消费）。
export async function GET(req: Request) {
  const user = await getCurrentUser();
  if (!user) return apiErr(401, '请先登录');

  const url = new URL(req.url);
  const page = Number.parseInt(url.searchParams.get('page') ?? '1', 10) || 1;
  const perPage = Number.parseInt(url.searchParams.get('per_page') ?? '20', 10) || 20;
  const type = url.searchParams.get('type');

  const data = await getTransactions(user.id, page, perPage, type);

  return apiOk({
    transactions: data.transactions.map((t) => ({
      id: t.id,
      user_id: user.id,
      amount: t.amount,
      type: t.type,
      description: t.description,
      reference_type: t.referenceType,
      reference_id: t.referenceId,
      related_user_id: t.relatedUserId,
      created_at: t.createdAt,
    })),
    total: data.total,
    page: data.page,
    per_page: data.perPage,
    pages: data.pages,
    has_prev: data.hasPrev,
    has_next: data.hasNext,
    prev_num: data.hasPrev ? data.page - 1 : null,
    next_num: data.hasNext ? data.page + 1 : null,
  });
}
