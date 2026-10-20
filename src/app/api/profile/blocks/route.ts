import { getCurrentUser, isCoreUser } from '@/lib/auth';
import { apiErr, apiOk } from '@/lib/format';
import { rateLimit, RULES } from '@/lib/rate-limit';
import { saveProfileBlocks } from '@/lib/profile-service';

// PUT /api/profile/blocks —— 保存整页积木布局（整页替换）
//
// 【只认会话】不认 api key / 不认 OAuth 凭据：这是「我自己的主页」，与
// /api/users/me/frame 同一档。别顺手给它开一个 requireMarketActor 那样的凭据门。
//
// 【只对 core+ 开】产品决定（2026-10）：非核心用户暂时不能布置主页，页面照常
// 可看（身份条 + 默认布局）。档位判定在页面与服务端各一次，别只在前端藏按钮。
//
// 【客户端校验不是防线】请求可以被手工构造，saveProfileBlocks 内部会再跑一遍
// normalizeBlocks + 归属/可见性校验。
export async function PUT(req: Request) {
  const user = await getCurrentUser();
  if (!user) return apiErr(401, '未登录');
  if (!isCoreUser(user)) return apiErr(403, '布置主页目前只对核心用户开放');

  const gate = rateLimit(`profile:save:${user.id}`, RULES.profileSave);
  if (!gate.allowed) return apiErr(429, '保存太频繁了，请稍后再试');

  let body: { blocks?: unknown };
  try {
    body = (await req.json()) as { blocks?: unknown };
  } catch {
    return apiErr(400, '请求体格式错误');
  }
  if (!body || !('blocks' in body)) return apiErr(400, '请提供 blocks');

  const result = await saveProfileBlocks(user.id, body.blocks);
  if (!result.ok) return apiErr(400, result.message);

  return apiOk({ count: result.count }, '主页已保存');
}
