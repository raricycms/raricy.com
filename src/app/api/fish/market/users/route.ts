import { getCurrentUser } from '@/lib/auth';
import { apiOk, apiErr } from '@/lib/format';
import { searchTransferTargets } from '@/lib/fish-market-service';

const DEFAULT_LIMIT = 30;

// GET /api/fish/market/users?q=<query>&limit=<n>&offset=<n> — 搜索转账收款人
// （任意用户，排除自己）。返回 users + total，弹窗用 total 算总页数。
// 需登录：这是「站内用户名录」，不给匿名者当枚举接口用。
export async function GET(req: Request) {
  const user = await getCurrentUser();
  if (!user) return apiErr(401, '请先登录');

  const url = new URL(req.url);
  const q = url.searchParams.get('q') ?? '';
  // limit 必须过整数校验：Number('abc') = NaN 会一路传到 Prisma 的 take → 500
  const limitRaw = Number(url.searchParams.get('limit'));
  const limit = Number.isInteger(limitRaw) && limitRaw > 0 ? limitRaw : DEFAULT_LIMIT;
  const offsetRaw = Number(url.searchParams.get('offset') ?? '0');
  const offset = Number.isInteger(offsetRaw) && offsetRaw >= 0 ? offsetRaw : 0;

  const { users, total } = await searchTransferTargets(q, user.id, limit, offset);
  return apiOk({ users, total });
}
