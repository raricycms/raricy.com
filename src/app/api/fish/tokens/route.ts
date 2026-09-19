// GET  /api/fish/tokens — 列出**自己**的鱼干只读凭据
// POST /api/fish/tokens — 签发一张新的只读凭据（明文只回这一次）
//
// 自助口，**只认会话**：不接受 body 里的 username/password 当登录手段
//（那会把它变成一个「拿密码换长期凭据」的无状态接口，等于把长期凭据的门
//  开在了和转账同一层的暴露面上）。签发多一道 step-up（见 POST 注释）。
//
// 只能动自己的账号，没有「管理员代签」—— 站长要代吊销走 CLI（fish credential-revoke）。

import { getCurrentUser, isCurrentlyBanned } from '@/lib/auth';
import { apiOk, apiErr } from '@/lib/format';
import { verifyCredentials } from '@/lib/credential-auth';
import { clientIp } from '@/lib/request-ip';
import {
  FISH_TOKEN_LABEL_MAX,
  FISH_TOKEN_TTL_MS,
  listFishTokens,
  mintFishToken,
} from '@/lib/fish-token-service';
import { nowForDb } from '@/lib/db-time';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** 凭据行 → 对外形状。**绝不包含 tokenHash**（它不是明文，但没有理由出圈）。 */
function toTokenDTO(t: Awaited<ReturnType<typeof listFishTokens>>[number]) {
  return {
    id: t.id,
    label: t.label,
    scopes: t.scopes,
    created_at: t.createdAt?.toISOString() ?? null,
    expires_at: t.expiresAt.toISOString(),
    last_used_at: t.lastUsedAt?.toISOString() ?? null,
    revoked_at: t.revokedAt?.toISOString() ?? null,
    // 由服务端算「过期了没」：客户端时钟不可信，而且这个判断直接影响用户
    // 该不该去换一张新的。已吊销与已过期是**两回事**，页面要分开显示。
    expired: t.expiresAt.getTime() <= nowForDb().getTime(),
  };
}

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return apiErr(401, '请先登录');

  const tokens = await listFishTokens(user.id);
  return apiOk({ tokens: tokens.map(toTokenDTO) });
}

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return apiErr(401, '请先登录');
  if (isCurrentlyBanned(user)) return apiErr(403, '你已被禁言，暂时无法签发凭据');

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

  const label = typeof body.label === 'string' ? body.label : null;
  if (label && label.trim().length > FISH_TOKEN_LABEL_MAX) {
    return apiErr(400, `备注最多 ${FISH_TOKEN_LABEL_MAX} 个字`);
  }

  // step-up：密码在这里**不是登录凭证**，是「再确认一次是你本人」。
  // 复用 credential-auth 的同一份实现（连撞库限频桶都一样），所以输错同样消耗
  // 登录失败预算 —— 不会成为第四条撞库通道（另外三条见 /api/auth/login、
  // 市场无状态接口、收银台）。
  //
  // 【为什么签发要 step-up】凭据是**长期**的：它活得比会话久，改密码都不会作废它
  //（那正是它的用途）。也就是说，一次 XSS 若能静默签发一张，攻击者就拿到了
  // 一个会话失效后仍然有效的后门。多一道密码就多一道「人真的在场且知情」。
  const password = typeof body.password === 'string' ? body.password : '';
  if (!password) return apiErr(400, '请输入密码以确认签发');

  const step = await verifyCredentials(user.username, password, clientIp(req));
  if (!step.ok) return apiErr(step.status, step.message);
  if (step.user.id !== user.id) return apiErr(401, '凭据与当前登录账号不一致');

  const minted = await mintFishToken(user.id, label);

  return apiOk({
    message: '凭据已签发。请立刻复制 —— 它只显示这一次，之后无法再取回。',
    // 明文**只在这里**出现这一次。
    secret: minted.token,
    token: {
      id: minted.id,
      label: label?.trim() ? label.trim().slice(0, FISH_TOKEN_LABEL_MAX) : null,
      scopes: 'read',
      expires_at: minted.expiresAt.toISOString(),
      ttl_days: Math.round(FISH_TOKEN_TTL_MS / (24 * 60 * 60 * 1000)),
    },
  });
}
