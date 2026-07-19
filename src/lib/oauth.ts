// ─────────────────────────────────────────────────────────────────────────────
// oauth.ts — OAuth 2.0 Authorization Code 核心库（raricy 作为 IdP）
//
// 协议：RFC 6749 §4.1（Authorization Code Grant）。
// 范围：v1 仅 `profile` scope，第三方应用只能读取 raricy 用户的 id/username/avatar。
//
// 安全约定：
//   • 不透明 token（32 字节 base64url），DB 仅存 SHA-256 哈希作为 PK —— 不可逆，
//     即使库被盗攻击者也无法恢复原始 token。
//   • client_secret 用 werkzeug 兼容 scrypt（与 User.passwordHash 一致），自带盐，
//     不依赖 SECRET_KEY 轮换。
//   • redirect_uri 严格精确匹配（OAuth 2.0 Security BCP §4.1：无通配/前缀/子串）。
//   • 所有时间戳走 nowForDb()（UTC+8 墙上时间），与历史数据语义一致。
//   • 绝不打印原始 token/code/client_secret 到日志。
// ─────────────────────────────────────────────────────────────────────────────

import { createHash, randomBytes } from 'node:crypto';
import { prisma } from './db';
import { nowForDb } from './db-time';
import { hashPassword, verifyPassword } from './password';
import { generateShortId } from './short-id';
import type { OAuthApplication } from '@prisma/client';

// ── 常量 ─────────────────────────────────────────────────────────────────────

export const CODE_TTL_MS = 10 * 60 * 1000; // 10 分钟（RFC 6749 §4.1.2 推荐上限）
export const ACCESS_TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1000; // 90 天
export const ACCESS_TOKEN_TTL_SEC = Math.floor(ACCESS_TOKEN_TTL_MS / 1000);

export const SUPPORTED_SCOPES = ['profile'] as const;
export type Scope = (typeof SUPPORTED_SCOPES)[number];

/** RFC 6749 §5.2 标准错误码 → HTTP 状态码（除 invalid_client 用 401，其余一律 400）。 */
const OAUTH_ERROR_STATUS: Record<string, number> = {
  invalid_request: 400,
  invalid_client: 401,
  invalid_grant: 400,
  unauthorized_client: 400,
  unsupported_grant_type: 400,
  invalid_scope: 400,
  insufficient_scope: 403,
  server_error: 500,
};
export function oauthErr(error: string, description?: string) {
  const status = OAUTH_ERROR_STATUS[error] ?? 400;
  return Response.json(
    { error, error_description: description ?? '' },
    {
      status,
      headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' },
    }
  );
}

// ── 生成 / 哈希 ──────────────────────────────────────────────────────────────

/** base64url 编码（无 padding）。 */
function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function randB64url(bytes: number): string {
  return b64url(randomBytes(bytes));
}

export function generateClientId(): string {
  return randB64url(24);
}
export function generateClientSecret(): string {
  return randB64url(32);
}
export function generateAuthorizationCode(): string {
  return randB64url(32);
}
export function generateAccessToken(): string {
  return randB64url(32);
}

/** SHA-256 hex（64 字符），code/token 入库 PK 用。 */
export function hashOpaqueToken(plain: string): string {
  return createHash('sha256').update(plain, 'utf8').digest('hex');
}

// ── Redirect URI 校验 ────────────────────────────────────────────────────────

const MAX_REDIRECT_URI_LEN = 2048;

/** 解析 JSON 字符串形式的 redirect_uris 列表（应用层）。失败抛 Error 让上层 400。 */
export function parseRedirectUris(json: string): string[] {
  let arr: unknown;
  try {
    arr = JSON.parse(json);
  } catch {
    throw new Error('redirect_uris 不是合法 JSON');
  }
  if (!Array.isArray(arr)) throw new Error('redirect_uris 必须是数组');
  const out: string[] = [];
  for (const v of arr) {
    if (typeof v !== 'string') throw new Error('redirect_uri 必须是字符串');
    if (!v) continue;
    if (v.length > MAX_REDIRECT_URI_LEN) throw new Error('redirect_uri 过长');
    out.push(v);
  }
  return out;
}

