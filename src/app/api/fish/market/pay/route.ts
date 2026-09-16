import { getCurrentUser, isCurrentlyBanned } from '@/lib/auth';
import { apiOk, apiErr } from '@/lib/format';
import { verifyCredentials } from '@/lib/credential-auth';
import { clientIp } from '@/lib/request-ip';
import { transferFish } from '@/lib/fish-market-service';
import { AccountServiceError } from '@/lib/account-client';

export const runtime = 'nodejs';

// POST /api/fish/market/pay — 「付款」专用接口，两个页面共用：
//   • /fish/pay     收银台（站外商户把用户送来付款）
//   • /fish/collect 扫码收款页（扫别人的收款码付款）
// 两者前端是**同一个组件**（src/app/fish/PayForm.tsx）的两个变体。
//
// body: { to_user_id, amount, note?, password, idempotency_key? }
//
// 与 /api/fish/market/transfer 的两点差别都是刻意的：
//   1. **不接受** body 里的 username/password 当登录手段 —— 付款人永远是当前会话用户。
//      否则它就退化成一个换名字的无状态转账接口，而收银台的整个价值在于
//      「是用户本人在 raricy 自己的页面上点的确认」。
//   2. 多一道 **step-up**：密码在这里不是登录凭证，是「再确认一次是你本人」。
//      校验复用 credential-auth 的同一份实现（连撞库限频桶都一样），
//      所以输错密码同样消耗登录失败预算 —— 不会成为第三条撞库通道。
export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return apiErr(401, '请先登录');
  if (isCurrentlyBanned(user)) return apiErr(403, '你已被禁言，暂时无法支付');

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

  const toUserId = typeof body.to_user_id === 'string' ? body.to_user_id.trim() : '';
  if (!toUserId) return apiErr(400, '缺少收款人');
  const amount = Number(body.amount);
  const note = typeof body.note === 'string' ? body.note : null;
  const clientIdempotencyKey =
    typeof body.idempotency_key === 'string' ? body.idempotency_key : null;

  const password = typeof body.password === 'string' ? body.password : '';
  if (!password) return apiErr(400, '请输入密码以确认支付');

  // step-up：用会话用户的用户名去走一遍标准凭据校验（同一份实现、同一对限频桶）。
  const step = await verifyCredentials(user.username, password, clientIp(req));
  if (!step.ok) return apiErr(step.status, step.message);
  // 用户名唯一 → 查到的必然是本人；钱的路径上多一道断言不亏。
  if (step.user.id !== user.id) return apiErr(401, '凭据与当前登录账号不一致');

  try {
    const res = await transferFish(user.id, toUserId, amount, note, { clientIdempotencyKey });
    if (!res.ok) return apiErr(res.code, res.message);

    return apiOk({
      message: res.duplicated
        ? `这笔支付已经完成过了（未重复扣款）`
        : `已支付 ${res.amount} 条小鱼干给 ${res.recipient.username}`,
      amount: res.amount,
      balance: res.balance,
      recipient: { id: res.recipient.id, username: res.recipient.username },
      duplicated: !!res.duplicated,
    });
  } catch (e) {
    // 远端同步失败（fail-closed，本地已补偿回滚）→ 503，用户可原样重试
    //（重试带的是同一个幂等键，不会重复扣款）。
    if (e instanceof AccountServiceError) return apiErr(503, '鱼干服务暂不可用，请稍后再试');
    console.error('[fish-market] 收银台支付异常:', e);
    return apiErr(500, '服务器开小差了，请稍后再试');
  }
}
