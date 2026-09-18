// ─────────────────────────────────────────────────────────────────────────────
// cli-wizard-loop.test.ts —— 交互式向导的菜单循环（对真实测试库）
//
// 【为什么要有这一层】逐参数收集已经在 tests/unit/cli-wizard.test.ts 里测透了，
// 但那条测试碰不到「菜单 → 选命令 → 执行 → 回菜单」这条主线，而这正是向导
// 与命令式前端真正不同的地方。
//
// 最关键的一条断言是**拒绝确认后库里没有任何改动** —— 那是「Ctrl-C / 拒绝
// 不会留下半完成的写」这条保证在集成层面的验证（单元层在 cli-execute.test.ts）。
//
// 不需要 TTY：向导只依赖 Prompter 接口，脚本化的假 Prompter 就能把整条流程走完。
// ─────────────────────────────────────────────────────────────────────────────

import { beforeEach, describe, expect, it } from 'vitest';
import { makeUser, prisma, resetDb } from '../helpers/db';
import { wizardLoop, type WizardDeps } from '../../scripts/cli/wizard';
import type { Prompter } from '../../scripts/cli/prompt';
import { NAV_CANCEL, type Output } from '../../scripts/cli/types';

type Step =
  | { text: string }
  | { pick: string }
  | { num: number }
  | { confirm: boolean }
  | { secret: string };
// 注意不能写 keyof Step —— 联合类型的 keyof 求的是**键的交集**，结果是 never。
type StepKind = 'text' | 'pick' | 'num' | 'confirm' | 'secret';

/** 脚本化的假 Prompter；脚本用尽或对不上类型时直接抛错，避免用例静默走偏。 */
function scripted(steps: Step[]) {
  const asked: string[] = [];
  let i = 0;
  const take = (kind: StepKind): unknown => {
    if (i >= steps.length) throw new Error(`脚本已用完：第 ${i + 1} 次提问（${kind}）没有预设答案`);
    const step = steps[i++] as Record<string, unknown>;
    if (!(kind in step)) throw new Error(`第 ${i} 次提问期望 ${kind}，脚本给的是 ${Object.keys(step)[0]}`);
    return step[kind];
  };
  const note = (m: string): void => void asked.push(m);
  const prompter: Prompter = {
    confirm: async (m) => (note(m), take('confirm') as boolean),
    text: async (m) => (note(m), take('text') as string),
    num: async (m) => (note(m), take('num') as number),
    pick: async (m) => (note(m), take('pick') as string),
    // 也要走脚本（不能恒返回 ''）：恒空串会让「必填密码」那题原地重问，测试直接挂死 ——
    // 挂死比报错难查得多。
    secret: async (m) => (note(m), take('secret') as string),
  };
  return { prompter, asked };
}

function fakeIo(): Output & { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    line: (s) => void out.push(s),
    error: (s) => void err.push(s),
    red: (s) => s,
    green: (s) => s,
    yellow: (s) => s,
    dim: (s) => s,
    width: () => 80,
  };
}

function deps(prompter: Prompter): WizardDeps & { io: ReturnType<typeof fakeIo> } {
  const io = fakeIo();
  return { prisma, io, prompter, as: null };
}

beforeEach(async () => {
  await resetDb();
});

describe('向导菜单循环', () => {
  it('选组 → 选命令 → 执行 → 回到菜单（而不是退出）', async () => {
    const s = scripted([
      { pick: 'g:oauth' },
      { pick: 'oauth list-apps' },
      { pick: 'quit' },
    ]);
    const d = deps(s.prompter);

    const code = await wizardLoop(d);

    expect(code).toBe(0);
    expect(d.io.out.join('\n')).toContain('暂无 OAuth 应用');
  });

  it('二级菜单按「返回上一步」→ 回到主菜单，不执行任何命令', async () => {
    const s = scripted([
      { pick: 'g:oauth' },
      { pick: NAV_CANCEL }, // 组内取消
      { pick: 'quit' }, // 若没回主菜单，这里就取不到值 → 脚本报错
    ]);
    expect(await wizardLoop(deps(s.prompter))).toBe(0);
  });

  it('「查看全部命令」打印帮助后回主菜单', async () => {
    const s = scripted([{ pick: 'help' }, { pick: 'quit' }]);
    const d = deps(s.prompter);
    await wizardLoop(d);
    expect(d.io.out.join('\n')).toContain('用法：npm run cli --');
  });
});

