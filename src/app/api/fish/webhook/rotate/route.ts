// POST /api/fish/webhook/rotate — 换一把签名密钥（旧密钥立即失效）
//
// 独立一条路由而不是 PUT /api/fish/webhook 的一个参数：换密钥与改地址是两件事，
// 而「改地址顺带把密钥也换了」会让商户已经写好的验签代码在某次无关的改动后突然失效。
//
// 要 step-up：新密钥同样是凭证。明文只回这一次。

import { getCurrentUser, isCurrentlyBanned } from '@/lib/auth';
import { apiOk, apiErr } from '@/lib/format';
import { verifyCredentials } from '@/lib/credential-auth';
import { clientIp } from '@/lib/request-ip';
import { rotateWebhookSecret } from '@/lib/fish-webhook-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return apiErr(401, '请先登录');
  if (isCurrentlyBanned(user)) return apiErr(403, '你已被禁言，暂时无法配置回调');

  let body: Record<string, unknown>;
  try {
    const parsed = await req.json();
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return apiErr(400, '无效的请求');
    }
    body = parsed as Record<string, unknown>;
  } catch {
    return apiErr(400, '请求体格式错误');
  }

  const password = typeof body.password === 'string' ? body.password : '';
  if (!password) return apiErr(400, '请输入密码以确认');

  const step = await verifyCredentials(user.username, password, clientIp(req));
  if (!step.ok) return apiErr(step.status, step.message);
  if (step.user.id !== user.id) return apiErr(401, '凭据与当前登录账号不一致');

  const res = await rotateWebhookSecret(user.id);
  if (!res.ok) return apiErr(400, res.message);

  return apiOk({
    message: '签名密钥已更换。请立刻复制 —— 它只显示这一次，旧密钥立即失效。',
    secret: res.secret,
  });
}
