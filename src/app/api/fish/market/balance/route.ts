import { apiOk, apiErr } from '@/lib/format';
import { getBalance } from '@/lib/fish-service';
import { requireMarketActor } from '../_auth';

// POST /api/fish/market/balance — 查余额（站外脚本用；网页走 GET /api/fish/balance）。
//
// body: { username?, password? }（有会话 cookie 时这两个可省，见 ../_auth.ts）
//
// 【为什么是 POST 而不是 GET】凭据要放在**请求体**里：GET 只能把密码塞进 URL，
// 那会原样进 nginx access log、浏览器历史、Referer —— 等于把密码写进日志文件。
// 因此这条「无状态凭据」的接口族一律 POST。
export const runtime = 'nodejs';

export async function POST(req: Request) {
  let body: unknown = {};
  try {
    const raw = await req.text();
    body = raw ? JSON.parse(raw) : {};
  } catch {
    return apiErr(400, '请求体格式错误');
  }

  // 读接口：放行只读凭据（Bearer）。转账 / 收银台一律不传这个开关。
  const actor = await requireMarketActor(req, body, { allowReadToken: true });
  if (actor instanceof Response) return actor;

  const balance = await getBalance(actor.id);
  return apiOk({ user_id: actor.id, username: actor.username, balance });
}
