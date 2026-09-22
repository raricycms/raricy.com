import { getCurrentUser } from '@/lib/auth';
import { apiOk, apiErr } from '@/lib/format';
import { getTransactions, toFishTxJson } from '@/lib/fish-service';

// GET /api/fish/transactions — 当前用户流水分页（需登录）。
// query: ?page=1&per_page=20&type=checkin|feed_all|transfer_all|market_all|frame_rent|admin_grant
//        （筛选条那套值 = 页面 FILTERS 数组；合称映射见 fish-service.applyTypeFilter。
//          这里**曾经**列过 `purchase` —— 那个 type 从来不存在，付款流水是 transfer）
//
// 返回字段固定 snake_case，且**与另外两条流水读口逐字段相同**（`toFishTxJson`）。
// 这三条路由共用同一个映射是刻意的：它们曾经各自为政，结果同一个字段在三个接口里
// 两种拼法，见 `fish-service.toFishTxJson` 的注释。
export async function GET(req: Request) {
  const user = await getCurrentUser();
  if (!user) return apiErr(401, '请先登录');

  const url = new URL(req.url);
  const page = Number.parseInt(url.searchParams.get('page') ?? '1', 10) || 1;
  const perPage = Number.parseInt(url.searchParams.get('per_page') ?? '20', 10) || 20;
  const type = url.searchParams.get('type');

  const data = await getTransactions(user.id, page, perPage, type);

  return apiOk({
    transactions: data.transactions.map(toFishTxJson),
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
