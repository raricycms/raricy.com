import { apiErr } from '@/lib/format';
import { rateLimit } from '@/lib/rate-limit';
import {
  authenticateClient,
  consumeAuthorizationCode,
  createAccessToken,
  oauthErr,
  parseRedirectUris,
  scopesToString,
} from '@/lib/oauth';

// POST /api/oauth/token
// RFC 6749 §4.1.3 + §4.2：code → access_token。
// 鉴权走 HTTP Basic（优先，§2.3.1） 或 body 内 client_secret。body 可为
// application/x-www-form-urlencoded 或 application/json。
//
// 关键安全约束：
//   • redirect_uri 必须与授权时**完全一致**（防 code 截获重定向）。
//   • consumeAuthorizationCode 内部用原子 update 保证恰好一次成功。
//   • CSRF 中间件已豁免本路径（外部服务端主机不在 ALLOWED_ORIGINS）。

export async function POST(req: Request) {
  // 1. 解析 body（容错：form-urlencoded 与 JSON 都接受）
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

  // 2. 客户端鉴权（HTTP Basic 优先）
  const authRes = await authenticateClient(
    req.headers.get('authorization'),
    body.client_id ?? null,
    body.client_secret ?? null
  );
  if (!authRes.ok) {
    return oauthErr('invalid_client', '客户端鉴权失败');
  }
  const app = authRes.app;

  // 限频：每 clientId 每分钟 60 次
  const rl = rateLimit(`oauth:token:${app.clientId}`, {
    limit: 60,
    windowMs: 60 * 1000,
  });
  if (!rl.allowed) return oauthErr('invalid_request', '请求过于频繁，请稍后再试');

  // 3. grant_type 校验（v1 仅 authorization_code）
  const grantType = body.grant_type;
  if (grantType !== 'authorization_code') {
    return oauthErr('unsupported_grant_type', 'v1 仅支持 authorization_code');
  }

  // 4. 必备字段
  const code = body.code;
  const redirectUri = body.redirect_uri;
  if (!code || !redirectUri) {
    return oauthErr('invalid_request', '缺少 code 或 redirect_uri');
  }

  // 5. redirect_uri 必须在注册列表内
  let allowed: string[];
  try {
    allowed = parseRedirectUris(app.redirectUris);
  } catch {
    return oauthErr('server_error', '应用 redirect_uris 配置损坏');
  }
  if (!allowed.includes(redirectUri)) {
    return oauthErr('invalid_grant', 'redirect_uri 未注册');
  }

  // 6. 单次消费 code
  const consume = await consumeAuthorizationCode(code, app.id, redirectUri);
  if (!consume.ok) {
    const msg =
      consume.error === 'already_used'
        ? '授权码已被使用'
        : consume.error === 'expired'
          ? '授权码已过期'
          : consume.error === 'redirect_mismatch'
            ? 'redirect_uri 与授权时不匹配'
            : '授权码无效';
    return oauthErr('invalid_grant', msg);
  }

  // 7. 签发 access_token
  const minted = await createAccessToken(app.id, consume.userId, consume.scopes);

  // 8. 响应（RFC 6749 §5.1）
  return Response.json(
    {
      access_token: minted.token,
      token_type: 'Bearer',
      expires_in: minted.expiresIn,
      scope: scopesToString(consume.scopes),
    },
    {
      headers: {
        'Cache-Control': 'no-store',
        Pragma: 'no-cache',
      },
    }
  );
}