/**
 * 精确字符串匹配（OAuth 2.0 Security BCP §4.1 推荐做法）。
 * 无通配、无前缀、无子串：避免攻击者注册 "https://app.example.com" 后挟持
 * "https://app.example.com.attacker.com/"。loopback / http 也走同一条规则。
 */
export function isValidRedirectUri(candidate: string, allowed: string[]): boolean {
  if (!candidate || candidate.length > MAX_REDIRECT_URI_LEN) return false;
  return allowed.includes(candidate);
}

// ── Scope 工具 ───────────────────────────────────────────────────────────────

/** 规范化 scope 字符串：去重、过滤未注册、保持首次出现顺序。空集合返回 []。 */
export function normalizeScopes(input: string | null | undefined): Scope[] {
  if (!input) return [];
  const set = new Set<string>(SUPPORTED_SCOPES);
  const seen = new Set<Scope>();
  const out: Scope[] = [];
  for (const tok of input.split(/\s+/).filter(Boolean)) {
    if (!set.has(tok)) continue;
    if (seen.has(tok as Scope)) continue;
    seen.add(tok as Scope);
    out.push(tok as Scope);
  }
  return out;
}

export function scopesToString(scopes: Scope[]): string {
  return scopes.join(' ');
}

export function parseStoredScopes(json: string): Scope[] {
  return normalizeScopes(json);
}

export function hasScope(scopes: Scope[], required: Scope): boolean {
  return scopes.includes(required);
}

// ── 客户端鉴权（HTTP Basic 优先，body 字段兜底） ─────────────────────────────

export interface ClientAuthOk {
  ok: true;
  app: OAuthApplication;
}
export interface ClientAuthFail {
  ok: false;
  reason: 'missing_credentials' | 'invalid_client' | 'disabled';
}
export type ClientAuthResult = ClientAuthOk | ClientAuthFail;

/** 从 Authorization 头解析 Basic auth（RFC 6749 §2.3.1）。 */
function parseBasicAuth(headerValue: string | null): { clientId: string; clientSecret: string } | null {
  if (!headerValue) return null;
  const m = /^Basic\s+(.+)$/i.exec(headerValue);
  if (!m) return null;
  let decoded: string;
  try {
    decoded = Buffer.from(m[1], 'base64').toString('utf8');
  } catch {
    return null;
  }
  const idx = decoded.indexOf(':');
  if (idx < 0) return null;
  return {
    clientId: decoded.slice(0, idx),
    clientSecret: decoded.slice(idx + 1),
  };
}

/**
 * 鉴权流程：
 *   1. 先尝试 HTTP Basic（RFC 6749 §2.3.1 推荐做法，对密码字段也走 TLS）。
 *   2. 兜底 body 内的 client_id / client_secret（仅用于不便加 header 的客户端）。
 *   3. 校验 disabled_at：禁用应用一律拒。
 *   4. verifyPassword(scrypt) 验 client_secret。
 */
export async function authenticateClient(
  headerAuth: string | null,
  bodyClientId?: string | null,
  bodyClientSecret?: string | null
): Promise<ClientAuthResult> {
  const basic = parseBasicAuth(headerAuth);
  const clientId = basic?.clientId ?? bodyClientId ?? '';
  const clientSecret = basic?.clientSecret ?? bodyClientSecret ?? '';
  if (!clientId || !clientSecret) return { ok: false, reason: 'missing_credentials' };

  const app = await prisma.oAuthApplication.findUnique({ where: { clientId } });
  if (!app) return { ok: false, reason: 'invalid_client' };
  if (app.disabledAt) return { ok: false, reason: 'disabled' };

  const ok = await verifyPassword(clientSecret, app.clientSecretHash);
  if (!ok) return { ok: false, reason: 'invalid_client' };

  return { ok: true, app };
}

// ── 授权码生命周期 ────────────────────────────────────────────────────────────

