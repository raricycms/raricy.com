import { getCurrentUser } from '@/lib/auth';
import { updateOwnProfile, type ProfilePatch } from '@/lib/user-service';
import { apiErr } from '@/lib/format';
import { parseFocusHiddenCategories } from '@/lib/focus-mode';

// GET /api/users/me — 本人可编辑资料（供设置页加载当前值）。未登录返回 401。
export async function GET() {
  const user = await getCurrentUser();
  if (!user) return apiErr(401, '未登录');
  return Response.json({
    code: 200,
    message: 'ok',
    profile: {
      id: user.id,
      username: user.username,
      bio: user.bio,
      notifyLike: user.notifyLike ?? true,
      notifyEdit: user.notifyEdit ?? true,
      notifyDelete: user.notifyDelete ?? true,
      notifyAdmin: user.notifyAdmin ?? true,
      showRecentBlogs: user.showRecentBlogs,
      showRecentComments: user.showRecentComments,
      focusMode: user.focusMode,
      // 专注模式子项原值（设置页三颗开关要回显；实际闸门见 src/lib/focus-mode.ts）
      focusBlockLobby: user.focusBlockLobby,
      focusBlockGames: user.focusBlockGames,
      focusBlockFishTrade: user.focusBlockFishTrade,
      // JSON 文本 → 数组（null = 未自定义，沿用站长默认集合；[] = 明确不屏蔽）
      focusHideCategories: parseFocusHiddenCategories(user.focusHideCategories),
    },
  });
}

// PATCH /api/users/me — 更新本人资料（bio、通知偏好、隐私开关、专注模式）。
// 登录必需，仅限本人。专注模式的**栏目选项清单**另走 GET/PATCH /api/users/me/focus。
export async function PATCH(req: Request) {
  const user = await getCurrentUser();
  if (!user) return apiErr(401, '未登录');

  let body: ProfilePatch;
  try {
    body = (await req.json()) as ProfilePatch;
  } catch {
    return apiErr(400, '请求体格式错误');
  }

  const result = await updateOwnProfile(user.id, body);
  if (!result.ok) return apiErr(result.code, result.message);

  return Response.json({ code: 200, message: result.message, ...result.data });
}
