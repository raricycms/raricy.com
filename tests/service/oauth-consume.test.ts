// consumeAuthorizationCode —— 授权码单次消费 + redirect_uri 绑定（RFC 6749 §4.1.3）
//
// 【为什么单独测这个】旧实现只把 codeHash / applicationId 放进 updateMany 的 where，
// redirect_uri 的比对落在「未匹配才走」的诊断分支里。两个后果：
//   1. 为 A 回调签发的 code 可以用**同一应用的** B 回调兑换到 token —— 注册了多个
//      回调地址的应用就出现了 code 注入路径（redirect_uri 绑定形同虚设）；
//   2. 错回调的尝试会把 code 标记为已用，合法客户端随后拿到 already_used。
// 本文件把这两条都钉住。

import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb, makeUser, prisma } from '../helpers/db';
import {
  consumeAuthorizationCode,
  createOAuthApplication,
  generateAuthorizationCode,
  hashOpaqueToken,
} from '@/lib/oauth';
import { nowForDb } from '@/lib/db-time';

const CB_A = 'https://app.example.com/cb';
const CB_B = 'https://app.example.com/legacy-cb';

/** 建一个注册了**两个**回调地址的应用，并为 CB_A 签发一枚 code。 */
async function makeAppWithCode(opts: { redirectUri?: string; expired?: boolean } = {}) {
  const owner = await makeUser({ role: 'owner' });
  const { application } = await createOAuthApplication(
    { name: 'test-app', redirectUris: [CB_A, CB_B] },
    owner.id
  );
  const code = generateAuthorizationCode();
  const now = nowForDb();
  await prisma.oAuthAuthorizationCode.create({
    data: {
      codeHash: hashOpaqueToken(code),
      applicationId: application.id,
      userId: owner.id,
      redirectUri: opts.redirectUri ?? CB_A,
      scopes: 'profile',
      expiresAt: new Date(now.getTime() + (opts.expired ? -60_000 : 600_000)),
      createdAt: now,
    },
  });
  return { application, code, owner };
}

beforeEach(async () => {
  await resetDb();
});

describe('redirect_uri 绑定', () => {
  it('★ 同一应用的另一注册回调地址不能兑换（code 注入）', async () => {
    const { application, code } = await makeAppWithCode();
    expect(await consumeAuthorizationCode(code, application.id, CB_B)).toEqual({
      ok: false,
      error: 'redirect_mismatch',
    });
  });

  it('★ 错回调的尝试**不消费** code —— 随后用正确回调仍能兑换', async () => {
    const { application, code, owner } = await makeAppWithCode();

    expect(await consumeAuthorizationCode(code, application.id, CB_B)).toMatchObject({
      ok: false,
      error: 'redirect_mismatch',
    });

    // 旧实现会在这里返回 already_used
    expect(await consumeAuthorizationCode(code, application.id, CB_A)).toEqual({
      ok: true,
      userId: owner.id,
      scopes: ['profile'],
    });
  });

  it('未注册的 redirect_uri 同样拒绝', async () => {
    const { application, code } = await makeAppWithCode();
    expect(await consumeAuthorizationCode(code, application.id, 'https://evil.example/cb')).toEqual({
      ok: false,
      error: 'redirect_mismatch',
    });
  });
});

describe('单次消费与失效判定', () => {
  it('同一 code 第二次兑换 → already_used', async () => {
    const { application, code } = await makeAppWithCode();
    expect((await consumeAuthorizationCode(code, application.id, CB_A)).ok).toBe(true);
    expect(await consumeAuthorizationCode(code, application.id, CB_A)).toEqual({
      ok: false,
      error: 'already_used',
    });
  });

  it('过期的 code → expired', async () => {
    const { application, code } = await makeAppWithCode({ expired: true });
    expect(await consumeAuthorizationCode(code, application.id, CB_A)).toEqual({
      ok: false,
      error: 'expired',
    });
  });

  it('不存在的 code → invalid', async () => {
    const { application } = await makeAppWithCode();
    expect(await consumeAuthorizationCode('nope', application.id, CB_A)).toEqual({
      ok: false,
      error: 'invalid',
    });
  });

  it('换一个应用 id 兑换 → invalid（code 绑定签发它的应用）', async () => {
    const { code } = await makeAppWithCode();
    const other = await makeUser({ role: 'owner' });
    const { application: otherApp } = await createOAuthApplication(
      { name: 'other-app', redirectUris: [CB_A] },
      other.id
    );
    expect(await consumeAuthorizationCode(code, otherApp.id, CB_A)).toEqual({
      ok: false,
      error: 'invalid',
    });
  });
});