export interface MintedCode {
  code: string; // 明文，仅此刻可见
  expiresAt: Date;
}

export async function createAuthorizationCode(
  applicationId: string,
  userId: string,
  redirectUri: string,
  scopes: Scope[]
): Promise<MintedCode> {
  const code = generateAuthorizationCode();
  const codeHash = hashOpaqueToken(code);
  const now = nowForDb();
  const expiresAt = new Date(now.getTime() + CODE_TTL_MS);
  await prisma.oAuthAuthorizationCode.create({
    data: {
      codeHash,
      applicationId,
      userId,
      redirectUri,
      scopes: scopesToString(scopes),
      expiresAt,
      createdAt: now,
    },
  });
  return { code, expiresAt };
}

export type ConsumeResult =
  | { ok: true; userId: string; scopes: Scope[] }
  | { ok: false; error: 'invalid' | 'expired' | 'already_used' | 'redirect_mismatch' };

/**
 * 单次消费：原子 `update where { codeHash, usedAt: null }`，
 * 在 SQLite 单写者模式下天然串行化，恰好一次成功。
 * 不匹配时再查一次原行以区分「不存在」/「已用」/「过期」/「redirect_uri 不一致」。
 */
export async function consumeAuthorizationCode(
  code: string,
  applicationId: string,
  redirectUri: string
): Promise<ConsumeResult> {
  const codeHash = hashOpaqueToken(code);
  const now = nowForDb();
  const updateRes = await prisma.oAuthAuthorizationCode.updateMany({
    where: {
      codeHash,
      applicationId,
      usedAt: null,
      expiresAt: { gt: now },
    },
    data: { usedAt: now },
  });
  if (updateRes.count === 1) {
    const row = await prisma.oAuthAuthorizationCode.findUnique({ where: { codeHash } });
    if (!row) return { ok: false, error: 'invalid' };
    return {
      ok: true,
      userId: row.userId,
      scopes: parseStoredScopes(row.scopes),
    };
  }
  // 未匹配：定位原因（用于给客户端更明确的错误）
  const row = await prisma.oAuthAuthorizationCode.findUnique({ where: { codeHash } });
  if (!row) return { ok: false, error: 'invalid' };
  if (row.usedAt) return { ok: false, error: 'already_used' };
  if (row.expiresAt <= now) return { ok: false, error: 'expired' };
  if (row.applicationId !== applicationId) return { ok: false, error: 'invalid' };
  if (row.redirectUri !== redirectUri) return { ok: false, error: 'redirect_mismatch' };
  return { ok: false, error: 'invalid' };
}

// ── Access Token 生命周期 ────────────────────────────────────────────────────

export interface MintedToken {
  token: string;
  expiresIn: number; // 秒
}

export async function createAccessToken(
  applicationId: string,
  userId: string,
  scopes: Scope[]
): Promise<MintedToken> {
  const token = generateAccessToken();
  const tokenHash = hashOpaqueToken(token);
  const now = nowForDb();
  const expiresAt = new Date(now.getTime() + ACCESS_TOKEN_TTL_MS);
  await prisma.oAuthAccessToken.create({
    data: {
      tokenHash,
      applicationId,
      userId,
      scopes: scopesToString(scopes),
      expiresAt,
      createdAt: now,
    },
  });
  return { token, expiresIn: ACCESS_TOKEN_TTL_SEC };
}

export interface ValidatedToken {
  applicationId: string;
  userId: string;
  scopes: Scope[];
}

export async function validateAccessToken(rawToken: string): Promise<ValidatedToken | null> {
  if (!rawToken || rawToken.length > 256) return null;
  const tokenHash = hashOpaqueToken(rawToken);
  const row = await prisma.oAuthAccessToken.findUnique({ where: { tokenHash } });
  if (!row) return null;
  if (row.revokedAt) return null;
  if (row.expiresAt <= nowForDb()) return null;
  return {
    applicationId: row.applicationId,
    userId: row.userId,
    scopes: parseStoredScopes(row.scopes),
  };
}

