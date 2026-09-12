import { getCurrentUser, isOwner } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { nowForDb } from '@/lib/db-time';
import { hashOpaqueToken, oauthErr, revokeAccessToken, validateAccessToken } from '@/lib/oauth';

// POST /api/oauth/revoke（RFC 7009）
// 鉴权（按优先级，任一通过即可吊销）：
//   1. 会话：owner 可吊销任何；普通用户可吊销自己的。
//   2. bearer token：token 持有者可吊销自己的（外部应用替用户"登出"）。
// 未知 token 也返回 200（RFC 7009 §2.2：不应泄露 token 是否存在）。

export async function POST(req: Request) {
  // 解析 body（form-urlencoded 或 JSON）
  let body: Record<string, string> = {};
  const ct = req.headers.get('content-type') || '';
  try {
    if (ct.includes('application/x-www-form-urlencoded')) {
      const text = await req.text();
      const params = new URLSearchParams(text);
      params.forEach((v, k) => {
        body[k] = v;
      });
    } else {
      body = (await req.json()) as Record<string, string>;
    }
  } catch {
    return oauthErr('invalid_request', '请求体解析失败');
  }

  // 优先 body.token，否则从 Bearer 头取
  let raw = (body.token || '').trim();
  if (!raw) {
    const auth = req.headers.get('authorization') || '';
    const m = /^Bearer\s+(.+)$/i.exec(auth);
    if (m) raw = m[1].trim();
  }
  if (!raw) {
    return oauthErr('invalid_request', '缺少 token');
  }

  const user = await getCurrentUser();
  const sessionOwner = isOwner(user);

  // 路径 1：session 鉴权
  if (user) {
    const result = await revokeAccessToken(raw, user.id, sessionOwner);
    if (result === 'forbidden') return oauthErr('invalid_token', '无权吊销该 token');
    return Response.json({}, { status: 200, headers: { 'Cache-Control': 'no-store' } });
  }

  // 路径 2：bearer 自吊销（无 session 时）
  // token 必须当前有效（validateAccessToken 校验 hash/未过期/未吊销），然后吊销。
  const validated = await validateAccessToken(raw);
  if (!validated) {
    // 未知 / 已过期 / 已吊销 —— 一律返 200 避免侧信道
    return Response.json({}, { status: 200, headers: { 'Cache-Control': 'no-store' } });
  }
  await prisma.oAuthAccessToken.update({
    where: { tokenHash: hashOpaqueToken(raw) },
    data: { revokedAt: nowForDb() },
  });
  return Response.json({}, { status: 200, headers: { 'Cache-Control': 'no-store' } });
}