import { searchCoreUsers } from '@/lib/chat-service';
import { apiOk } from '@/lib/format';
import { parsePosInt, requireChatUser } from '../_auth';

const DEFAULT_LIMIT = 30;

// GET /api/chat/users?q=<query>&limit=<n>&offset=<n>&include_self=1 — 搜索 core+ 用户。
// 返回 users + total，弹窗用 total 算分页总页数。
//
// 默认**排除自己**（发起私聊那处的语义：跟自己私聊没有意义）。名片选择器要能发自己的
// 名片，所以它显式带上 `include_self=1` —— 两边的用途不同，不该由这一个接口替它们定死。
export async function GET(req: Request) {
  const user = await requireChatUser();
  if (user instanceof Response) return user;

  const url = new URL(req.url);
  const q = url.searchParams.get('q') ?? '';
  // limit 必须过 parsePosInt：Number('abc') = NaN 会一路传到 Prisma 的 take → 500
  const limit = parsePosInt(url.searchParams.get('limit')) ?? DEFAULT_LIMIT;
  const offsetRaw = Number(url.searchParams.get('offset') ?? '0');
  const offset = Number.isInteger(offsetRaw) && offsetRaw >= 0 ? offsetRaw : 0;
  const includeSelf = url.searchParams.get('include_self') === '1';

  const { users, total } = await searchCoreUsers(q, user.id, limit, offset, { includeSelf });
  return apiOk({ users, total });
}
