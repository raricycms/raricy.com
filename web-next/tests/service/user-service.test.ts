// user-service.ts —— 注册 / 改密 / 邀请码升级 / 资料更新。
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
// 不去打真实 HTTP。远端 fail-closed 分支的覆盖见交付说明。

import { describe, it, expect, beforeEach } from 'vitest';

import {
  registerUser,
  validateUsername,
  validateEmail,
  changeOwnPassword,
  verifyInviteAndUpgrade,
  updateOwnProfile,
  getPublicProfile,
} from '@/lib/user-service';
import { hashPassword, verifyPassword } from '@/lib/password';
import { resetDb, makeUser, makeBlog, prisma } from '../helpers/db';

beforeEach(async () => {
  await resetDb();
});

// ── 夹具 ────────────────────────────────────────────────────────────────────

/** 造一个邀请码。默认 12 位（对齐 Flask generate_invite_code 的 base62 定长 12）。 */
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
    ...over,
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// validateUsername —— 对齐 app/utils/verify_username.py
// ─────────────────────────────────────────────────────────────────────────────

describe('validateUsername（对齐 Flask verify_username.py）', () => {
  it('3-20 位边界：2 位过短、3 位通过、20 位通过、21 位过长', () => {
    expect(validateUsername('ab')).toEqual({ ok: false, message: '用户名过短（至少3个字符）' });
    expect(validateUsername('abc').ok, '3 位是下界，必须放行').toBe(true);
    expect(validateUsername('a'.repeat(20)).ok, '20 位是上界，必须放行').toBe(true);
    expect(validateUsername('a'.repeat(21))).toEqual({
      ok: false,
      message: '用户名过长（最多20个字符）',
    });
  });

  it('空串按「过短」拒绝，不是崩溃或放行', () => {
    expect(validateUsername('')).toMatchObject({ ok: false, message: '用户名过短（至少3个字符）' });
  });

  it('Unicode 字母合法：中文 / 俄语 / 日文（Flask 的 \\p{L} 语义）', () => {
    // 这几个正是 verify_username.py __main__ 里的示例用例
    expect(validateUsername('张三-李四').ok, '中文 + 减号，Flask 侧标注为有效').toBe(true);
    expect(validateUsername('русский-язык').ok, '俄语，Flask 侧标注为有效').toBe(true);
    expect(validateUsername('ひらがな').ok).toBe(true);
  });

  it('数字 / 下划线 / 减号在中间合法', () => {
    expect(validateUsername('user_name').ok).toBe(true);
    expect(validateUsername('a-b_c123').ok).toBe(true);
    expect(validateUsername('123').ok, '纯数字（\\p{N}）也合法').toBe(true);
  });

  it('非法字符被拒绝（@ 空格 . 等）', () => {
    expect(validateUsername('user@name')).toMatchObject({ ok: false, message: '用户名含非法字符' });
    expect(validateUsername('user name').ok, '空格非法').toBe(false);
    expect(validateUsername('user.name').ok, '点号非法').toBe(false);
    expect(validateUsername('emoji😀x').ok, 'emoji 非法').toBe(false);
  });

  it('不能以 _ 或 - 开头 / 结尾（文案逐字对齐 Flask）', () => {
    expect(validateUsername('_invalid_start')).toEqual({
      ok: false,
      message: '用户名不能以 _ 或 - 开头',
    });
    expect(validateUsername('-start')).toMatchObject({ message: '用户名不能以 _ 或 - 开头' });
    expect(validateUsername('end_with-')).toEqual({
      ok: false,
      message: '用户名不能以 _ 或 - 结尾',
    });
    expect(validateUsername('end_')).toMatchObject({ message: '用户名不能以 _ 或 - 结尾' });
  });

  it('校验顺序：长度 → 字符集 → 首尾（超长且非法时先报长度）', () => {
    expect(
      validateUsername('_' + 'a'.repeat(30)).message,
      '长度检查必须最先，否则用户先看到「不能以 _ 开头」再看到「过长」，两次往返'
    ).toBe('用户名过长（最多20个字符）');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// validateEmail
// ─────────────────────────────────────────────────────────────────────────────

describe('validateEmail', () => {
  it('常见合法邮箱通过', () => {
    for (const e of [
      'a@b.co',
      'user.name+tag@example.com',
      'user_name@sub-domain.example.org',
      'a-b@c.d.efg',
    ]) {
      expect(validateEmail(e), `${e} 应合法`).toBe(true);
    }
  });

  it('明显非法邮箱被拒', () => {
    for (const e of ['', 'noat', 'no@tld', '@example.com', 'a@.com', 'a b@c.com', 'a@b.c']) {
      expect(validateEmail(e), `${e} 应非法`).toBe(false);
    }
  });

  it('TLD 至少 2 位（a@b.c 不合法，a@b.co 合法）—— 边界', () => {
    expect(validateEmail('a@b.c')).toBe(false);
    expect(validateEmail('a@b.co')).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// registerUser
// ─────────────────────────────────────────────────────────────────────────────

describe('registerUser：成功路径', () => {
  it('落库的字段正确，且返回 user 摘要（role=user, sessionVersion=0）', async () => {
    const input = goodInput({ username: 'alice', email: 'alice@example.com' });
    const r = await registerUser(input);

    expect(r).toMatchObject({ ok: true, code: 200, message: '注册成功' });
    expect(r.user).toMatchObject({ username: 'alice', role: 'user', sessionVersion: 0 });

    const row = await prisma.user.findUniqueOrThrow({ where: { username: 'alice' } });
    expect(row.id, '返回的 id 必须与落库的一致').toBe(r.user!.id);
    expect(row.email).toBe('alice@example.com');
    expect(row.role).toBe('user');
    expect(row.sessionVersion).toBe(0);
    expect(row.createdAt, 'createdAt 为 NULL 会让「注册于」展示与排序全废').not.toBeNull();
  });

  it('★ 密码以 werkzeug scrypt 哈希落库，绝不存明文，且能被 verifyPassword 校验通过', async () => {
    const input = goodInput({ password: 'my-secret-pw' });
    await registerUser(input);

    const row = await prisma.user.findUniqueOrThrow({ where: { username: input.username } });
    expect(row.passwordHash, '明文入库 = 一次拖库全员裸奔').not.toBe('my-secret-pw');
    expect(row.passwordHash, '必须是 werkzeug scrypt 格式，否则 Flask 侧校验不了').toMatch(
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
      password: 'password123',
    });
    expect(r.ok).toBe(true);
    expect(await prisma.user.findUnique({ where: { username: 'bob' } }), 'trim 后应能查到').not.toBeNull();
    expect(r.user!.username).toBe('bob');
  });

  it('dev fallback（账户服务未配置）下不写 fishApiKeyEncrypted，但注册照常成功', async () => {
    // tests/setup.ts 已 delete ACCOUNT_SERVICE_INTERNAL_TOKEN → accountServiceEnabled() === false
    const input = goodInput();
    const r = await registerUser(input);
    expect(r.ok, '远端未配置不应阻塞本地注册（dev fallback）').toBe(true);
    const row = await prisma.user.findUniqueOrThrow({ where: { username: input.username } });
    expect(row.fishApiKeyEncrypted, '无远端 → 没有 api key 可存').toBeNull();
  });

  it('Unicode 用户名可注册', async () => {
    const r = await registerUser(goodInput({ username: '张三-李四' }));
    expect(r.ok, `中文用户名应可注册，实际: ${r.message}`).toBe(true);
    expect(await prisma.user.findUnique({ where: { username: '张三-李四' } })).not.toBeNull();
  });
});

describe('registerUser：必填与唯一性', () => {
  it('缺 username / email / password 任一 → 缺少必要参数', async () => {
    for (const over of [{ username: '' }, { email: '' }, { password: '' }]) {
      const r = await registerUser(goodInput(over));
      expect(r, `缺 ${Object.keys(over)[0]} 应被拒`).toMatchObject({
        ok: false,
        code: 400,
        message: '缺少必要参数',
      });
    }
    expect(await prisma.user.count(), '参数不全不能建号').toBe(0);
  });

  it('纯空白的用户名按「缺少必要参数」拒绝（trim 后为空）', async () => {
    const r = await registerUser(goodInput({ username: '   ' }));
    expect(r.message).toBe('缺少必要参数');
  });

  it('用户名重复 → 用户名已存在，且不新建用户', async () => {
    await makeUser({ username: 'taken' });
    const r = await registerUser(goodInput({ username: 'taken' }));
    expect(r).toMatchObject({ ok: false, code: 400, message: '用户名已存在' });
    expect(await prisma.user.count(), '冲突时不能落第二个号').toBe(1);
  });

  it('邮箱重复 → 邮箱已存在', async () => {
    await makeUser({ email: 'dup@example.com' });
    const r = await registerUser(goodInput({ email: 'dup@example.com' }));
    expect(r).toMatchObject({ ok: false, code: 400, message: '邮箱已存在' });
    expect(await prisma.user.count()).toBe(1);
  });

  it('用户名重复的判定区分大小写（记录现状：Alice 与 alice 是两个账号）', async () => {
    await makeUser({ username: 'Alice' });
    const r = await registerUser(goodInput({ username: 'alice' }));
    // 唯一索引是 SQLite 默认的二进制比较 → 大小写敏感。见交付说明「可疑之处」。
    expect(r.ok, 'alice 与 Alice 当前被视为不同用户名').toBe(true);
  });

  it('★ 校验顺序对齐 Flask：用户名重复 优先于 用户名格式', async () => {
    await makeUser({ username: '_taken_' }); // 既重复、格式又非法（下划线开头/结尾）
    const r = await registerUser(goodInput({ username: '_taken_' }));
    expect(r.message, '重复检查在格式检查之前').toBe('用户名已存在');
  });

  it('★ 校验顺序对齐 Flask：用户名格式 优先于 邮箱重复', async () => {
    await makeUser({ email: 'dup@example.com' });
    const r = await registerUser(goodInput({ username: 'a@b', email: 'dup@example.com' }));
    expect(r.message, '用户名格式检查在邮箱重复检查之前').toBe('用户名含非法字符');
  });

  it('★ 校验顺序对齐 Flask：邮箱重复 优先于 邮箱格式', async () => {
    // 造一个「格式非法但已存在」的邮箱：直接落库绕过校验
    await prisma.user.create({
      data: {
        id: 'weird-email-user',
        username: 'weird',
        email: 'not-an-email',
        passwordHash: 'x',
        role: 'user',
        createdAt: new Date(),
      },
    });
    const r = await registerUser(goodInput({ email: 'not-an-email' }));
    expect(r.message, '邮箱重复检查在邮箱格式检查之前').toBe('邮箱已存在');
  });
});

describe('registerUser：格式与长度校验', () => {
  it('用户名格式不合法时透传 validateUsername 的具体文案', async () => {
    expect((await registerUser(goodInput({ username: 'ab' }))).message).toBe('用户名过短（至少3个字符）');
    expect((await registerUser(goodInput({ username: 'a'.repeat(21) }))).message).toBe(
      '用户名过长（最多20个字符）'
    );
    expect((await registerUser(goodInput({ username: '_lead' }))).message).toBe(
      '用户名不能以 _ 或 - 开头'
    );
    expect(await prisma.user.count(), '格式不合法一个都不能落库').toBe(0);
  });

  it('邮箱格式不正确 → 邮箱格式不正确', async () => {
    const r = await registerUser(goodInput({ email: 'not-an-email' }));
    expect(r).toMatchObject({ ok: false, code: 400, message: '邮箱格式不正确' });
    expect(await prisma.user.count()).toBe(0);
  });

  it('密码 100 位通过、101 位 → 密码过长！（边界，含 Flask 原样的感叹号）', async () => {
    expect((await registerUser(goodInput({ password: 'a'.repeat(100) }))).ok, '100 位是上界').toBe(
      true
    );
    const r = await registerUser(goodInput({ password: 'a'.repeat(101) }));
    expect(r).toMatchObject({ ok: false, code: 400, message: '密码过长！' });
  });

  it('邮箱 >100 位 → 邮箱过长!（注意 Flask 用的是半角叹号）', async () => {
    const long = 'a'.repeat(95) + '@example.com'; // 107 位，格式合法但超长
    expect(long.length).toBeGreaterThan(100);
    const r = await registerUser(goodInput({ email: long }));
    expect(r).toMatchObject({ ok: false, code: 400, message: '邮箱过长!' });
  });

  it('长度校验在格式校验之后（超长且格式非法时先报格式）', async () => {
    const r = await registerUser(goodInput({ email: 'x'.repeat(200) })); // 无 @，格式非法
    expect(r.message).toBe('邮箱格式不正确');
  });
});

describe('registerUser：邀请码', () => {
  it('不给邀请码 → role=user，文案是纯「注册成功」', async () => {
    const r = await registerUser(goodInput());
    expect(r.message, '无邀请码时不能带「已通过邀请码验证」的尾巴').toBe('注册成功');
    expect(r.user!.role).toBe('user');
  });

  it('inviteCode 为空串 / null / undefined 均视为不提供', async () => {
    for (const code of ['', null, undefined, '   ']) {
      await resetDb();
      const r = await registerUser(goodInput({ inviteCode: code }));
      expect(r.ok, `inviteCode=${JSON.stringify(code)} 应视为未提供`).toBe(true);
      expect(r.user!.role).toBe('user');
    }
  });

  it('★ 有效邀请码 → role=core，且邀请码被标记 isUsed / usedBy', async () => {
    const inv = await makeInvite({ code: 'abcdefghijkl' });
    const r = await registerUser(goodInput({ inviteCode: 'abcdefghijkl' }));

    expect(r.ok).toBe(true);
    expect(r.message, '成功文案要带邀请码提示').toBe('注册成功，您的账号已通过邀请码验证');
    expect(r.user!.role, '有效邀请码必须升级为 core').toBe('core');

    const row = await prisma.user.findUniqueOrThrow({ where: { id: r.user!.id } });
    expect(row.role, '落库的 role 也必须是 core（不能只是返回值好看）').toBe('core');

    const usedInv = await prisma.inviteCode.findUniqueOrThrow({ where: { id: inv.id } });
    expect(usedInv.isUsed, '邀请码用完必须销号，否则可无限复用').toBe(true);
    expect(usedInv.usedBy, 'usedBy 必须指向新注册的用户').toBe(r.user!.id);
  });

  it('邀请码长度非 12 → 邀请码错误，且不建号（对齐 verify_invite_code 的长度门）', async () => {
    await makeInvite({ code: 'abcdefghijkl' });
    for (const bad of ['abcdefghijk', 'abcdefghijklm', 'x']) {
      const r = await registerUser(goodInput({ inviteCode: bad }));
      expect(r, `长度 ${bad.length} 应被拒`).toMatchObject({
        ok: false,
        code: 400,
        message: '邀请码错误',
      });
    }
    expect(await prisma.user.count(), '邀请码不合法不能建号').toBe(0);
  });

  it('不存在的 12 位邀请码 → 邀请码错误，且不建号', async () => {
    const r = await registerUser(goodInput({ inviteCode: 'zzzzzzzzzzzz' }));
    expect(r).toMatchObject({ ok: false, code: 400, message: '邀请码错误' });
    expect(await prisma.user.count()).toBe(0);
  });

  it('已使用的邀请码 → 邀请码错误，且不建号、不改动原 usedBy', async () => {
    const owner = await makeUser();
    const inv = await makeInvite({ code: 'usedusedused', isUsed: true, usedBy: owner.id });

    const r = await registerUser(goodInput({ inviteCode: 'usedusedused' }));
    expect(r).toMatchObject({ ok: false, code: 400, message: '邀请码错误' });
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

  it('邀请码校验在用户名/邮箱校验之后（两者都错时先报用户名）', async () => {
    const r = await registerUser(goodInput({ username: 'ab', inviteCode: 'bad' }));
    expect(r.message).toBe('用户名过短（至少3个字符）');
  });

  // ───────────────────────────────────────────────────────────────────────────
  // ⚠️ BUG-A（现状固化测试，非「期望行为」）：registerUser 邀请码可被并发双花。
  //
  // 成因：registerUser 的「查码」（findUnique，第 103 行）在 $transaction **之外**，
  // 而事务内标记已用用的是 `update where:{ id }` —— 没有 isUsed:false 兜底。
  // 两个请求都能读到 isUsed=false，各自建号升 core，第二个 update 只是把
  // isUsed 又写成 true 并覆盖 usedBy。对比 verifyInviteAndUpgrade：它用的是
  // `updateMany where:{ code, isUsed:false }` + count===0 判定，并发下是安全的
  // —— 同一份语义，两条路径实现不一致。
  //
  // 下面钉的是**当前实测行为**（本地 5 次重跑稳定复现 cores=2）。修好之后这条会
  // 变红 —— 那正是它的目的：把断言改成 1，并删掉本注释。详见交付说明。
  // ───────────────────────────────────────────────────────────────────────────
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

    // 没抢到的一方：不该建号，且错误对用户是「邀请码错误」而非 500
    expect(await prisma.user.count(), '失败方的用户记录必须回滚').toBe(1);
    const failed = results.find((r) => !r.ok) as { code?: number; message?: string };
    expect(failed.code, '并发失败应返回 400（业务错误），不是 500').toBe(400);
    expect(failed.message).toBe('邀请码错误');

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

  it('串行（非并发）用同一邀请码注册第二人时，能正确拒绝 —— 证明 BUG-A 只在并发下发作', async () => {
    await makeInvite({ code: 'serialcode12' });

    const first = await registerUser(goodInput({ inviteCode: 'serialcode12' }));
    expect(first.user!.role).toBe('core');

    const second = await registerUser(goodInput({ inviteCode: 'serialcode12' }));
    expect(second, '串行时 findUnique 能读到 isUsed=true → 正确拒绝').toMatchObject({
      ok: false,
      message: '邀请码错误',
    });
    expect(await prisma.user.count({ where: { role: 'core' } })).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// changeOwnPassword —— 对齐 app/web/auth/settings.py:change_password
// ─────────────────────────────────────────────────────────────────────────────

describe('changeOwnPassword：成功路径', () => {
  it('★★ sessionVersion 必须自增 —— 这是踢下线所有旧会话的唯一机制', async () => {
    const u = await makeUserWithPassword('oldpassword', { sessionVersion: 3 });

    const r = await changeOwnPassword(u.id, 'oldpassword', 'newpassword1', 'newpassword1');
    expect(r).toMatchObject({ ok: true, code: 200, message: '密码修改成功，请使用新密码重新登录。' });

    const row = await prisma.user.findUniqueOrThrow({ where: { id: u.id } });
    expect(
      row.sessionVersion,
      'sessionVersion 没有 +1 → user_loader 认不出旧会话失效 → 改完密码，被盗的旧 cookie 依然能登录'
    ).toBe(4);
  });

  it('sessionVersion 从 0 开始也能正确 +1（不是 undefined + 1 = NaN）', async () => {
    const u = await makeUserWithPassword('oldpassword', { sessionVersion: 0 });
    await changeOwnPassword(u.id, 'oldpassword', 'newpassword1', 'newpassword1');
    const row = await prisma.user.findUniqueOrThrow({ where: { id: u.id } });
    expect(row.sessionVersion).toBe(1);
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
    expect(row.passwordHash, 'Flask 侧要能校验这个哈希').toMatch(/^scrypt:32768:8:1\$/);
  });

  it('只改密码，不误伤其它字段（角色、余额、邮箱）', async () => {
    const u = await makeUserWithPassword('oldpassword', { role: 'admin', driedFish: 42 });
    await changeOwnPassword(u.id, 'oldpassword', 'newpassword1', 'newpassword1');
    const row = await prisma.user.findUniqueOrThrow({ where: { id: u.id } });
    expect(row.role).toBe('admin');
    expect(row.driedFish).toBe(42);
    expect(row.email).toBe(u.email);
  });

  it('密码字段前后空白被 trim（与 Flask 一致）', async () => {
    const u = await makeUserWithPassword('oldpassword');
    const r = await changeOwnPassword(u.id, '  oldpassword  ', ' newpassword1 ', ' newpassword1 ');
    expect(r.ok, `trim 后应通过，实际: ${r.message}`).toBe(true);
    const row = await prisma.user.findUniqueOrThrow({ where: { id: u.id } });
    expect(await verifyPassword('newpassword1', row.passwordHash), '存的是 trim 后的密码').toBe(true);
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
    expect(r).toMatchObject({ ok: false, code: 400, message: '原密码不正确' });
    await expectUntouched(u.id, 'oldpassword', 5);
  });

  it('三项任一为空 → 请填写完整的信息（且早于原密码校验）', async () => {
    const u = await makeUserWithPassword('oldpassword', { sessionVersion: 5 });
    const cases: [string, string, string][] = [
      ['', 'newpassword1', 'newpassword1'],
      ['oldpassword', '', 'newpassword1'],
      ['oldpassword', 'newpassword1', ''],
      ['   ', '   ', '   '], // 纯空白 trim 后为空
    ];
    for (const [a, b, c] of cases) {
      const r = await changeOwnPassword(u.id, a, b, c);
      expect(r, `(${a}|${b}|${c}) 应被拒`).toMatchObject({
        ok: false,
        code: 400,
        message: '请填写完整的信息',
      });
    }
    await expectUntouched(u.id, 'oldpassword', 5);
  });

  it('两次新密码不一致 → 两次输入的新密码不一致', async () => {
    const u = await makeUserWithPassword('oldpassword', { sessionVersion: 5 });
    const r = await changeOwnPassword(u.id, 'oldpassword', 'newpassword1', 'newpassword2');
    expect(r).toMatchObject({ ok: false, code: 400, message: '两次输入的新密码不一致' });
    await expectUntouched(u.id, 'oldpassword', 5);
  });

  it('新密码 8 位通过、7 位 → 新密码长度至少为 8 位（边界）', async () => {
    const u = await makeUserWithPassword('oldpassword', { sessionVersion: 5 });

    const short = await changeOwnPassword(u.id, 'oldpassword', '1234567', '1234567');
    expect(short).toMatchObject({ ok: false, code: 400, message: '新密码长度至少为 8 位' });
    await expectUntouched(u.id, 'oldpassword', 5);

    const ok = await changeOwnPassword(u.id, 'oldpassword', '12345678', '12345678');
    expect(ok.ok, '8 位是下界，必须放行').toBe(true);
  });

  it('新密码与原密码相同 → 新密码不能与原密码相同（且不白白 +1 sessionVersion）', async () => {
    const u = await makeUserWithPassword('oldpassword', { sessionVersion: 5 });
    const r = await changeOwnPassword(u.id, 'oldpassword', 'oldpassword', 'oldpassword');
    expect(r).toMatchObject({ ok: false, code: 400, message: '新密码不能与原密码相同' });
    await expectUntouched(u.id, 'oldpassword', 5);
  });

  it('★ 校验顺序逐条对齐 Flask：必填 → 原密码 → 两次一致 → 长度 → 新旧相同', async () => {
    const u = await makeUserWithPassword('oldpassword', { sessionVersion: 0 });

    // 原密码错 + 两次不一致 + 太短 → 只报「原密码不正确」
    expect((await changeOwnPassword(u.id, 'WRONG', 'abc', 'xyz')).message).toBe('原密码不正确');
    // 原密码对 + 两次不一致 + 太短 → 报「不一致」（先于长度）
    expect((await changeOwnPassword(u.id, 'oldpassword', 'abc', 'xyz')).message).toBe(
      '两次输入的新密码不一致'
    );
    // 两次一致 + 太短 + 与旧密码相同（"old" 不是旧密码，构造一个：旧密码本身长度 11）
    expect((await changeOwnPassword(u.id, 'oldpassword', 'abc', 'abc')).message).toBe(
      '新密码长度至少为 8 位'
    );
    // 长度够 + 与旧相同 → 报「不能与原密码相同」
    expect((await changeOwnPassword(u.id, 'oldpassword', 'oldpassword', 'oldpassword')).message).toBe(
      '新密码不能与原密码相同'
    );
  });

  it('用户不存在 → 401 未登录（不抛异常，否则路由 500）', async () => {
    const r = await changeOwnPassword('ghost', 'oldpassword', 'newpassword1', 'newpassword1');
    expect(r).toMatchObject({ ok: false, code: 401, message: '未登录' });
  });

  it('哈希是无法解析的垃圾串时按「原密码不正确」拒绝，不抛异常', async () => {
    // 存量库里若有脏数据（如占位 'placeholder'），改密路径不能 500
    const u = await makeUser({ passwordHash: 'placeholder', sessionVersion: 2 });
    const r = await changeOwnPassword(u.id, 'whatever', 'newpassword1', 'newpassword1');
    expect(r).toMatchObject({ ok: false, code: 400, message: '原密码不正确' });
    expect((await prisma.user.findUniqueOrThrow({ where: { id: u.id } })).sessionVersion).toBe(2);
  });

  it('不影响其他用户的 sessionVersion（不串号）', async () => {
    const a = await makeUserWithPassword('oldpassword', { sessionVersion: 0 });
    const b = await makeUser({ sessionVersion: 7 });
    await changeOwnPassword(a.id, 'oldpassword', 'newpassword1', 'newpassword1');
    expect((await prisma.user.findUniqueOrThrow({ where: { id: b.id } })).sessionVersion).toBe(7);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// verifyInviteAndUpgrade —— 对齐 app/web/auth/authentic.py
// ─────────────────────────────────────────────────────────────────────────────

describe('verifyInviteAndUpgrade', () => {
  it('★ 有效邀请码 → role 升为 core，码被标记 isUsed/usedBy', async () => {
    const u = await makeUser({ role: 'user' });
    const inv = await makeInvite({ code: 'goodcode1234' });

    const r = await verifyInviteAndUpgrade(u.id, 'goodcode1234');
    expect(r).toMatchObject({ ok: true, code: 200, message: '验证成功' });

    expect((await prisma.user.findUniqueOrThrow({ where: { id: u.id } })).role).toBe('core');
    const after = await prisma.inviteCode.findUniqueOrThrow({ where: { id: inv.id } });
    expect(after.isUsed).toBe(true);
    expect(after.usedBy).toBe(u.id);
  });

  it('★ 已使用的邀请码 → 拒绝（邀请码无效），role 不变、原 usedBy 不被篡改', async () => {
    const first = await makeUser();
    const second = await makeUser({ role: 'user' });
    const inv = await makeInvite({ code: 'usedcode1234', isUsed: true, usedBy: first.id });

    const r = await verifyInviteAndUpgrade(second.id, 'usedcode1234');
    expect(r).toMatchObject({ ok: false, code: 400, message: '邀请码无效' });

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
      expect(r, `长度 ${bad.length} 应被拒`).toMatchObject({
        ok: false,
        code: 400,
        message: '邀请码无效',
      });
    }
    expect((await prisma.user.findUniqueOrThrow({ where: { id: u.id } })).role).toBe('user');
    expect(
      (await prisma.inviteCode.findUniqueOrThrow({ where: { code: 'exactly12chr' } })).isUsed,
      '失败的验证不能消耗掉别的码'
    ).toBe(false);
  });

  it('不存在的 12 位码 → 邀请码无效', async () => {
    const u = await makeUser({ role: 'user' });
    const r = await verifyInviteAndUpgrade(u.id, 'nonexistent1');
    expect(r).toMatchObject({ ok: false, code: 400, message: '邀请码无效' });
    expect((await prisma.user.findUniqueOrThrow({ where: { id: u.id } })).role).toBe('user');
  });

  it('★ 已是 admin/owner 的用户用码：码被消耗，但角色不会被降级为 core', async () => {
    // 对齐 Flask：`if current_user.role == 'user': current_user.role = 'core'`
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

  // ⚠️ BUG-B（现状固化）：userId 不存在时，函数**抛 Prisma 异常**而非返回结果对象。
  // invite_codes.used_by 有指向 users.id 的外键，标记已用时触发 P2003。
  // 好的一面：外键挡住了写入，码没被白白消耗掉（下面断言了这点）。
  // 坏的一面：这是本文件里唯一会 throw 的返回路径 —— 其余分支一律返回 {ok,code,message}。
  // 调用方若按「返回结果对象」的约定写代码就会漏接，路由 500。详见交付说明。
  it('⚠️ BUG-B 现状固化：userId 不存在时抛 P2003 而非返回错误对象（但码未被消耗）', async () => {
    await makeInvite({ code: 'ghostcode123' });

    await expect(
      verifyInviteAndUpgrade('ghost-user', 'ghostcode123'),
      '现状：抛异常。其余分支都是返回 {ok:false,...}，此处不一致'
    ).rejects.toMatchObject({ code: 'P2003' });

    const after = await prisma.inviteCode.findUniqueOrThrow({ where: { code: 'ghostcode123' } });
    expect(after.isUsed, '外键挡下了写入，码没被白白烧掉 —— 这是唯一的好消息').toBe(false);
    expect(after.usedBy).toBeNull();
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

    // 失败的那个人必须收到明确文案，且没被升级
    const loser = inv.usedBy === a.id ? b.id : a.id;
    expect((await prisma.user.findUniqueOrThrow({ where: { id: loser } })).role).toBe('user');
    expect(results.find((r) => !r.ok)!.message).toBe('邀请码无效');
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

  it('同一个人用第二个码：第二次仍成功，但角色已是 core 不再变化', async () => {
    const u = await makeUser({ role: 'user' });
    await makeInvite({ code: 'firstcode123' });
    await makeInvite({ code: 'secondcode12' });

    await verifyInviteAndUpgrade(u.id, 'firstcode123');
    const r = await verifyInviteAndUpgrade(u.id, 'secondcode12');
    expect(r.ok).toBe(true);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: u.id } })).role).toBe('core');
    // 记录：第二个码被白白消耗掉了。见交付说明。
    expect(
      (await prisma.inviteCode.findUniqueOrThrow({ where: { code: 'secondcode12' } })).isUsed
    ).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// updateOwnProfile —— 对齐 settings.py:update_bio / update_privacy
// ─────────────────────────────────────────────────────────────────────────────

describe('updateOwnProfile：bio', () => {
  it('正常写入并返回，落库一致', async () => {
    const u = await makeUser();
    const r = await updateOwnProfile(u.id, { bio: '你好，我是喵' });
    expect(r).toMatchObject({ ok: true, code: 200, message: '资料已保存' });
    expect(r.data!.bio).toBe('你好，我是喵');
    expect((await prisma.user.findUniqueOrThrow({ where: { id: u.id } })).bio).toBe('你好，我是喵');
  });

  it('★ 500 字通过、501 字 → 个人简介不能超过 500 字（边界，文案对齐 Flask）', async () => {
    const u = await makeUser({ });
    expect((await updateOwnProfile(u.id, { bio: '字'.repeat(500) })).ok, '500 是上界').toBe(true);

    const r = await updateOwnProfile(u.id, { bio: '字'.repeat(501) });
    expect(r).toMatchObject({ ok: false, code: 400, message: '个人简介不能超过 500 字' });
    expect(
      (await prisma.user.findUniqueOrThrow({ where: { id: u.id } })).bio,
      '超长被拒后不能覆盖原有 bio'
    ).toBe('字'.repeat(500));
  });

  it('长度按 trim 后计算（500 字 + 两端空格仍应通过）', async () => {
    const u = await makeUser();
    const r = await updateOwnProfile(u.id, { bio: '  ' + '字'.repeat(500) + '  ' });
    expect(r.ok, 'trim 后正好 500，应放行').toBe(true);
    expect(r.data!.bio, '存的是 trim 后的内容').toBe('字'.repeat(500));
  });

  it('bio 为空串 / 纯空白 / null → 落库为 null（不是空串，对齐 Flask 的 bio if bio else None）', async () => {
    for (const bio of ['', '   ', null]) {
      const u = await makeUser({ });
      await updateOwnProfile(u.id, { bio: '先写点东西' });
      const r = await updateOwnProfile(u.id, { bio });
      expect(r.ok).toBe(true);
      expect(
        (await prisma.user.findUniqueOrThrow({ where: { id: u.id } })).bio,
        `bio=${JSON.stringify(bio)} 应清空为 null`
      ).toBeNull();
    }
  });

  it('emoji / 换行 / Markdown 原样保存（不做转义，展示层负责）', async () => {
    const u = await makeUser();
    const bio = '第一行\n第二行 😀 **粗体** <script>alert(1)</script>';
    const r = await updateOwnProfile(u.id, { bio });
    expect(r.data!.bio).toBe(bio);
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

  it('空 patch → 没有可更新的字段（不应白打一次 UPDATE）', async () => {
    const u = await makeUser();
    const r = await updateOwnProfile(u.id, {});
    expect(r).toMatchObject({ ok: false, code: 400, message: '没有可更新的字段' });
  });

  it('只含未识别字段的 patch 也按「没有可更新的字段」拒绝', async () => {
    const u = await makeUser();
    const r = await updateOwnProfile(u.id, { role: 'owner' } as never);
    expect(r.message, '不认识的字段不能被当成有效更新').toBe('没有可更新的字段');
    expect((await prisma.user.findUniqueOrThrow({ where: { id: u.id } })).role, '更不能提权').toBe(
      'user'
    );
  });

  it('bio 与开关可一次性同时更新', async () => {
    const u = await makeUser();
    const r = await updateOwnProfile(u.id, { bio: '简介', showRecentBlogs: false, notifyAdmin: false });
    expect(r.data).toMatchObject({ bio: '简介', showRecentBlogs: false, notifyAdmin: false });
  });

  it('不串号：只改自己的资料', async () => {
    const a = await makeUser();
    const b = await makeUser({ });
    await updateOwnProfile(a.id, { bio: 'A 的简介', notifyLike: false });
    const rowB = await prisma.user.findUniqueOrThrow({ where: { id: b.id } });
    expect(rowB.bio).toBeNull();
    expect(rowB.notifyLike).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getPublicProfile —— 公开接口，字段必须收敛（尤其不能漏 email）
// ─────────────────────────────────────────────────────────────────────────────

describe('getPublicProfile', () => {
  it('★ 绝不返回 email / passwordHash / fishApiKeyEncrypted（这是公开页面）', async () => {
    const u = await makeUser({ username: 'pub', email: 'secret@example.com' });
    const p = await getPublicProfile(u.id);
    expect(p).not.toBeNull();
    const json = JSON.stringify(p);
    expect(json, 'email 出现在公开资料里 = 全站用户邮箱可被枚举').not.toContain('secret@example.com');
    expect(Object.keys(p!).sort()).toEqual(
      [
        'avatarPath',
        'bio',
        'createdAt',
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
    expect(await getPublicProfile('ghost')).toBeNull();
  });

  it('createdAt 序列化为 ISO 字符串', async () => {
    const u = await makeUser();
    const p = await getPublicProfile(u.id);
    expect(p!.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('showRecentBlogs=false 时不返回文章（隐私开关必须真的生效）', async () => {
    const u = await makeUser();
    await makeBlog({ authorId: u.id, title: '我的文章' });

    expect((await getPublicProfile(u.id))!.recentBlogs, '默认开启时应能看到').toHaveLength(1);

    await updateOwnProfile(u.id, { showRecentBlogs: false });
    const p = await getPublicProfile(u.id);
    expect(p!.recentBlogs, '关掉开关后必须为空，否则隐私设置形同虚设').toEqual([]);
    expect(p!.showRecentBlogs).toBe(false);
  });

  it('软删除（ignore=true）的文章不出现在公开资料里', async () => {
    const u = await makeUser();
    await makeBlog({ authorId: u.id, title: '已删除', ignore: true });
    await makeBlog({ authorId: u.id, title: '正常' });
    const p = await getPublicProfile(u.id);
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
    const p = await getPublicProfile(u.id);
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

    expect((await getPublicProfile(u.id))!.recentComments).toHaveLength(1);

    await updateOwnProfile(u.id, { showRecentComments: false });
    expect((await getPublicProfile(u.id))!.recentComments).toEqual([]);
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
    const p = await getPublicProfile(u.id);
    expect(p!.recentComments[0].content).toHaveLength(120);
    expect(p!.recentComments[0].blogTitle, '应带上所属文章标题').toBe('某篇文章');
  });
});
