import { getCurrentUser } from '@/lib/auth';
import { apiOk, apiErr } from '@/lib/format';
import { getBalance, getTransactions } from '@/lib/fish-service';

// GET /api/fish/balance — 当前用户余额 + 分页流水（需登录）
// query: ?page=1&per_page=20&type=checkin|feed|feed_all|...
export async function GET(req: Request) {
  const user = await getCurrentUser();
  if (!user) return apiErr(401, '请先登录');

  const url = new URL(req.url);
  const page = Number.parseInt(url.searchParams.get('page') ?? '1', 10) || 1;
  const perPage = Number.parseInt(url.searchParams.get('per_page') ?? '20', 10) || 20;
  const type = url.searchParams.get('type');

  const [balance, txPage] = await Promise.all([
    getBalance(user.id),
    getTransactions(user.id, page, perPage, type),
  ]);

  return apiOk({
    balance,
    transactions: txPage.transactions,
    total: txPage.total,
    page: txPage.page,
    per_page: txPage.perPage,
    pages: txPage.pages,
    has_prev: txPage.hasPrev,
    has_next: txPage.hasNext,
  });
}
