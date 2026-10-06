import { getCurrentUser, isCoreUser, isCurrentlyBanned } from '@/lib/auth';
import { apiErr, apiOk } from '@/lib/format';
import { suggestMentionUsers } from '@/lib/mention-service';

// GET /api/mentions/users?kind=comment|chat&id=<文章或会话>&q=<用户名前缀>
export async function GET(req: Request) {
  const user = await getCurrentUser();
  if (!user) return apiErr(401, '请先登录');
  if (!isCoreUser(user)) return apiErr(403, '需要核心用户权限');
  if (isCurrentlyBanned(user)) return apiErr(403, '您已被禁言，无法发送提及');
  const params = new URL(req.url).searchParams;
  const kind = params.get('kind');
  const id = params.get('id');
  const query = params.get('q') ?? '';
  if ((kind !== 'comment' && kind !== 'chat') || !id || !/^[\p{L}\p{N}_-]{0,20}$/u.test(query)) {
    return apiErr(400, '无效的提及搜索参数');
  }
  const users = await suggestMentionUsers({ kind, id }, query, user);
  if (!users) return apiErr(404, '评论区或会话不可访问');
  return apiOk({ users });
}
