import { prisma } from '@/lib/db';
import { nowForDb } from '@/lib/db-time';
import { hashOpaqueToken, oauthErr } from '@/lib/oauth';

// POST /api/oauth/revoke（RFC 7009）
// 只以原始 token 的持有权鉴权，不读取会话 cookie，因此可保留 CSRF 豁免。
// 站内用户/站长管理走自己的受 CSRF 保护的入口。
// 未知 token 也返回 200（RFC 7009 §2.2：不应泄露 token 是否存在）。

export async function POST(req: Request) {
  // 解析 body（form-urlencoded 或 JSON）
  let body: Record<string, unknown> = {};
  const ct = req.headers.get('content-type') || '';
  try {
    if (ct.includes('application/x-www-form-urlencoded')) {
      const text = await req.text();
      const params = new URLSearchParams(text);
      params.forEach((v, k) => {
        body[k] = v;
      });
    } else {
      const parsed = await req.json();
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return oauthErr('invalid_request', '请求体格式错误');
      body = parsed;
    }
  } catch {
    return oauthErr('invalid_request', '请求体解析失败');
  }

  // 优先 body.token，否则从 Bearer 头取
  if (body.token !== undefined && typeof body.token !== 'string') return oauthErr('invalid_request', 'token 必须是字符串');
  let raw = typeof body.token === 'string' ? body.token.trim() : '';
  if (!raw) {
    const auth = req.headers.get('authorization') || '';
    const m = /^Bearer\s+(.+)$/i.exec(auth);
    if (m) raw = m[1].trim();
  }
  if (!raw) {
    return oauthErr('invalid_request', '缺少 token');
  }

  if (raw.length > 256) return oauthErr('invalid_request', 'token 过长');
  // 原始 token 就是此操作的凭证；仅改其自身。未知、停用、过期、已吊销均幂等。
  await prisma.oAuthAccessToken.updateMany({
    where: { tokenHash: hashOpaqueToken(raw), revokedAt: null },
    data: { revokedAt: nowForDb() },
  });
  return Response.json({}, { status: 200, headers: { 'Cache-Control': 'no-store' } });
}
