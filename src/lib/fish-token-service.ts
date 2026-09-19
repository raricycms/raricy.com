// ─────────────────────────────────────────────────────────────────────────────
// fish-token-service.ts — 鱼干**只读**凭据的签发 / 校验 / 吊销
//
// 用途：站外机器人 / 银行拿它查余额与流水（`POST /api/fish/market/balance` 与
// `.../transactions`），**查不了钱也动不了钱**。存在的理由见
// prisma/migrations/15_fish_api_tokens 头部（一句话：在此之前凭据就是账号密码，
// 既能查也能转，而且没法单独吊销）。
//
// 【为什么不是会话】它是**长期**凭据，与 30 天的 session cookie 是两条命：
//   · 会话靠 `User.sessionVersion` 失效（改密 / 禁言 / 强制下线递增版本号）；
//   · 本凭据靠自己的 `revokedAt`，**改密码不会作废它**。
// 这是刻意的：机器人不该因为用户改了密码就集体停摆。反过来，用户禁言/封号时
// 它**必须**立刻失效 —— 所以鉴权路径每次都实时查 `isCurrentlyBanned`，见 _auth.ts。
//
// 【令牌形状对齐 OAuth】复用 oauth.ts 的 generateAccessToken（32 字节随机 →
// base64url）与 hashOpaqueToken（sha256 hex）。库里只存哈希：库泄露拿不到可用的
// 凭据。明文只在签发那一次返回，之后**不可恢复** —— 与 OAuth 的 client_secret 同款。
//
// 【到期】expires_at NOT NULL，本模块不提供永不过期。默认 365 天：比 OAuth 的
// 90 天长（读取凭据的风险等级不同，且它可单独吊销），但**仍然会到期** ——
// 一张永不过期的读取凭据是典型的「设好就忘」。
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from './db';
import { nowForDb } from './db-time';
import { generateAccessToken, hashOpaqueToken } from './oauth';

/** 默认有效期 365 天。 */
export const FISH_TOKEN_TTL_MS = 365 * 24 * 60 * 60 * 1000;

/** 当前只发放 read。加 write/transfer 之前先读迁移头部的警告。 */
export const FISH_TOKEN_SCOPES = ['read'] as const;
export type FishTokenScope = (typeof FISH_TOKEN_SCOPES)[number];

/** 自助页与 CLI 的 label 上限（纯展示字段，防刷屏）。 */
export const FISH_TOKEN_LABEL_MAX = 30;

export interface FishTokenSummary {
  id: number;
  label: string | null;
  scopes: string;
  createdAt: Date | null;
  expiresAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
}

export interface MintedFishToken {
  id: number;
  /** 明文 —— **只在这里出现这一次**，不落库、不进日志。 */
  token: string;
  expiresAt: Date;
}

/**
 * 签发一张只读凭据。返回的 `token` 是明文，调用方必须当场交给用户，
 * 之后再也取不回来（库里只有 sha256）。
 */
export async function mintFishToken(userId: string, label?: string | null): Promise<MintedFishToken> {
  const token = generateAccessToken();
  const now = nowForDb();
  const expiresAt = new Date(now.getTime() + FISH_TOKEN_TTL_MS);
  const cleanLabel = (label ?? '').trim().slice(0, FISH_TOKEN_LABEL_MAX) || null;

  const row = await prisma.fishApiToken.create({
    data: {
      tokenHash: hashOpaqueToken(token),
      userId,
      label: cleanLabel,
      scopes: FISH_TOKEN_SCOPES.join(' '),
      expiresAt,
      createdAt: now,
    },
    select: { id: true },
  });

  return { id: row.id, token, expiresAt };
}

/**
 * 列出某用户的凭据。**绝不返回 tokenHash** —— 那虽然不是明文，但它是库里的
 * 唯一标识，没有理由出现在响应或页面上（吊销走 id）。
 */
export async function listFishTokens(userId: string): Promise<FishTokenSummary[]> {
  const rows = await prisma.fishApiToken.findMany({
    where: { userId },
    orderBy: { id: 'desc' },
    select: {
      id: true,
      label: true,
      scopes: true,
      createdAt: true,
      expiresAt: true,
      lastUsedAt: true,
      revokedAt: true,
    },
  });
  return rows;
}

export type RevokeResult = 'ok' | 'not_found' | 'forbidden';

/**
 * 吊销一张凭据。**幂等**：已吊销的再吊销仍然是 `ok`（同 oauth.revokeAccessToken）。
 * 只能吊销自己的 —— 传入别人的 id 返回 `forbidden` 而不是 `not_found`，
 * 免得把「这张凭据存在但不属于你」伪装成「不存在」（那会让自助页误报成功）。
 */
export async function revokeFishToken(
  requesterUserId: string,
  id: number,
  opts?: { isOwner?: boolean }
): Promise<RevokeResult> {
  const row = await prisma.fishApiToken.findUnique({
    where: { id },
    select: { userId: true, revokedAt: true },
  });
  if (!row) return 'not_found';
  // 站长可以代吊销（机器人失控 / 用户不配合时唯一的手段），普通用户只能动自己的。
  if (row.userId !== requesterUserId && !opts?.isOwner) return 'forbidden';
  if (row.revokedAt) return 'ok';

  await prisma.fishApiToken.update({
    where: { id },
    data: { revokedAt: nowForDb() },
  });
  return 'ok';
}

/** 吊销某用户的全部有效凭据。改密 / 怀疑泄露时的一键止血。 */
export async function revokeAllFishTokens(userId: string): Promise<number> {
  const res = await prisma.fishApiToken.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: nowForDb() },
  });
  return res.count;
}

/**
 * 校验明文令牌 → 返回持有者。无效一律返回 null（不区分「不存在 / 已吊销 /
 * 已过期」—— 对调用方而言三者都只是「这串不能用」，分开报只会给探测者递信息）。
 *
 * ⚠️ 这里**每次都查库**，没有缓存。吊销因此立即生效 —— 缓存会让「已吊销的凭据
 * 还能再用一会儿」，而那正是吊销这个功能存在的意义。
 */
export async function validateFishToken(raw: string): Promise<{ userId: string } | null> {
  if (!raw) return null;
  const row = await prisma.fishApiToken.findUnique({
    where: { tokenHash: hashOpaqueToken(raw) },
    select: { id: true, userId: true, revokedAt: true, expiresAt: true, scopes: true },
  });
  if (!row) return null;
  if (row.revokedAt) return null;
  if (!row.scopes.split(/\s+/).includes('read')) return null;
  // 时间比较用 nowForDb() —— 本库时间戳是「UTC+8 墙上时间贴 Z」，
  // 与真实时钟混用会让有效期整体偏 8 小时（src/lib/db-time.ts）。
  if (row.expiresAt.getTime() <= nowForDb().getTime()) return null;
  return { userId: row.userId };
}

/**
 * 记一次使用时间。**刻意不 await**（调用方写 `void touch…`）：这是纯统计，
 * 失败不该影响这次请求，更不该让读接口因为一次写失败而 500。
 */
export async function touchFishTokenUsage(raw: string): Promise<void> {
  try {
    await prisma.fishApiToken.updateMany({
      where: { tokenHash: hashOpaqueToken(raw) },
      data: { lastUsedAt: nowForDb() },
    });
  } catch {
    /* 尽力而为 */
  }
}