/** 异步写 lastUsedAt，fire-and-forget，失败也不影响主流程。 */
export async function touchAccessTokenUsage(rawToken: string): Promise<void> {
  try {
    const tokenHash = hashOpaqueToken(rawToken);
    await prisma.oAuthAccessToken.update({
      where: { tokenHash },
      data: { lastUsedAt: nowForDb() },
      select: { tokenHash: true },
    });
  } catch {
    // 静默：用法计数不应阻断 userinfo 响应
  }
}

// ── 吊销 ─────────────────────────────────────────────────────────────────────

export type RevokeResult = 'ok' | 'not_found' | 'forbidden';

export async function revokeAccessToken(
  rawToken: string,
  requesterUserId: string,
  requesterIsOwner: boolean
): Promise<RevokeResult> {
  if (!rawToken) return 'not_found';
  const tokenHash = hashOpaqueToken(rawToken);
  const row = await prisma.oAuthAccessToken.findUnique({
    where: { tokenHash },
    select: { tokenHash: true, userId: true, revokedAt: true },
  });
  if (!row) return 'not_found';
  if (!requesterIsOwner && row.userId !== requesterUserId) return 'forbidden';
  if (row.revokedAt) return 'ok'; // 幂等：已吊销视作成功
  await prisma.oAuthAccessToken.update({
    where: { tokenHash },
    data: { revokedAt: nowForDb() },
    select: { tokenHash: true },
  });
  return 'ok';
}

// ── 应用 CRUD（owner 路径） ───────────────────────────────────────────────────

export interface CreateAppInput {
  name: string;
  description?: string | null;
  homepageUrl?: string | null;
  redirectUris: string[];
}

export interface CreatedApp {
  application: OAuthApplication;
  clientId: string;
  clientSecret: string; // 仅此次返回，调用方负责展示给 owner
}

export async function createOAuthApplication(
  input: CreateAppInput,
  createdById: string
): Promise<CreatedApp> {
  if (!input.name || !input.name.trim()) throw new Error('name 不能为空');
  if (!Array.isArray(input.redirectUris) || input.redirectUris.length === 0) {
    throw new Error('至少需要一个 redirect_uri');
  }
  for (const u of input.redirectUris) {
    if (typeof u !== 'string' || !u) throw new Error('redirect_uri 必须是非空字符串');
    if (u.length > MAX_REDIRECT_URI_LEN) throw new Error('redirect_uri 过长');
  }

  const clientId = generateClientId();
  const clientSecret = generateClientSecret();
  const clientSecretHash = await hashPassword(clientSecret);

  const id = generateShortId(12);
  const now = nowForDb();

  const application = await prisma.oAuthApplication.create({
    data: {
      id,
      clientId,
      clientSecretHash,
      name: input.name.trim(),
      description: input.description?.trim() || null,
      homepageUrl: input.homepageUrl?.trim() || null,
      redirectUris: JSON.stringify(input.redirectUris),
      createdById,
      createdAt: now,
    },
  });
  return { application, clientId, clientSecret };
}

export async function listOAuthApplications(): Promise<OAuthApplication[]> {
  return prisma.oAuthApplication.findMany({ orderBy: { createdAt: 'desc' } });
}

export interface UpdateAppPatch {
  name?: string;
  description?: string | null;
  homepageUrl?: string | null;
  redirectUris?: string[];
  disabled?: boolean;
}

export async function updateOAuthApplication(
  id: string,
  patch: UpdateAppPatch
): Promise<OAuthApplication> {
  const data: Record<string, unknown> = {};
  if (patch.name !== undefined) {
    if (!patch.name.trim()) throw new Error('name 不能为空');
    data.name = patch.name.trim();
  }
  if (patch.description !== undefined) data.description = patch.description?.trim() || null;
  if (patch.homepageUrl !== undefined) data.homepageUrl = patch.homepageUrl?.trim() || null;
  if (patch.redirectUris !== undefined) {
    if (!Array.isArray(patch.redirectUris) || patch.redirectUris.length === 0) {
      throw new Error('至少需要一个 redirect_uri');
    }
    for (const u of patch.redirectUris) {
      if (typeof u !== 'string' || !u) throw new Error('redirect_uri 必须是非空字符串');
    }
    data.redirectUris = JSON.stringify(patch.redirectUris);
  }
  if (patch.disabled !== undefined) {
    data.disabledAt = patch.disabled ? nowForDb() : null;
  }
  return prisma.oAuthApplication.update({ where: { id }, data });
}

