import { searchCoreUsers } from '@/lib/chat-service';
import { apiOk } from '@/lib/format';
import { requireChatUser } from '../_auth';

// GET /api/chat/users?q=<query>&limit=<n> — 搜索可私聊的 core+ 用户（排除自己）
export async function GET(req: Request) {
  const user = await requireChatUser();
  if (user instanceof Response) return user;

  const url = new URL(req.url);
  const q = url.searchParams.get('q') ?? '';
  const limitRaw = Number(url.searchParams.get('limit') ?? '30');

  const users = await searchCoreUsers(q, user.id, limitRaw);
  return apiOk({ users });
}
