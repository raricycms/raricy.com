// fish-token-service.ts —— 鱼干只读凭据的签发 / 校验 / 吊销。
//
// 【这一层为什么要单独测】凭据的**全部安全属性**都在这里：只存哈希、能单独吊销、
// 到期即失效、只能动自己的。路由层只是把它接到 HTTP 上。所以用例集中在
// 「什么情况下 validateFishToken 返回 null」——那一条返回 null 的边界就是权限边界。
//
// 【DB】真实 SQLite（tests/.tmp/test-*），不 mock。

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resetDb, makeUser, prisma } from '../helpers/db';
import {
  mintFishToken,
  listFishTokens,
  revokeFishToken,
  revokeAllFishTokens,
  validateFishToken,
  touchFishTokenUsage,
  FISH_TOKEN_LABEL_MAX,
  FISH_TOKEN_TTL_MS,
} from '@/lib/fish-token-service';
import { hashOpaqueToken } from '@/lib/oauth';
import { nowForDb } from '@/lib/db-time';

beforeEach(async () => {
  await resetDb();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('签发与校验', () => {
  it('签发 → 校验，拿回持有者 id', async () => {
    const u = await makeUser();
    const minted = await mintFishToken(u.id, '对账机器人');

    expect(minted.token).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    const got = await validateFishToken(minted.token);
    expect(got).toEqual({ userId: u.id });
  });

  it('★ 库里只存 sha256，明文不落库', async () => {
    const u = await makeUser();
    const minted = await mintFishToken(u.id);

    const row = await prisma.fishApiToken.findFirstOrThrow();
    expect(row.tokenHash).toBe(hashOpaqueToken(minted.token));
    expect(row.tokenHash).not.toBe(minted.token);
    // 整行序列化后也不该出现明文
    expect(JSON.stringify(row)).not.toContain(minted.token);
  });

  it('两次签发拿到不同的令牌（32 字节随机，不是同一串）', async () => {
    const u = await makeUser();
    const a = await mintFishToken(u.id);
    const b = await mintFishToken(u.id);
    expect(a.token).not.toBe(b.token);
  });

  it('到期时间 = 现在 + 365 天，且**必填**（本模块不提供永不过期）', async () => {
    const u = await makeUser();
    const before = nowForDb().getTime();
    const minted = await mintFishToken(u.id);
    const delta = minted.expiresAt.getTime() - before;
    // 允许几秒误差
    expect(Math.abs(delta - FISH_TOKEN_TTL_MS)).toBeLessThan(5000);
  });

  it('超长 label 被截断而不是报错（纯展示字段，不值得 400）', async () => {
    const u = await makeUser();
    await mintFishToken(u.id, 'x'.repeat(200));
    const [row] = await listFishTokens(u.id);
    expect(row.label).toHaveLength(FISH_TOKEN_LABEL_MAX);
  });

  it('空白 label 存成 null，不是空串', async () => {
    const u = await makeUser();
    await mintFishToken(u.id, '   ');
    const [row] = await listFishTokens(u.id);
    expect(row.label).toBeNull();
  });
});

describe('★ 校验的边界 —— 每一条 null 都是一道权限边界', () => {
  it('不存在的令牌 → null', async () => {
    await makeUser();
    expect(await validateFishToken('definitely-not-a-real-token')).toBeNull();
  });

  it('空串 / 空值 → null（不查库）', async () => {
    expect(await validateFishToken('')).toBeNull();
  });

  it('已吊销 → null', async () => {
    const u = await makeUser();
    const minted = await mintFishToken(u.id);
    expect(await validateFishToken(minted.token)).not.toBeNull();

    await revokeFishToken(u.id, minted.id);
    expect(await validateFishToken(minted.token), '吊销必须立即生效').toBeNull();
  });

  it('已过期 → null', async () => {
    const u = await makeUser();
    const minted = await mintFishToken(u.id);
    // 直接把到期时间推到过去（不发真实时间旅行）
    await prisma.fishApiToken.update({
      where: { id: minted.id },
      data: { expiresAt: new Date(nowForDb().getTime() - 1000) },
    });
    expect(await validateFishToken(minted.token)).toBeNull();
  });

  it('刚好到期的那一刻算过期（用 <= 判，不留「等于」的灰区）', async () => {
    const u = await makeUser();
    const minted = await mintFishToken(u.id);
    const now = nowForDb();
    await prisma.fishApiToken.update({
      where: { id: minted.id },
      data: { expiresAt: now },
    });
    expect(await validateFishToken(minted.token)).toBeNull();
  });

  it('scopes 里没有 read → null（将来若加了别的 scope，这条挡住误放行）', async () => {
    const u = await makeUser();
    const minted = await mintFishToken(u.id);
    await prisma.fishApiToken.update({
      where: { id: minted.id },
      data: { scopes: 'profile' },
    });
    expect(await validateFishToken(minted.token)).toBeNull();
  });

  it('★ 吊销后**不能**靠重新签发同一个明文复活（哈希唯一，明文不可再造）', async () => {
    const u = await makeUser();
    const minted = await mintFishToken(u.id);
    await revokeFishToken(u.id, minted.id);
    // 再签一张新的，明文必然不同、旧令牌仍然不可用
    const again = await mintFishToken(u.id);
    expect(again.token).not.toBe(minted.token);
    expect(await validateFishToken(minted.token)).toBeNull();
    expect(await validateFishToken(again.token)).not.toBeNull();
  });
});

describe('吊销的所有权', () => {
  it('吊销自己的 → ok', async () => {
    const u = await makeUser();
    const minted = await mintFishToken(u.id);
    expect(await revokeFishToken(u.id, minted.id)).toBe('ok');
  });

  it('★ 吊销别人的 → forbidden（不是 not_found）', async () => {
    // 分开报是刻意的：报 not_found 会让攻击者以为「这个 id 不存在」，
    // 而自助页会把 forbidden 显示成「不能吊销别人的凭据」，用户看得懂。
    const owner = await makeUser();
    const other = await makeUser();
    const minted = await mintFishToken(owner.id);

    expect(await revokeFishToken(other.id, minted.id)).toBe('forbidden');
    // 而且**真的没被吊销**
    expect(await validateFishToken(minted.token)).not.toBeNull();
  });

  it('站长可以代吊销（isOwner）—— 失控机器人时唯一的手段', async () => {
    const owner = await makeUser();
    const other = await makeUser();
    const minted = await mintFishToken(other.id);

    expect(await revokeFishToken(owner.id, minted.id, { isOwner: true })).toBe('ok');
    expect(await validateFishToken(minted.token)).toBeNull();
  });

  it('不存在的 id → not_found', async () => {
    const u = await makeUser();
    expect(await revokeFishToken(u.id, 999999)).toBe('not_found');
  });

  it('重复吊销是幂等的 → 仍是 ok', async () => {
    const u = await makeUser();
    const minted = await mintFishToken(u.id);
    expect(await revokeFishToken(u.id, minted.id)).toBe('ok');
    expect(await revokeFishToken(u.id, minted.id)).toBe('ok');
  });

  it('revokeAllFishTokens 只吊销该用户的，且只数「确实从有效变无效」的那些', async () => {
    const a = await makeUser();
    const b = await makeUser();
    const a1 = await mintFishToken(a.id);
    const a2 = await mintFishToken(a.id);
    const b1 = await mintFishToken(b.id);
    await revokeFishToken(a.id, a1.id); // 先吊销一张

    expect(await revokeAllFishTokens(a.id)).toBe(1); // 只剩 a2 有效
    expect(await validateFishToken(a2.token)).toBeNull();
    expect(await validateFishToken(b1.token), '别人的不受影响').not.toBeNull();
  });
});

describe('列表与使用时间', () => {
  it('列表**不返回 tokenHash**（那不是明文，但没有任何理由出圈）', async () => {
    const u = await makeUser();
    await mintFishToken(u.id, 'a');
    const rows = await listFishTokens(u.id);
    expect(rows).toHaveLength(1);
    expect(Object.keys(rows[0])).not.toContain('tokenHash');
  });

  it('只列自己的', async () => {
    const a = await makeUser();
    const b = await makeUser();
    await mintFishToken(a.id);
    await mintFishToken(b.id);
    await mintFishToken(b.id);
    expect(await listFishTokens(a.id)).toHaveLength(1);
    expect(await listFishTokens(b.id)).toHaveLength(2);
  });

  it('touch 写入 lastUsedAt，且对不存在的令牌静默', async () => {
    const u = await makeUser();
    const minted = await mintFishToken(u.id);
    expect((await listFishTokens(u.id))[0].lastUsedAt).toBeNull();

    await touchFishTokenUsage(minted.token);
    expect((await listFishTokens(u.id))[0].lastUsedAt).not.toBeNull();

    await expect(touchFishTokenUsage('nope')).resolves.toBeUndefined();
  });

  it('touch 失败时**不抛**（纯统计，不该让读接口 500）', async () => {
    vi.spyOn(prisma.fishApiToken, 'updateMany').mockRejectedValueOnce(new Error('boom'));
    await expect(touchFishTokenUsage('whatever')).resolves.toBeUndefined();
  });
});