export async function disableOAuthApplication(id: string): Promise<OAuthApplication> {
  return prisma.oAuthApplication.update({
    where: { id },
    data: { disabledAt: nowForDb() },
  });
}

export async function enableOAuthApplication(id: string): Promise<OAuthApplication> {
  return prisma.oAuthApplication.update({
    where: { id },
    data: { disabledAt: null },
  });
}

/** 用 clientId 或主 id 任一查找（CLI 友好）。 */
export async function findApplication(idOrClientId: string): Promise<OAuthApplication | null> {
  return prisma.oAuthApplication.findFirst({
    where: { OR: [{ id: idOrClientId }, { clientId: idOrClientId }] },
  });
}

// ── 用户连接管理（settings 页用） ───────────────────────────────────────────

export interface UserConnection {
  tokenId: string; // = tokenHash（解除绑定时 DELETE /api/oauth/connections/[id]）
  applicationId: string;
  applicationName: string;
  applicationHomepageUrl: string | null;
  scopes: Scope[];
  createdAt: Date;
  expiresAt: Date;
}

export async function listUserConnections(userId: string): Promise<UserConnection[]> {
  const now = nowForDb();
  const rows = await prisma.oAuthAccessToken.findMany({
    where: {
      userId,
      revokedAt: null,
      expiresAt: { gt: now },
    },
    include: {
      application: { select: { id: true, name: true, homepageUrl: true, disabledAt: true } },
    },
    orderBy: { createdAt: 'desc' },
  });
  return rows
    .filter((r) => r.application.disabledAt == null) // 禁用应用的不展示
    .map((r) => ({
      tokenId: r.tokenHash,
      applicationId: r.application.id,
      applicationName: r.application.name,
      applicationHomepageUrl: r.application.homepageUrl,
      scopes: parseStoredScopes(r.scopes),
      createdAt: r.createdAt ?? now,
      expiresAt: r.expiresAt,
    }));
}

export async function revokeOwnTokenByHash(tokenHash: string, userId: string): Promise<boolean> {
  if (!tokenHash || tokenHash.length !== 64) return false;
  const row = await prisma.oAuthAccessToken.findUnique({
    where: { tokenHash },
    select: { userId: true, revokedAt: true },
  });
  if (!row || row.userId !== userId) return false;
  if (row.revokedAt) return true; // 幂等
  await prisma.oAuthAccessToken.update({
    where: { tokenHash },
    data: { revokedAt: nowForDb() },
    select: { tokenHash: true },
  });
  return true;
}

// ── siteOrigin：解析 SITE_URL / ALLOWED_ORIGINS ──────────────────────────────

/**
 * 给 userinfo 拼绝对 avatar_url 用。优先 SITE_URL，回退 ALLOWED_ORIGINS 第一项。
 * 解析失败 → console.warn + 返回 ''（让 avatar_url 退化为相对路径，dev 凑合能跑）。
 */
export function siteOrigin(): string {
  const fromSite = (process.env.SITE_URL || '').trim().replace(/\/+$/, '');
  if (fromSite) {
    try {
      return new URL(fromSite).origin;
    } catch {
      console.warn('[oauth] SITE_URL 不是合法 URL：', process.env.SITE_URL);
    }
  }
  const allowed = (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)[0];
  if (allowed) {
    try {
      return new URL(allowed.startsWith('http') ? allowed : `https://${allowed}`).origin;
    } catch {
      /* fallthrough */
    }
  }
  console.warn('[oauth] SITE_URL 与 ALLOWED_ORIGINS 均未配置，avatar_url 将退化为相对路径');
  return '';
}