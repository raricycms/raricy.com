// user-service.ts / account-service.ts —— 注册 / 改密 / 邀请码升级 / 资料更新。
//
// 【为什么值得重点测】这是账号的入口与钥匙：
//   · 注册决定了 465 个存量用户之外的每一个新用户的哈希格式（存错 = 登不进来）；
//   · 改密的 sessionVersion 自增是**踢下线所有旧会话**的唯一机制 —— 漏了这一下，
//     用户改完密码以为安全了，攻击者手里的旧 cookie 仍然有效；
//   · 邀请码是角色升级（user → core）的唯一路径，且是**一次性资源**，
//     并发下被用两次就等于凭空多发权限。
// 因此本文件全程跑真实 SQLite，不 mock DB。
//
// 【被测边界 —— 关于账户微服务】registerUser 里有 fail-closed 的远端建号逻辑，
// 但它由 accountServiceEnabled() 门控，而后者只看 ACCOUNT_SERVICE_INTERNAL_TOKEN。
// tests/setup.ts 已 delete 掉该变量 → remoteEnabled === false → 走 dev fallback
// （只建本地用户 + 一条 console.warn）。所以本文件聚焦本地 DB 语义，
// 不去打真实 HTTP。
//
// ⚠️ **已知缺口**：registerUser 的远端 fail-closed 分支（建号时远端失败 → 补偿回滚）
// **目前没有测试覆盖**。五条 fail-closed 写路径里，投喂 / 签到 / CLI / 转账各有
// 对应的 *-failclosed 用例，只有建号这条没有 —— 想补的话照 tests/service/
// checkin-failclosed.test.ts 的 mock 方式（vi.mock accountServiceEnabled + AccountClient）。

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { subscribe as subscribeChat, publishToUsers, __resetChatBus } from '@/lib/chat-bus';
import { subscribe as subscribeTopbar, publishToUser, __resetTopbarBus } from '@/lib/topbar-bus';

import {
  registerUser,
  createUserAccount,
  validateUsername,
  validateEmail,
  changeOwnPassword,
  verifyInviteAndUpgrade,
} from '@/lib/account-service';
import {
  updateOwnProfile,
  getPublicProfile,
  resolveProfileHandle,
} from '@/lib/user-service';
import { hashPassword, verifyPassword } from '@/lib/password';
import { resetDb, makeUser, makeBlog, prisma } from '../helpers/db';

beforeEach(async () => {
  await resetDb();
  await makeInvite({ code: "defaultcode1" });
});

afterEach(() => {
  __resetChatBus();
  __resetTopbarBus();
});

// ── 夹具 ────────────────────────────────────────────────────────────────────

/** 造一个邀请码。默认 12 位（base62 定长 12）。 */
async function makeInvite(opts: { code?: string; isUsed?: boolean; usedBy?: string } = {}) {
  const code = opts.code ?? `inv${Date.now().toString(36)}`.padEnd(12, '0').slice(0, 12);
  return prisma.inviteCode.create({
    data: {
      code,
      isUsed: opts.isUsed ?? false,
      usedBy: opts.usedBy ?? null,
      createdAt: new Date(),
    },
  });
}

/** 造一个密码可被真实校验的用户（makeUser 默认落的是 'placeholder' 占位串）。 */
async function makeUserWithPassword(password: string, extra: Parameters<typeof makeUser>[0] = {}) {
  return makeUser({ ...extra, passwordHash: await hashPassword(password) });
}

