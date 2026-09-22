// GET    /api/fish/webhook — 查自己的回调配置 + 最近投递记录
// PUT    /api/fish/webhook — 登记 / 更新回调地址（首次返回签名密钥，只此一次）
// DELETE /api/fish/webhook — 停用（软停：置 disabledAt，投递记录保留）
//
// 与 /api/fish/tokens 同款：**只认会话**、只能动自己的账号。
//
// 【为什么登记与换密钥都要 step-up，停用不要】同 tokens 那边的取舍：
// 签名密钥是凭证（泄露即可伪造我们发给该商户的回调），而且它活得比会话久；
// 停用是安全方向的动作，在用户最想止损的一刻加摩擦是反的。

import { getCurrentUser, isCurrentlyBanned } from '@/lib/auth';
import { apiOk, apiErr } from '@/lib/format';
import { verifyCredentials } from '@/lib/credential-auth';
import { clientIp } from '@/lib/request-ip';
import {
  getWebhookEndpoint,
  upsertWebhookEndpoint,
  disableWebhookEndpoint,
  listRecentDeliveries,
} from '@/lib/fish-webhook-service';
import { SecretBoxError } from '@/lib/secret-box';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** 校验 step-up 密码。返回 null = 通过，否则返回该回给用户的 Response。 */
async function requireStepUp(
  username: string,
  userId: string,
  password: unknown,
  req: Request
): Promise<Response | null> {
  if (typeof password !== 'string' || !password) {
    return apiErr(400, '请输入密码以确认');
  }
  // 复用 credential-auth 的同一份实现与同一对限频桶 —— 输错同样消耗登录失败预算，
  // 不会成为多出来的一条撞库通道。
  const step = await verifyCredentials(username, password, clientIp(req));
  if (!step.ok) return apiErr(step.status, step.message);
  if (step.user.id !== userId) return apiErr(401, '凭据与当前登录账号不一致');
  return null;
}

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return apiErr(401, '请先登录');

  const [endpoint, deliveries] = await Promise.all([
    getWebhookEndpoint(user.id),
    listRecentDeliveries(user.id),
  ]);

  return apiOk({
    endpoint: endpoint
      ? {
          url: endpoint.url,
          disabled: !!endpoint.disabledAt,
          disabled_at: endpoint.disabledAt?.toISOString() ?? null,
          consecutive_failures: endpoint.consecutiveFailures,
          last_success_at: endpoint.lastSuccessAt?.toISOString() ?? null,
          last_failure_at: endpoint.lastFailureAt?.toISOString() ?? null,
          created_at: endpoint.createdAt?.toISOString() ?? null,
        }
      : null,
    deliveries: deliveries.map((d) => ({
      id: d.id,
      delivery_id: d.deliveryId,
      transfer_id: d.transferId,
      event: d.event,
      status: d.status,
      attempts: d.attempts,
      last_error: d.lastError,
      last_status_code: d.lastStatusCode,
      delivered_at: d.deliveredAt?.toISOString() ?? null,
      created_at: d.createdAt?.toISOString() ?? null,
    })),
  });
}

export async function PUT(req: Request) {
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

  const stepFail = await requireStepUp(user.username, user.id, body.password, req);
  if (stepFail) return stepFail;

  const url = typeof body.url === 'string' ? body.url : '';
  // SSRF 校验发生在 upsertWebhookEndpoint 里（**而且每次投递还会再查一遍** ——
  // 商户可以把已登记的域名改指向内网，只在登记时查是拦不住的）。
  let res;
  try {
    res = await upsertWebhookEndpoint(user.id, url);
  } catch (e) {
    // 服务端加密钥匙不可用（缺 FISH_ENCRYPTION_KEY）：这是**运维要修的环境问题**，
    // 不是这次请求本身的问题 —— 给 503 而不是让它冒泡成 500「服务器开小差了」，
    // 真正的错因写进服务端日志（密钥材料绝不回给客户端）。
    if (e instanceof SecretBoxError) {
      console.warn(`[webhook] 加密钥匙不可用，登记被拒（user=${user.id}）: ${e.message}`);
      return apiErr(503, '服务端密钥未配置，请联系站长');
    }
    throw e;
  }
  if (!res.ok) return apiErr(400, res.message);

  return apiOk({
    message: res.secret
      ? '回调地址已登记。请立刻复制签名密钥 —— 它只显示这一次。'
      : '回调地址已更新（签名密钥未变）。',
    // 首次登记才有；更新地址不换密钥（否则商户写好的验签代码会突然失效）。
    secret: res.secret,
    endpoint: {
      url: res.endpoint.url,
      disabled: !!res.endpoint.disabledAt,
      consecutive_failures: res.endpoint.consecutiveFailures,
    },
  });
}

export async function DELETE() {
  const user = await getCurrentUser();
  if (!user) return apiErr(401, '请先登录');

  const changed = await disableWebhookEndpoint(user.id);
  return apiOk({
    message: changed ? '回调已停用，新转账不再通知' : '本来就没有启用中的回调',
  });
}
