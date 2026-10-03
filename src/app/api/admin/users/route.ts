// GET /api/admin/users?page=&search=&perPage= — 用户列表（管理员）
//
// 【只有列表了：网页建号入口已删除】这里曾有一条 `POST /api/admin/users`（站长凭空
// 建一个 core 号）。它是**全站唯一一条绕过公开注册两道门**（人机验证 + 邀请码）的
// 路径，而且**只要网页 owner 权限就用得动** —— 一个 owner 拿它批量造小号，等于绕开
// 了「注册必须过 Turnstile」这道闸（也绕开了邀请码这道 core 的入口闸）。
// 需要手动开号时走运维 CLI 的 `user create`：那要 shell 权限，是另一个信任边界，
// 网页侧的 owner 够不着。**别再把它加回来。**
import { getCurrentUser, hasAdminRights } from '@/lib/auth';
import { listUsers } from '@/lib/admin-user-service';
import { apiErr } from '@/lib/format';

export async function GET(req: Request) {
  const user = await getCurrentUser();
  if (!hasAdminRights(user)) return apiErr(403, '没有管理员权限');

  const url = new URL(req.url);
  const result = await listUsers({
    page: parseInt(url.searchParams.get('page') || '1', 10),
    perPage: parseInt(url.searchParams.get('perPage') || '0', 10) || undefined,
    search: url.searchParams.get('search'),
  });

  return Response.json({
    code: 200,
    message: 'ok',
    users: result.users,
    pagination: {
      page: result.page,
      pages: result.pages,
      total: result.total,
      per_page: result.perPage,
      has_prev: result.hasPrev,
      has_next: result.hasNext,
    },
  });
}
