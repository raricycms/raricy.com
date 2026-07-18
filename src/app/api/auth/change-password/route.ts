import { getCurrentUser } from '@/lib/auth';
import { changeOwnPassword } from '@/lib/user-service';
import { apiErr } from '@/lib/format';
import { SESSION_COOKIE } from '@/lib/session';
import { cookies } from 'next/headers';

// POST /api/auth/change-password — 修改本人密码（对齐 Flask POST /auth/settings/change-password）
//
// 请求体沿用原站字段名：{ current_password, new_password, confirm_password }。
// 成功后：service 已自增 session_version（使所有旧会话失效）→ 这里再清除当前会话 cookie
// （等价 Flask 的 logout_user），并返回 redirect_url 让前端 1.5s 后跳回登录页。
export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return apiErr(401, '未登录');

  let body: {
    current_password?: string;
    new_password?: string;
    confirm_password?: string;
  };
  try {
    body = await req.json();
  } catch {
    return apiErr(400, '请求体格式错误');
  }

  const result = await changeOwnPassword(
    user.id,
    body.current_password ?? '',
    body.new_password ?? '',
    body.confirm_password ?? ''
  );
  if (!result.ok) return apiErr(result.code, result.message);

  // 改密后当前会话失效：清除会话 cookie（sessionVersion 已在 service 内自增）
  const store = await cookies();
  store.delete(SESSION_COOKIE);

  return Response.json({
    code: 200,
    message: result.message,
    redirect_url: '/login',
  });
}
