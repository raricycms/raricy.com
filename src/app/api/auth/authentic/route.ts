import { getCurrentUser } from '@/lib/auth';
import { verifyInviteAndUpgrade } from '@/lib/user-service';
import { apiErr } from '@/lib/format';

// POST /api/auth/authentic — 邀请码验证 + 角色升级（对齐 Flask POST /auth/authentic）
//
// 需登录。请求体沿用原站字段名：{ authentic_code }。
// 校验通过 → 标记邀请码已用 + 普通用户升级为核心用户，返回 { code:200, message:'验证成功' }。
export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return apiErr(401, '未登录');

  let body: { authentic_code?: string };
  try {
    body = await req.json();
  } catch {
    return apiErr(400, '请求体格式错误');
  }

  const code = (body.authentic_code ?? '').trim();
  if (!code) return apiErr(400, '缺少必要参数');

  const result = await verifyInviteAndUpgrade(user.id, code);
  if (!result.ok) return apiErr(result.code, result.message);

  return Response.json({ code: 200, message: result.message });
}