/** 一份能通过全部校验的注册输入（用例只覆写关心的那一个字段）。 */
let n = 0;
const goodInput = (over: Partial<Parameters<typeof registerUser>[0]> = {}) => {
  const i = ++n;
  return {
    username: `user${i}`,
    email: `user${i}@example.com`,
    password: 'password123',
    inviteCode: 'defaultcode1',
    ...over,
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// validateUsername
// ─────────────────────────────────────────────────────────────────────────────

describe('validateUsername', () => {
  it('3-20 位边界：空串/2 位过短、3 位通过、20 位通过、21 位过长', () => {
    expect(validateUsername('').ok, '空串按过短拒绝').toBe(false);
    expect(validateUsername('ab').ok, '2 位过短').toBe(false);
    expect(validateUsername('abc').ok, '3 位是下界，必须放行').toBe(true);
    expect(validateUsername('a'.repeat(20)).ok, '20 位是上界，必须放行').toBe(true);
    expect(validateUsername('a'.repeat(21)).ok, '21 位过长').toBe(false);
  });

  it('合法字符集：Unicode 字母 / 数字 / 下划线 / 中间减号', () => {
    for (const name of ['张三-李四', 'русский-язык', 'ひらがな', 'user_name', 'a-b_c123', '123']) {
      expect(validateUsername(name).ok, `${name} 应合法`).toBe(true);
    }
  });

  it('非法：@ 空格 点号 emoji，以及 _ / - 开头或结尾', () => {
    for (const name of ['user@name', 'user name', 'user.name', 'emoji😀x', '_start', '-start', 'end_', 'end-']) {
      expect(validateUsername(name).ok, `${name} 应非法`).toBe(false);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// validateEmail
// ─────────────────────────────────────────────────────────────────────────────

describe('validateEmail', () => {
  it('常见合法邮箱通过；TLD 至少 2 位（a@b.co 合法）', () => {
    for (const e of [
      'a@b.co',
      'user.name+tag@example.com',
      'user_name@sub-domain.example.org',
      'a-b@c.d.efg',
    ]) {
      expect(validateEmail(e), `${e} 应合法`).toBe(true);
    }
  });

  it('明显非法邮箱被拒（含 TLD 只有 1 位的 a@b.c）', () => {
    for (const e of ['', 'noat', 'no@tld', '@example.com', 'a@.com', 'a b@c.com', 'a@b.c']) {
      expect(validateEmail(e), `${e} 应非法`).toBe(false);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// registerUser
// ─────────────────────────────────────────────────────────────────────────────

describe('registerUser：成功路径', () => {
  it('落库的字段正确，且返回 user 摘要（role=core, sessionVersion=0）', async () => {
    const input = goodInput({ username: 'alice', email: 'alice@example.com' });
    const r = await registerUser(input);

    expect(r).toMatchObject({ ok: true, code: 200 });
    expect(r.user).toMatchObject({ username: 'alice', role: 'core', sessionVersion: 0 });

    const row = await prisma.user.findUniqueOrThrow({ where: { username: 'alice' } });
    expect(row.id, '返回的 id 必须与落库的一致').toBe(r.user!.id);
    expect(row.email).toBe('alice@example.com');
    expect(row.role).toBe('core');
    expect(row.sessionVersion).toBe(0);
    expect(row.createdAt, 'createdAt 为 NULL 会让「注册于」展示与排序全废').not.toBeNull();
  });

  it('★ 密码以 werkzeug scrypt 哈希落库，绝不存明文，且能被 verifyPassword 校验通过', async () => {
    const input = goodInput({ password: 'my-secret-pw' });
    await registerUser(input);

    const row = await prisma.user.findUniqueOrThrow({ where: { username: input.username } });
    expect(row.passwordHash, '明文入库 = 一次拖库全员裸奔').not.toBe('my-secret-pw');
    expect(row.passwordHash, '必须是 werkzeug scrypt 格式（存量哈希口径）').toMatch(
      /^scrypt:32768:8:1\$[A-Za-z0-9]{16}\$[0-9a-f]{128}$/
    );
    expect(
      await verifyPassword('my-secret-pw', row.passwordHash),
      '注册落的哈希必须能被登录路径校验通过，否则新用户注册完就登不进来'
    ).toBe(true);
    expect(await verifyPassword('wrong-pw', row.passwordHash), '错误密码不能通过').toBe(false);
  });

  it('username / email 前后空白被 trim 后入库', async () => {
    const r = await registerUser({
      username: '  bob  ',
      email: '  bob@example.com  ',
      inviteCode: 'defaultcode1',
      password: 'password123',
    });
    expect(r.ok).toBe(true);
    expect(await prisma.user.findUnique({ where: { username: 'bob' } }), 'trim 后应能查到').not.toBeNull();
    expect(r.user!.username).toBe('bob');
  });

  it('Unicode 用户名可注册', async () => {
    const r = await registerUser(goodInput({ username: '张三-李四' }));
    expect(r.ok, `中文用户名应可注册，实际: ${r.message}`).toBe(true);
    expect(await prisma.user.findUnique({ where: { username: '张三-李四' } })).not.toBeNull();
  });
});

describe('registerUser：必填与唯一性', () => {
  it('缺 username / email / password 任一 → 拒绝，且不建号', async () => {
    for (const over of [{ username: '' }, { email: '' }, { password: '' }]) {
      const r = await registerUser(goodInput(over));
      expect(r, `缺 ${Object.keys(over)[0]} 应被拒`).toMatchObject({ ok: false, code: 400 });
    }
    expect(await prisma.user.count(), '参数不全不能建号').toBe(0);
  });

  it('用户名重复 → 拒绝，且不新建用户', async () => {
    await makeUser({ username: 'taken' });
    const r = await registerUser(goodInput({ username: 'taken' }));
    expect(r).toMatchObject({ ok: false, code: 400 });
    expect(await prisma.user.count(), '冲突时不能落第二个号').toBe(1);
  });

  it('邮箱重复 → 拒绝', async () => {
    await makeUser({ email: 'dup@example.com' });
    const r = await registerUser(goodInput({ email: 'dup@example.com' }));
    expect(r).toMatchObject({ ok: false, code: 400 });
    expect(await prisma.user.count()).toBe(1);
  });
});

describe('registerUser：格式与长度校验', () => {
  it('用户名 / 邮箱格式不合法 → 拒绝，一个都不落库', async () => {
    for (const over of [{ username: 'ab' }, { username: 'a'.repeat(21) }, { username: '_lead' }]) {
      expect((await registerUser(goodInput(over))).ok, `${JSON.stringify(over)} 应被拒`).toBe(false);
    }
    expect((await registerUser(goodInput({ email: 'not-an-email' }))).ok).toBe(false);
    // 格式合法但超过 100 位同样拒绝（长度上限是契约，不是文案）
    expect((await registerUser(goodInput({ email: 'a'.repeat(95) + '@example.com' }))).ok).toBe(false);
    expect(await prisma.user.count(), '格式不合法一个都不能落库').toBe(0);
  });

  it('密码 100 位通过、101 位拒绝（边界）', async () => {
    expect((await registerUser(goodInput({ password: 'a'.repeat(100) }))).ok, '100 位是上界').toBe(
      true
    );
    expect((await registerUser(goodInput({ password: 'a'.repeat(101) }))).ok).toBe(false);
  });
});

describe('registerUser：邀请码', () => {
  it('缺省、空串和纯空白邀请码均拒绝，且不建号', async () => {
    for (const inviteCode of [undefined, null, '', '   ']) {
      expect(await registerUser(goodInput({ inviteCode }))).toMatchObject({ ok: false, code: 400 });
    }
    expect(await prisma.user.count()).toBe(0);
    expect((await prisma.inviteCode.findUniqueOrThrow({ where: { code: 'defaultcode1' } })).isUsed).toBe(false);
  });

  it('★ 有效邀请码 → role=core，且邀请码被标记 isUsed / usedBy', async () => {
    const inv = await makeInvite({ code: 'abcdefghijkl' });
    const r = await registerUser(goodInput({ inviteCode: 'abcdefghijkl' }));

    expect(r.ok).toBe(true);
    expect(r.user!.role, '有效邀请码必须升级为 core').toBe('core');

    const row = await prisma.user.findUniqueOrThrow({ where: { id: r.user!.id } });
    expect(row.role, '落库的 role 也必须是 core（不能只是返回值好看）').toBe('core');

    const usedInv = await prisma.inviteCode.findUniqueOrThrow({ where: { id: inv.id } });
    expect(usedInv.isUsed, '邀请码用完必须销号，否则可无限复用').toBe(true);
    expect(usedInv.usedBy, 'usedBy 必须指向新注册的用户').toBe(r.user!.id);
  });

  it('邀请码长度非 12 / 不存在的 12 位码 → 拒绝，且不建号', async () => {
    await makeInvite({ code: 'abcdefghijkl' });
    for (const bad of ['abcdefghijk', 'abcdefghijklm', 'x', 'zzzzzzzzzzzz']) {
      const r = await registerUser(goodInput({ inviteCode: bad }));
      expect(r, `邀请码 ${bad} 应被拒`).toMatchObject({ ok: false, code: 400 });
    }
    expect(await prisma.user.count(), '邀请码不合法不能建号').toBe(0);
  });

  it('已使用的邀请码 → 拒绝，且不建号、不改动原 usedBy', async () => {
    const owner = await makeUser();
    const inv = await makeInvite({ code: 'usedusedused', isUsed: true, usedBy: owner.id });

    const r = await registerUser(goodInput({ inviteCode: 'usedusedused' }));
    expect(r).toMatchObject({ ok: false, code: 400 });
    expect(await prisma.user.count(), '只应有原来那个 owner').toBe(1);

    const after = await prisma.inviteCode.findUniqueOrThrow({ where: { id: inv.id } });
    expect(after.usedBy, '失败的注册不能篡改邀请码归属').toBe(owner.id);
  });

  it('邀请码前后空白被 trim（避免用户复制粘贴带空格就用不了）', async () => {
    await makeInvite({ code: 'trimmedcode1' });
    const r = await registerUser(goodInput({ inviteCode: '  trimmedcode1  ' }));
    expect(r.ok, `trim 后应有效，实际: ${r.message}`).toBe(true);
    expect(r.user!.role).toBe('core');
  });

  // 【回归 · BUG-A】一次性邀请码不得被并发双花。
  // 曾经：查码在事务外，事务内用 update where:{id} 无 isUsed:false 兜底 →
  // 两个并发注册都读到 isUsed=false → **双双升到 core**，一个码兑出 2 个权限。
  // 修复：事务内改用 updateMany(where isUsed:false)，count===0 即抛错回滚
  //（与同文件 verifyInviteAndUpgrade 的做法统一）。
  it('两人并发用同一邀请码注册 → 只有 1 人成功升到 core', async () => {
    await makeInvite({ code: 'raceracerace' });

    const results = await Promise.all([
      registerUser(goodInput({ inviteCode: 'raceracerace' })).catch(() => ({ ok: false as const })),
      registerUser(goodInput({ inviteCode: 'raceracerace' })).catch(() => ({ ok: false as const })),
    ]);

    const cores = await prisma.user.count({ where: { role: 'core' } });
    const okCount = results.filter((r) => r.ok).length;

    expect(okCount, '一个一次性邀请码只应让一个注册成功').toBe(1);
    expect(cores, '一个一次性邀请码兑出了多个 core —— 并发双花').toBe(1);

    // 没抢到的一方：不该建号，且错误对用户是 400 业务错误而非 500
    expect(await prisma.user.count(), '失败方的用户记录必须回滚').toBe(1);
    const failed = results.find((r) => !r.ok) as { code?: number };
    expect(failed.code, '并发失败应返回 400（业务错误），不是 500').toBe(400);

    const inv = await prisma.inviteCode.findUniqueOrThrow({ where: { code: 'raceracerace' } });
    expect(inv.isUsed).toBe(true);
    expect(inv.usedBy, '码应归属于成功的那个人').toBe(
      (results.find((r) => r.ok) as { user: { id: string } }).user.id
    );
  });

  it('5 人并发抢同一个码 → 恰好 1 人成功', async () => {
    await makeInvite({ code: 'race5code123' });
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        registerUser(goodInput({ inviteCode: 'race5code123' })).catch(() => ({ ok: false as const }))
      )
    );
    expect(results.filter((r) => r.ok).length).toBe(1);
    expect(await prisma.user.count({ where: { role: 'core' } })).toBe(1);
    expect(await prisma.user.count()).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// changeOwnPassword —— 校验旧密码 → 重写哈希 → 自增 sessionVersion（旧会话全废）
// ─────────────────────────────────────────────────────────────────────────────

describe('changeOwnPassword：成功路径', () => {
  it('改密断开该用户的旧讨论和顶栏流，后续私聊/通知不再投递，其他用户不受影响', async () => {
    const u = await makeUserWithPassword('oldpassword');
    const chatWrite = vi.fn(() => true);
    const topbarWrite = vi.fn(() => true);
    const chatClose = vi.fn();
    const topbarClose = vi.fn();
    const otherWrite = vi.fn(() => true);
    subscribeChat({ userId: u.id, lobbyBlocked: false, write: chatWrite, close: chatClose });
    subscribeTopbar({ userId: u.id, write: topbarWrite, close: topbarClose });
    subscribeChat({ userId: 'other', lobbyBlocked: false, write: otherWrite, close: vi.fn() });

    expect((await changeOwnPassword(u.id, 'oldpassword', 'newpassword1', 'newpassword1')).ok).toBe(true);
    publishToUsers([u.id, 'other'], { type: 'resync' });
    publishToUser(u.id, { count: 1 });
    expect(chatClose).toHaveBeenCalledOnce();
    expect(topbarClose).toHaveBeenCalledOnce();
    expect(chatWrite).not.toHaveBeenCalled();
    expect(topbarWrite).not.toHaveBeenCalled();
    expect(otherWrite).toHaveBeenCalledOnce();
  });
  it('★★ sessionVersion 必须自增 —— 这是踢下线所有旧会话的唯一机制', async () => {
    const u = await makeUserWithPassword('oldpassword', { sessionVersion: 3 });

    const r = await changeOwnPassword(u.id, 'oldpassword', 'newpassword1', 'newpassword1');
    expect(r).toMatchObject({ ok: true, code: 200 });

    const row = await prisma.user.findUniqueOrThrow({ where: { id: u.id } });
    expect(
      row.sessionVersion,
      'sessionVersion 没有 +1 → user_loader 认不出旧会话失效 → 改完密码，被盗的旧 cookie 依然能登录'
    ).toBe(4);
  });

  it('连续改两次密码，sessionVersion 连续递增（每次都要踢一次）', async () => {
    const u = await makeUserWithPassword('password0', { sessionVersion: 0 });
    await changeOwnPassword(u.id, 'password0', 'password1', 'password1');
    expect((await prisma.user.findUniqueOrThrow({ where: { id: u.id } })).sessionVersion).toBe(1);
    await changeOwnPassword(u.id, 'password1', 'password2', 'password2');
    expect((await prisma.user.findUniqueOrThrow({ where: { id: u.id } })).sessionVersion).toBe(2);
  });

  it('新哈希可校验新密码、不可校验旧密码，且格式仍是 werkzeug scrypt', async () => {
    const u = await makeUserWithPassword('oldpassword');
    await changeOwnPassword(u.id, 'oldpassword', 'newpassword1', 'newpassword1');

    const row = await prisma.user.findUniqueOrThrow({ where: { id: u.id } });
    expect(await verifyPassword('newpassword1', row.passwordHash), '新密码必须能登').toBe(true);
    expect(await verifyPassword('oldpassword', row.passwordHash), '旧密码必须失效').toBe(false);
    expect(row.passwordHash, '哈希格式必须与存量用户一致（werkzeug scrypt）').toMatch(/^scrypt:32768:8:1\$/);
  });

  it('只改密码，不误伤其它字段（角色、余额、邮箱）', async () => {
    const u = await makeUserWithPassword('oldpassword', { role: 'admin', driedFish: 42 });
    await changeOwnPassword(u.id, 'oldpassword', 'newpassword1', 'newpassword1');
    const row = await prisma.user.findUniqueOrThrow({ where: { id: u.id } });
    expect(row.role).toBe('admin');
    expect(row.driedFish, '余额未被误伤（存储单位 = 0.0001 鱼干）').toBe(420000); // 42 鱼干 × 10000
    expect(row.email).toBe(u.email);
  });
});

describe('changeOwnPassword：拒绝路径（必须密码不变 + sessionVersion 不动）', () => {
  /** 断言「什么都没发生」：旧密码仍可用，sessionVersion 原样。 */
  async function expectUntouched(userId: string, oldPw: string, version: number) {
    const row = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(await verifyPassword(oldPw, row.passwordHash), '被拒绝后密码必须原样').toBe(true);
    expect(row.sessionVersion, '被拒绝后不能踢用户下线（sessionVersion 不该动）').toBe(version);
  }

  it('★ 原密码错误 → 拒绝，密码不变、旧会话不被踢', async () => {
    const u = await makeUserWithPassword('oldpassword', { sessionVersion: 5 });
    const r = await changeOwnPassword(u.id, 'WRONG', 'newpassword1', 'newpassword1');
    expect(r).toMatchObject({ ok: false, code: 400 });
    await expectUntouched(u.id, 'oldpassword', 5);
  });

  it('三项任一为空 → 拒绝（早于原密码校验）', async () => {
    const u = await makeUserWithPassword('oldpassword', { sessionVersion: 5 });
    const cases: [string, string, string][] = [
      ['', 'newpassword1', 'newpassword1'],
      ['oldpassword', '', 'newpassword1'],
      ['oldpassword', 'newpassword1', ''],
      ['   ', '   ', '   '], // 纯空白 trim 后为空
    ];
    for (const [a, b, c] of cases) {
      const r = await changeOwnPassword(u.id, a, b, c);
      expect(r, `(${a}|${b}|${c}) 应被拒`).toMatchObject({ ok: false, code: 400 });
    }
    await expectUntouched(u.id, 'oldpassword', 5);
  });

  it('新密码 8 位通过、7 位拒绝（边界）', async () => {
    const u = await makeUserWithPassword('oldpassword', { sessionVersion: 5 });

    const short = await changeOwnPassword(u.id, 'oldpassword', '1234567', '1234567');
    expect(short).toMatchObject({ ok: false, code: 400 });
    await expectUntouched(u.id, 'oldpassword', 5);

    const ok = await changeOwnPassword(u.id, 'oldpassword', '12345678', '12345678');
    expect(ok.ok, '8 位是下界，必须放行').toBe(true);
  });

  it('新密码与原密码相同 → 拒绝（且不白白 +1 sessionVersion）', async () => {
    const u = await makeUserWithPassword('oldpassword', { sessionVersion: 5 });
    const r = await changeOwnPassword(u.id, 'oldpassword', 'oldpassword', 'oldpassword');
    expect(r).toMatchObject({ ok: false, code: 400 });
    await expectUntouched(u.id, 'oldpassword', 5);
  });

  it('哈希是无法解析的垃圾串时按「原密码不正确」拒绝，不抛异常', async () => {
    // 存量库里若有脏数据（如占位 'placeholder'），改密路径不能 500
    const u = await makeUser({ passwordHash: 'placeholder', sessionVersion: 2 });
    const r = await changeOwnPassword(u.id, 'whatever', 'newpassword1', 'newpassword1');
    expect(r).toMatchObject({ ok: false, code: 400 });
    expect((await prisma.user.findUniqueOrThrow({ where: { id: u.id } })).sessionVersion).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// verifyInviteAndUpgrade —— 校验邀请码 → 提权为 core（一次性，码随即失效）
// ─────────────────────────────────────────────────────────────────────────────

describe('verifyInviteAndUpgrade', () => {
  it('★ 有效邀请码 → role 升为 core，码被标记 isUsed/usedBy', async () => {
    const u = await makeUser({ role: 'user' });
    const inv = await makeInvite({ code: 'goodcode1234' });

    const r = await verifyInviteAndUpgrade(u.id, 'goodcode1234');
    expect(r).toMatchObject({ ok: true, code: 200 });

    expect((await prisma.user.findUniqueOrThrow({ where: { id: u.id } })).role).toBe('core');
    const after = await prisma.inviteCode.findUniqueOrThrow({ where: { id: inv.id } });
    expect(after.isUsed).toBe(true);
    expect(after.usedBy).toBe(u.id);
  });

  it('★ 已使用的邀请码 → 拒绝，role 不变、原 usedBy 不被篡改', async () => {
    const first = await makeUser();
    const second = await makeUser({ role: 'user' });
    const inv = await makeInvite({ code: 'usedcode1234', isUsed: true, usedBy: first.id });

    const r = await verifyInviteAndUpgrade(second.id, 'usedcode1234');
    expect(r).toMatchObject({ ok: false, code: 400 });

    expect(
      (await prisma.user.findUniqueOrThrow({ where: { id: second.id } })).role,
      '用废码不能升级'
    ).toBe('user');
    const after = await prisma.inviteCode.findUniqueOrThrow({ where: { id: inv.id } });
    expect(after.usedBy, '不能改写邀请码的归属').toBe(first.id);
  });

  it('★ 长度非 12 → 拒绝，且不查库不改任何东西', async () => {
    const u = await makeUser({ role: 'user' });
    await makeInvite({ code: 'exactly12chr' });

    for (const bad of ['', 'short', 'exactly12ch', 'exactly12chrs', 'a'.repeat(50)]) {
      const r = await verifyInviteAndUpgrade(u.id, bad);
      expect(r, `长度 ${bad.length} 应被拒`).toMatchObject({ ok: false, code: 400 });
    }
    expect((await prisma.user.findUniqueOrThrow({ where: { id: u.id } })).role).toBe('user');
    expect(
      (await prisma.inviteCode.findUniqueOrThrow({ where: { code: 'exactly12chr' } })).isUsed,
      '失败的验证不能消耗掉别的码'
    ).toBe(false);
  });

  it('不存在的 12 位码 → 拒绝，role 不变', async () => {
    const u = await makeUser({ role: 'user' });
    const r = await verifyInviteAndUpgrade(u.id, 'nonexistent1');
    expect(r).toMatchObject({ ok: false, code: 400 });
    expect((await prisma.user.findUniqueOrThrow({ where: { id: u.id } })).role).toBe('user');
  });

  it('★ 已是 admin/owner 的用户用码：码被消耗，但角色不会被降级为 core', async () => {
    // 规则：只有恰好是 'user' 才升为 'core'，更高角色一律原样保留（不降级）
    for (const role of ['admin', 'owner', 'core'] as const) {
      await resetDb();
      const u = await makeUser({ role });
      await makeInvite({ code: 'nodowngrade1' });

      const r = await verifyInviteAndUpgrade(u.id, 'nodowngrade1');
      expect(r.ok).toBe(true);
      expect(
        (await prisma.user.findUniqueOrThrow({ where: { id: u.id } })).role,
        `${role} 用邀请码后不能被降级为 core`
      ).toBe(role);
    }
  });

  it('★★ 并发：两人同时用同一个码 → 只能成功一次（updateMany where isUsed:false 兜底）', async () => {
    const a = await makeUser({ role: 'user' });
    const b = await makeUser({ role: 'user' });
    await makeInvite({ code: 'concurrent12' });

    const results = await Promise.all([
      verifyInviteAndUpgrade(a.id, 'concurrent12'),
      verifyInviteAndUpgrade(b.id, 'concurrent12'),
    ]);

    const okCount = results.filter((r) => r.ok).length;
    expect(okCount, `一个码只能兑一次，实测成功 ${okCount} 次`).toBe(1);

    const cores = await prisma.user.count({ where: { role: 'core' } });
    expect(cores, `只能有一个人升到 core，实测 ${cores} 个`).toBe(1);

    const inv = await prisma.inviteCode.findUniqueOrThrow({ where: { code: 'concurrent12' } });
    expect(inv.isUsed).toBe(true);
    expect([a.id, b.id], 'usedBy 必须是那个成功的人').toContain(inv.usedBy);

    // 失败的那个人必须没被升级
    const loser = inv.usedBy === a.id ? b.id : a.id;
    expect((await prisma.user.findUniqueOrThrow({ where: { id: loser } })).role).toBe('user');
  });

  it('★★ 并发：5 人抢同一个码 → 恰好 1 人成功', async () => {
    const users = await Promise.all(
      Array.from({ length: 5 }, () => makeUser({ role: 'user' }))
    );
    await makeInvite({ code: 'stampede1234' });

    const results = await Promise.all(
      users.map((u) =>
        verifyInviteAndUpgrade(u.id, 'stampede1234').catch(() => ({
          ok: false as const,
          code: 500,
          message: 'thrown',
        }))
      )
    );

    expect(results.filter((r) => r.ok).length, '5 人抢 1 个码，只能 1 人成功').toBe(1);
    expect(await prisma.user.count({ where: { role: 'core' } }), '只能兑出 1 个 core').toBe(1);
  });

  it('两个不同的码互不影响，两人各自升级', async () => {
    const a = await makeUser({ role: 'user' });
    const b = await makeUser({ role: 'user' });
    await makeInvite({ code: 'codeaaaaaaaa' });
    await makeInvite({ code: 'codebbbbbbbb' });

    expect((await verifyInviteAndUpgrade(a.id, 'codeaaaaaaaa')).ok).toBe(true);
    expect((await verifyInviteAndUpgrade(b.id, 'codebbbbbbbb')).ok).toBe(true);
    expect(await prisma.user.count({ where: { role: 'core' } })).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// updateOwnProfile —— 对齐 settings.py:update_bio / update_privacy
// ─────────────────────────────────────────────────────────────────────────────

describe('updateOwnProfile：bio', () => {
  it('正常写入并返回，落库一致', async () => {
    const u = await makeUser();
    const r = await updateOwnProfile(u.id, { bio: '你好，我是喵' });
    expect(r).toMatchObject({ ok: true, code: 200 });
    expect(r.data!.bio).toBe('你好，我是喵');
    expect((await prisma.user.findUniqueOrThrow({ where: { id: u.id } })).bio).toBe('你好，我是喵');
  });

  it('emoji / 换行 / Markdown 原样保存（不做转义，展示层负责）', async () => {
    const u = await makeUser();
    const bio = '第一行\n第二行 😀 **粗体** <script>alert(1)</script>';
    const r = await updateOwnProfile(u.id, { bio });
    expect(r.data!.bio).toBe(bio);
  });

  it('长度上限 500：500 放行、501 拒绝；首尾空白 trim；纯空白落 null', async () => {
    const u = await makeUser();
    expect((await updateOwnProfile(u.id, { bio: 'x'.repeat(500) })).ok, '恰好 500 应放行').toBe(true);
    expect((await updateOwnProfile(u.id, { bio: 'x'.repeat(501) })).ok, '501 应拒绝').toBe(false);
    const trimmed = await updateOwnProfile(u.id, { bio: '  简介  ' });
    expect(trimmed.data!.bio).toBe('简介');
    expect((await updateOwnProfile(u.id, { bio: '   ' })).ok).toBe(true);
    expect(
      (await prisma.user.findUniqueOrThrow({ where: { id: u.id } })).bio,
      '纯空白按空简介落库（null），不是空串'
    ).toBeNull();
  });
});

describe('updateOwnProfile：通知偏好与隐私开关', () => {
  it('四个通知字段可分别关闭，落库正确', async () => {
    const u = await makeUser();
    const r = await updateOwnProfile(u.id, {
      notifyLike: false,
      notifyEdit: false,
      notifyDelete: false,
      notifyAdmin: false,
    });
    expect(r.ok).toBe(true);
    expect(r.data).toMatchObject({
      notifyLike: false,
      notifyEdit: false,
      notifyDelete: false,
      notifyAdmin: false,
    });
    const row = await prisma.user.findUniqueOrThrow({ where: { id: u.id } });
    expect(row).toMatchObject({
      notifyLike: false,
      notifyEdit: false,
      notifyDelete: false,
      notifyAdmin: false,
    });
  });

  it('★ 只更新传入的字段，未传的保持原样（PATCH 语义，不能把没传的重置成默认值）', async () => {
    const u = await makeUser();
    await updateOwnProfile(u.id, { notifyLike: false, notifyEdit: false, bio: '原本的简介' });

    // 只改 notifyLike 回 true
    const r = await updateOwnProfile(u.id, { notifyLike: true });
    expect(r.ok).toBe(true);

    const row = await prisma.user.findUniqueOrThrow({ where: { id: u.id } });
    expect(row.notifyLike).toBe(true);
    expect(row.notifyEdit, '没传的 notifyEdit 必须保持 false').toBe(false);
    expect(row.bio, '没传的 bio 必须保持原样，不能被清空').toBe('原本的简介');
  });

  it('隐私开关 showRecentBlogs / showRecentComments 可关闭', async () => {
    const u = await makeUser();
    const r = await updateOwnProfile(u.id, { showRecentBlogs: false, showRecentComments: false });
    expect(r.data).toMatchObject({ showRecentBlogs: false, showRecentComments: false });
    const row = await prisma.user.findUniqueOrThrow({ where: { id: u.id } });
    expect(row.showRecentBlogs).toBe(false);
    expect(row.showRecentComments).toBe(false);
  });

  it('非布尔值的通知字段被忽略（不会把 role 之类写坏，也不写 truthy 的字符串）', async () => {
    const u = await makeUser();
    // 模拟前端传了字符串 'false' —— typeof 检查应把它挡掉
    const r = await updateOwnProfile(u.id, {
      notifyLike: 'false' as unknown as boolean,
      notifyEdit: false,
    });
    expect(r.ok).toBe(true);
    const row = await prisma.user.findUniqueOrThrow({ where: { id: u.id } });
    expect(row.notifyLike, "非布尔的 'false' 应被忽略 → 保持默认 true").toBe(true);
    expect(row.notifyEdit).toBe(false);
  });

  it('空 patch → 拒绝（不应白打一次 UPDATE）', async () => {
    const u = await makeUser();
    const r = await updateOwnProfile(u.id, {});
    expect(r).toMatchObject({ ok: false, code: 400 });
  });

  it('只含未识别字段的 patch 也按「没有可更新的字段」拒绝（更不能提权）', async () => {
    const u = await makeUser();
    const r = await updateOwnProfile(u.id, { role: 'owner' } as never);
    expect(r.ok, '不认识的字段不能被当成有效更新').toBe(false);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: u.id } })).role, '更不能提权').toBe(
      'user'
    );
  });

  it('bio 与开关可一次性同时更新', async () => {
    const u = await makeUser();
    const r = await updateOwnProfile(u.id, { bio: '简介', showRecentBlogs: false, notifyAdmin: false });
    expect(r.data).toMatchObject({ bio: '简介', showRecentBlogs: false, notifyAdmin: false });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getPublicProfile —— 公开接口，字段必须收敛（尤其不能漏 email）
//
// ⚠️ 本函数**内容按查看者分档**（`/u/:id` 是匿名可达的页面，主页画报的二维码会把站外
// 人引过来）：身份字段对所有人可见，role 徽章与最近文章/评论只给本人或 core+。
// 故每个用例都必须显式给 viewer —— 这不是样板，是这条约束的可见化。
// ─────────────────────────────────────────────────────────────────────────────

/** 一个 ≠ 目标用户的 core+ 查看者：测「不是本人，但档位够」。 */
async function coreViewer() {
  const v = await makeUser({ role: 'core' });
  return { id: v.id, isCore: true };
}

describe('getPublicProfile', () => {
  it('★ 绝不返回 email / passwordHash（这是公开页面）', async () => {
    const u = await makeUser({ username: 'pub', email: 'secret@example.com' });
    const p = await getPublicProfile(u.id, await coreViewer());
    expect(p).not.toBeNull();
    const json = JSON.stringify(p);
    expect(json, 'email 出现在公开资料里 = 全站用户邮箱可被枚举').not.toContain('secret@example.com');
    expect(Object.keys(p!).sort()).toEqual(
      [
        'avatarPath',
        'bio',
        'createdAt',
        // 头像框贴图地址。它**不是**身份信息 —— 框是站点素材，本来就对所有人显示，
        // 所以不跟 role 一样按查看者档位收敛（见 PublicProfile.frameUrl 的注释）
        'frameUrl',
        // 主页身份条底色（null = 默认纸白）。它是访客看得见的外观，不是本人资料；
        // 已过 isHeroTone 白名单，渲染层拿到的一定是合法 id 或 null。
        'heroTone',
        'id',
        'recentBlogs',
        'recentComments',
        'role',
        'showRecentBlogs',
        'showRecentComments',
        'username',
      ].sort()
    );
  });

  it('用户不存在返回 null（不抛异常）', async () => {
    expect(await getPublicProfile('ghost', null)).toBeNull();
  });


  it('createdAt 序列化为 ISO 字符串', async () => {
    const u = await makeUser();
    const p = await getPublicProfile(u.id, null);
    expect(p!.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('heroTone 过身份条白名单：合法值原样给，脏值回落 null', async () => {
    const u = await makeUser();
    expect((await getPublicProfile(u.id, null))!.heroTone).toBeNull();

    await prisma.user.update({ where: { id: u.id }, data: { profileHeroTone: 'mint' } });
    expect((await getPublicProfile(u.id, null))!.heroTone).toBe('mint');

    // 石墨是卡片色、不是身份条色；库里被手改成乱码也不能拼进 className。
    for (const bad of ['graphite', 'neon', '']) {
      await prisma.user.update({ where: { id: u.id }, data: { profileHeroTone: bad } });
      expect((await getPublicProfile(u.id, null))!.heroTone).toBeNull();
    }
  });

  // ── 档位：谁能看到「内容」 ────────────────────────────────────────────────

  it('★ 游客（viewer=null）：只拿身份字段，role 为 null、文章与评论一律为空', async () => {
    const u = await makeUser({ username: 'host' });
    await prisma.user.update({ where: { id: u.id }, data: { bio: '我的简介' } });
    await makeBlog({ authorId: u.id, title: '不该被游客看到的文章' });
    const blog = await makeBlog({ title: '某篇文章' });
    await prisma.blogComment.create({
      data: {
        id: 'c-guest',
        blogId: blog.id,
        authorId: u.id,
        content: '不该被游客看到的评论',
        isDeleted: false,
        createdAt: new Date(),
      },
    });

    const p = await getPublicProfile(u.id, null);
    // 身份字段照旧 —— 那才是「公开主页」的主体
    expect(p!.username).toBe('host');
    expect(p!.bio).toBe('我的简介');
    // 内容一律收掉
    expect(p!.role, 'role 泄露 = 游客能枚举出谁是管理员').toBeNull();
    expect(p!.recentBlogs, '文章标题对全互联网开放 = 这次要堵的洞').toEqual([]);
    expect(p!.recentComments, '评论片段同理').toEqual([]);
    expect(JSON.stringify(p), '连标题都不该出现在载荷里').not.toContain('不该被游客看到');
  });

  it('非 core 登录用户（有账号但没认证）：同游客 —— 身份字段在，内容不在', async () => {
    const u = await makeUser();
    await makeBlog({ authorId: u.id, title: '文章' });
    const plain = await makeUser({ role: 'user' });

    const p = await getPublicProfile(u.id, { id: plain.id, isCore: false });
    expect(p!.username).toBe(u.username);
    expect(p!.role).toBeNull();
    expect(p!.recentBlogs).toEqual([]);
  });

  it('★ 本人看自己的主页不受档位影响（否则普通用户的主页会变空壳）', async () => {
    const u = await makeUser({ role: 'user' });
    await makeBlog({ authorId: u.id, title: '我的文章' });

    const p = await getPublicProfile(u.id, { id: u.id, isCore: false });
    expect(p!.role).toBe('user');
    expect(p!.recentBlogs.map((b) => b.title)).toEqual(['我的文章']);
  });

  it('档位与开关正交：本人把开关关掉后，连自己也看不到那条列表', async () => {
    const u = await makeUser({ role: 'user' });
    await makeBlog({ authorId: u.id, title: '我的文章' });
    await updateOwnProfile(u.id, { showRecentBlogs: false });

    const p = await getPublicProfile(u.id, { id: u.id, isCore: false });
    expect(p!.recentBlogs, '开关管「愿不愿意展示」，与「谁够格」是两回事').toEqual([]);
  });

  // ── 隐私开关（口径不变，只是现在先过查看者档位这一关） ────────────────────

  it('showRecentBlogs=false 时不返回文章（隐私开关必须真的生效）', async () => {
    const u = await makeUser();
    await makeBlog({ authorId: u.id, title: '我的文章' });

    expect((await getPublicProfile(u.id, await coreViewer()))!.recentBlogs, '默认开启时应能看到').toHaveLength(1);

    await updateOwnProfile(u.id, { showRecentBlogs: false });
    const p = await getPublicProfile(u.id, await coreViewer());
    expect(p!.recentBlogs, '关掉开关后必须为空，否则隐私设置形同虚设').toEqual([]);
    expect(p!.showRecentBlogs).toBe(false);
  });

  it('软删除（ignore=true）的文章不出现在公开资料里', async () => {
    const u = await makeUser();
    await makeBlog({ authorId: u.id, title: '已删除', ignore: true });
    await makeBlog({ authorId: u.id, title: '正常' });
    const p = await getPublicProfile(u.id, await coreViewer());
    expect(p!.recentBlogs.map((b) => b.title)).toEqual(['正常']);
  });

  it('最近文章按时间倒序、最多 10 篇', async () => {
    const u = await makeUser();
    for (let i = 0; i < 12; i++) {
      await makeBlog({
        authorId: u.id,
        title: `t${i}`,
        createdAt: new Date(2026, 0, 1, 0, 0, i),
      });
    }
    const p = await getPublicProfile(u.id, await coreViewer());
    expect(p!.recentBlogs, '上限 10 篇').toHaveLength(10);
    expect(p!.recentBlogs[0].title, '最新的在最前').toBe('t11');
  });

  it('showRecentComments=false 时不返回评论', async () => {
    const u = await makeUser();
    const blog = await makeBlog({ title: '某篇文章' });
    await prisma.blogComment.create({
      data: {
        id: 'c1',
        blogId: blog.id,
        authorId: u.id,
        content: '一条评论',
        isDeleted: false,
        createdAt: new Date(),
      },
    });

    expect((await getPublicProfile(u.id, await coreViewer()))!.recentComments).toHaveLength(1);

    await updateOwnProfile(u.id, { showRecentComments: false });
    expect((await getPublicProfile(u.id, await coreViewer()))!.recentComments).toEqual([]);
  });

  it('评论内容截断到 120 字（公开页不给全文）', async () => {
    const u = await makeUser();
    const blog = await makeBlog({ title: '某篇文章' });
    await prisma.blogComment.create({
      data: {
        id: 'c-long',
        blogId: blog.id,
        authorId: u.id,
        content: '字'.repeat(300),
        isDeleted: false,
        createdAt: new Date(),
      },
    });
    const p = await getPublicProfile(u.id, await coreViewer());
    expect(p!.recentComments[0].content).toHaveLength(120);
    expect(p!.recentComments[0].blogTitle, '应带上所属文章标题').toBe('某篇文章');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// resolveProfileHandle —— `/api/users/<句柄>` 的两条路（用户名片要按名字查）
//
// 【为什么值得单测】「按 id 命中的免档、按名字命中的要 core+」这条分叉完全落在这个
// 返回值上，而 route 层只看得见 `viaName` 这一个布尔。判错的后果是单向的：把名字误判成
// id = 匿名可以枚举用户名；把 id 误判成名字 = 公开主页被 core+ 以外的所有人打不开。
// ─────────────────────────────────────────────────────────────────────────────

describe('resolveProfileHandle', () => {
  it('按 id 命中 → viaName: false', async () => {
    const u = await makeUser({ username: 'alice' });
    expect(await resolveProfileHandle(u.id)).toEqual({ id: u.id, viaName: false });
  });

  it('按用户名命中 → viaName: true', async () => {
    const u = await makeUser({ username: 'alice' });
    expect(await resolveProfileHandle('alice')).toEqual({ id: u.id, viaName: true });
  });

  it('中文用户名同样命中', async () => {
    const u = await makeUser({ username: '张三丰' });
    expect(await resolveProfileHandle('张三丰')).toEqual({ id: u.id, viaName: true });
  });

  it('两边都没有 → null', async () => {
    expect(await resolveProfileHandle('ghost')).toBeNull();
    expect(await resolveProfileHandle('00000000-0000-0000-0000-000000000000')).toBeNull();
  });

  it('★ 大小写敏感：不归一化（折叠会把两个不同的号变成一个）', async () => {
    const u = await makeUser({ username: 'ZhangSan' });
    expect(await resolveProfileHandle('zhangsan')).toBeNull();
    expect(await resolveProfileHandle('ZhangSan')).toEqual({ id: u.id, viaName: true });
  });

  it('★ 不假设 id 是 UUID：形态奇特的 id 照样按 id 命中', async () => {
    // 存量数据与夹具里的 id 不保证是 UUID（bot 文档里那个 `u_xxx` 的例子就是这么来的）。
    // 靠 UUID 正则分流的写法会把这一个判成「按名字查」，于是公开主页被档位挡在外面。
    const u = await makeUser({ id: 'u_xxx', username: 'alice' });
    expect(await resolveProfileHandle('u_xxx')).toEqual({ id: 'u_xxx', viaName: false });
  });
});

// 专注模式开关（原「成功文案」用例已按站长口径删除：文案不写测试）
describe('updateOwnProfile：专注模式开关', () => {
  it('focusMode 布尔落库可回读', async () => {
    const u = await makeUser();
    const on = await updateOwnProfile(u.id, { focusMode: true });
    expect(on.ok).toBe(true);
    if (on.ok) {
      expect(on.data?.focusMode).toBe(true);
    }
    const row = await prisma.user.findUnique({ where: { id: u.id } });
    expect(row?.focusMode).toBe(true);

    const off = await updateOwnProfile(u.id, { focusMode: false });
    if (off.ok) expect(off.data?.focusMode).toBe(false);
    expect((await prisma.user.findUnique({ where: { id: u.id } }))?.focusMode).toBe(false);
  });

  it('只发 bio 不会把 focusMode 重置（缺省分支）', async () => {
    const u = await makeUser();
    await updateOwnProfile(u.id, { focusMode: true });
    await updateOwnProfile(u.id, { bio: '只改简介' });
    const row = await prisma.user.findUnique({ where: { id: u.id } });
    expect(row?.focusMode).toBe(true);
  });
});

// ── 建号内核（公开注册 / 站长建号共用）────────────────────────────────────────
//
// 内核**没有预检** —— 唯一约束是并发下唯一的防线。所以这里直接连着建两个同名/同邮箱的
// 号来逼出 P2002，验证它被映射成 400 而不是塌成 503：后者会把「用户名已存在」报成
// 「注册失败，请稍后重试」，把用户和排查的人都指向错误的方向。

describe('createUserAccount（建号内核）', () => {
  const base = {
    password: 'pw12345678',
    role: 'core',
    remoteRequiredLabel: '建号',
  };

  it('用户名撞唯一约束 → unique_violation/username', async () => {
    await makeUser({ username: 'taken', email: 'taken@example.com' });
    const r = await createUserAccount({ ...base, username: 'taken', email: 'other@example.com' });
    expect(r).toMatchObject({ ok: false, failure: { kind: 'unique_violation', field: 'username' } });
  });

  it('邮箱撞唯一约束 → unique_violation/email', async () => {
    await makeUser({ username: 'someone', email: 'taken@example.com' });
    const r = await createUserAccount({ ...base, username: 'brandnew', email: 'taken@example.com' });
    expect(r).toMatchObject({ ok: false, failure: { kind: 'unique_violation', field: 'email' } });
  });

  it('冲突时事务整体回滚，不留半截用户', async () => {
    await makeUser({ username: 'taken', email: 'taken@example.com' });
    const before = await prisma.user.count();
    await createUserAccount({ ...base, username: 'taken', email: 'fresh@example.com' });
    expect(await prisma.user.count()).toBe(before);
  });

  it('beforeCommit 抛错 → precondition，且整事务回滚（不建号）', async () => {
    const boom = new Error('precheck failed');
    const before = await prisma.user.count();
    const r = await createUserAccount({
      ...base,
      username: 'aborted',
      email: 'aborted@example.com',
      beforeCommit: async () => {
        throw boom;
      },
    });
    expect(r.ok).toBe(false);
    if (r.ok || r.failure.kind !== 'precondition') {
      throw new Error(`期望 precondition，实际：${JSON.stringify(r)}`);
    }
    // 原样传回，调用方才能认出自己的哨兵（如 InviteCodeRaceError）
    expect(r.failure.cause).toBe(boom);
    expect(await prisma.user.count()).toBe(before);
  });
});

// ── 占位邮箱的保留域 ────────────────────────────────────────────────────────

describe('registerUser：占位邮箱的保留域', () => {
  it('不允许公开注册 users.invalid（大小写不敏感）—— 否则任何人都能抢注占位邮箱', async () => {
    for (const email of ['bob@users.invalid', 'BOB@Users.Invalid']) {
      const r = await registerUser({ username: 'bob', email, password: 'pw12345678' });
      expect(r, `${email} 应被拒`).toMatchObject({ ok: false, code: 400 });
    }
    expect(await prisma.user.findUnique({ where: { username: 'bob' } })).toBeNull();
  });
});
