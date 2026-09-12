import { searchCoreUsers } from '@/lib/chat-service';
import { apiOk } from '@/lib/format';
import { parsePosInt, requireChatUser } from '../_auth';

const DEFAULT_LIMIT = 30;

// GET /api/chat/users?q=<query>&limit=<n>&offset=<n> — 搜索可私聊的 core+ 用户
// （排除自己）。返回 users + total，弹窗用 total 算分页总页数。
export async function GET(req: Request) {
  const user = await requireChatUser();
  if (user instanceof Response) return user;

  const url = new URL(req.url);
  const q = url.searchParams.get('q') ?? '';
  // limit 必须过 parsePosInt：Number('abc') = NaN 会一路传到 Prisma 的 take → 500
  const limit = parsePosInt(url.searchParams.get('limit')) ?? DEFAULT_LIMIT;
  const offsetRaw = Number(url.searchParams.get('offset') ?? '0');
  const offset = Number.isInteger(offsetRaw) && offsetRaw >= 0 ? offsetRaw : 0;

  const { users, total } = await searchCoreUsers(q, user.id, limit, offset);
  return apiOk({ users, total });
}
