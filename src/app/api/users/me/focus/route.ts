import { getCurrentUser } from '@/lib/auth';
import { updateOwnProfile, type ProfilePatch } from '@/lib/user-service';
import { apiErr, apiOk } from '@/lib/format';
import { getFocusState, getFocusStateById } from '@/lib/focus-service';
import { parseFocusHiddenCategoriesInput } from '@/lib/focus-mode';

// ─────────────────────────────────────────────────────────────────────────────
// GET/PATCH /api/users/me/focus —— 专注模式设置（含可勾选的博客栏目清单）
//
// 【为什么单独开一条】设置页那块卡片要的是一份「状态 + 选项」的组合：
//   · 总开关 / 三个子项的原值；
//   · 可勾选的栏目（启用中的 + 已选中的停用栏目）；
//   · 当前生效的选中集合（已展开子栏目）与「是否已自定义」。
// 这些都要查库，塞进 GET /api/users/me 的 profile 会让那个「本人资料」读口
// 变成一个半页面接口。PATCH 仍走 updateOwnProfile —— SSE 踢流 / 顶栏红点推送
// 那套副作用只该有一份实现，别在这里另写一遍。
//
// 【字段】（PATCH 全部可选，只打补丁）
//   enabled           boolean   总开关
//   blockLobby        boolean   屏蔽讨论大区
//   blockGames        boolean   屏蔽玩具区
//   blockFishTrade    boolean   屏蔽鱼干练手盘
//   hiddenCategoryIds number[] | null
//                     null = 恢复站长默认集合；[] = 明确一个都不屏蔽
//
// 鉴权：登录即可（本人）。栏目清单对非 core 用户也返回 —— 他们同样能开专注模式
// 屏蔽玩具区，而栏目清单本身不含任何用户数据（/blog 的公开列表也在用它）。
// ─────────────────────────────────────────────────────────────────────────────

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return apiErr(401, '未登录');
  return apiOk(await getFocusState(user));
}

interface FocusPatchBody {
  enabled?: unknown;
  blockLobby?: unknown;
  blockGames?: unknown;
  blockFishTrade?: unknown;
  hiddenCategoryIds?: unknown;
}

export async function PATCH(req: Request) {
  const user = await getCurrentUser();
  if (!user) return apiErr(401, '未登录');

  let body: FocusPatchBody;
  try {
    body = (await req.json()) as FocusPatchBody;
  } catch {
    return apiErr(400, '请求体格式错误');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return apiErr(400, '请求体格式错误');
  }

  const patch: ProfilePatch = {};
  let touched = false;
  const assignBool = (
    key: keyof FocusPatchBody,
    target: 'focusMode' | 'focusBlockLobby' | 'focusBlockGames' | 'focusBlockFishTrade'
  ) => {
    if (!(key in body)) return true;
    const value = body[key];
    if (typeof value !== 'boolean') return false;
    patch[target] = value;
    touched = true;
    return true;
  };
  if (!assignBool('enabled', 'focusMode')) return apiErr(400, '专注模式开关格式错误');
  if (!assignBool('blockLobby', 'focusBlockLobby')) return apiErr(400, '屏蔽大区开关格式错误');
  if (!assignBool('blockGames', 'focusBlockGames')) return apiErr(400, '屏蔽玩具开关格式错误');
  if (!assignBool('blockFishTrade', 'focusBlockFishTrade')) {
    return apiErr(400, '屏蔽练手盘开关格式错误');
  }

  if ('hiddenCategoryIds' in body) {
    const parsed = parseFocusHiddenCategoriesInput(body.hiddenCategoryIds);
    if (!parsed.ok) return apiErr(400, '屏蔽栏目格式错误');
    patch.focusHideCategories = parsed.value;
    touched = true;
  }

  if (!touched) return apiErr(400, '没有可更新的字段');

  const result = await updateOwnProfile(user.id, patch);
  if (!result.ok) return apiErr(result.code, result.message);

  // 重新读一遍最新状态：栏目选择在 default / 自定义之间切换时，selected 与
  // categories 都要按新值重算。读不到（账号刚被删）就只回 message。
  const state = await getFocusStateById(user.id);
  return apiOk({ message: '专注模式设置已保存', ...(state ?? {}) });
}