describe('向导里的写操作', () => {
  it('★ 危险操作被拒绝后，库里没有任何改动', async () => {
    await makeUser({ username: 'owner1', role: 'owner' });
    const target = await makeUser({ username: 'alice', role: 'user' });

    const s = scripted([
      { pick: 'g:roles' },
      { pick: 'promote-core' },
      { text: 'alice' }, // 用户名
      { confirm: false }, // 确认屏答 no
      { pick: 'quit' },
    ]);
    const d = deps(s.prompter);

    await wizardLoop(d);

    const after = await prisma.user.findUnique({ where: { id: target.id } });
    expect(after!.role, '拒绝了确认，角色却被改了').toBe('user');
    expect(d.io.err.join('\n')).toContain('已取消');
    // 拒绝不该产生审计日志
    expect(await prisma.adminActionLog.count({ where: { action: 'change_role' } })).toBe(0);
  });

  it('★ 确认后真的执行，并落一条审计日志（主体是库内站长）', async () => {
    const owner = await makeUser({ username: 'owner1', role: 'owner' });
    const target = await makeUser({ username: 'alice', role: 'user' });

    const s = scripted([
      { pick: 'g:roles' },
      { pick: 'promote-core' },
      { text: 'alice' },
      { confirm: true },
      { pick: 'quit' },
    ]);
    const d = deps(s.prompter);

    await wizardLoop(d);

    const after = await prisma.user.findUnique({ where: { id: target.id } });
    expect(after!.role).toBe('core');

    const log = await prisma.adminActionLog.findFirst({ where: { action: 'change_role' } });
    expect(log, '角色变更没有写审计日志').not.toBeNull();
    expect(log!.adminId, '审计主体应是库内站长').toBe(owner.id);
    expect(log!.targetUserId).toBe(target.id);
    // 直接调 wizardLoop（没圈 runAsBackendOps）= 网页端的写法，日志是**公开**的。
    // 「圈内变内部」那条在下面一条用例里钉 —— 两条合起来说明可见性跟着上下文走，
    // 而不是跟着命令走。
    expect(log!.visibility).toBe('public');
  });

  it('★ 后台运维上下文里的写操作落内部日志，不进 /audit 公示页', async () => {
    // scripts/cli.ts 把整轮执行圈进 runAsBackendOps（见 src/lib/audit-context.ts）。
    // 这里把那一圈补上，断言的是用户实际会得到的两个结果：库里留着痕、公示页看不到。
    const { runAsBackendOps } = await import('@/lib/audit-context');
    const { listPublicLogs } = await import('@/lib/audit-service');

    await makeUser({ username: 'owner1', role: 'owner' });
    await makeUser({ username: 'alice', role: 'user' });

    const s = scripted([
      { pick: 'g:roles' },
      { pick: 'promote-core' },
      { text: 'alice' },
      { confirm: true },
      { pick: 'quit' },
    ]);

    await runAsBackendOps(() => wizardLoop(deps(s.prompter)));

    const log = await prisma.adminActionLog.findFirst({ where: { action: 'change_role' } });
    expect(log, '后台运维也要留痕（不是干脆不记）').not.toBeNull();
    expect(log!.visibility).toBe('internal');
    expect((await listPublicLogs({})).items, '后台操作出现在公示页上了').toHaveLength(0);
  });

  it('★ 密码来源选「生成随机密码」→ 向导根本不该问新密码', async () => {
    // 回归：早先密码题的 prompt 是 password 类型，而那条分支不看「必填/可选」，
    // 于是选了 generate 也照样要人输密码，留空还会被「至少 8 位」打回来 ——
    // 唯一出口是 Ctrl-C。脚本里**没有 secret 步骤**：一旦问密码，假 Prompter
    // 就会以「第 N 次提问期望 secret」炸掉。
    await makeUser({ username: 'owner1', role: 'owner' });
    const target = await makeUser({ username: 'alice', role: 'core' });

    const s = scripted([
      { pick: 'g:users' },
      { pick: 'user reset-password' },
      { text: 'alice' }, // 搜用户名
      { pick: 'alice' }, // 从候选里挑（用户的 value 就是用户名）
      { pick: 'generate' }, // 密码来源
      { text: '用户申诉邮箱被盗' }, // 原因
      { confirm: true },
      { pick: 'quit' },
    ]);
    const d = deps(s.prompter);

    await wizardLoop(d);

    const after = await prisma.user.findUnique({ where: { id: target.id } });
    expect(after!.sessionVersion, '密码没有被重置').toBe((target.sessionVersion ?? 0) + 1);
    expect(d.io.out.join('\n')).toContain('新密码：'); // 生成的密码要显示一次
  });

  it('密码来源选「手动输入」→ 照常问密码（别把该问的也跳掉了）', async () => {
    await makeUser({ username: 'owner1', role: 'owner' });
    const target = await makeUser({ username: 'alice', role: 'core' });

    const s = scripted([
      { pick: 'g:users' },
      { pick: 'user reset-password' },
      { text: 'alice' },
      { pick: 'alice' },
      { pick: 'manual' },
      { secret: 'Hunter2Hunter2' },
      { text: '用户申诉邮箱被盗' },
      { confirm: true },
      { pick: 'quit' },
    ]);
    const d = deps(s.prompter);

    await wizardLoop(d);

    const after = await prisma.user.findUnique({ where: { id: target.id } });
    expect(after!.sessionVersion).toBe((target.sessionVersion ?? 0) + 1);
    expect(d.io.out.join('\n')).toContain('Hunter2Hunter2'); // 用的是手输的那个密码
  });

  it('确认屏里带上执行者与后果说明（不是笼统的「确定吗」）', async () => {
    await makeUser({ username: 'owner1', role: 'owner' });
    await makeUser({ username: 'alice', role: 'user' });

    const s = scripted([
      { pick: 'g:roles' },
      { pick: 'promote-core' },
      { text: 'alice' },
      { confirm: false },
      { pick: 'quit' },
    ]);
    const d = deps(s.prompter);
    await wizardLoop(d);

    const screen = d.io.err.join('\n');
    expect(screen).toContain('即将执行');
    expect(screen).toContain('owner1'); // 执行者
    expect(screen).toContain('user → core'); // 具体变更
    expect(screen).toContain('审计日志'); // 后果
  });
});
