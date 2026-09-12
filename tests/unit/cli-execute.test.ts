// ─────────────────────────────────────────────────────────────────────────────
// cli-execute.test.ts —— 确认闸：两条前端共用的执行尾段
//
// 【为什么这是 CLI 里最值得测的一块】「Ctrl-C / 用户拒绝时绝不留下半完成的写」
// 这条保证，全靠这里：唯一的写库点 run() 必须在确认闸**之后**。测法很直接 ——
// 用一个假的 Prompter 让确认返回 false，然后断言 run() 一次都没被调用。
//
// 另一条同样重要的顺序：预检（describe）要跑在确认之前。「用户不存在」这类真问题
// 必须先报出来，而不是先报「请加 --yes」—— 否则运维会加了 --yes 重跑、再被拒一次。
//
// 这里不需要 TTY，也不需要真数据库：executeCommand 只依赖注入进来的 deps。
// ─────────────────────────────────────────────────────────────────────────────

import { describe, expect, it, vi } from 'vitest';
import { executeCommand, isDangerous, type ExecuteDeps } from '../../scripts/cli/execute';
import type { Prompter } from '../../scripts/cli/prompt';
import { CliError, type Args, type CommandSpec, type Output } from '../../scripts/cli/types';

// ── 测试替身 ─────────────────────────────────────────────────────────────────

/** 收集输出但不真写终端。 */
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

/** 只实现 confirm 的假 Prompter；其余方法在本文件里用不到。 */
function fakePrompter(answer: boolean): Prompter & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    confirm: async (m) => {
      asked.push(m);
      return answer;
    },
    text: async () => '',
    num: async () => 0,
    pick: async () => '',
    secret: async () => '',
  };
}

function deps(over: Partial<ExecuteDeps> = {}): ExecuteDeps & { io: ReturnType<typeof fakeIo> } {
  const io = fakeIo();
  return {
    // 命令不碰 prisma 时不需要真客户端；这里给个空壳即可
    prisma: {} as ExecuteDeps['prisma'],
    io,
    prompter: fakePrompter(true),
    actor: null,
    interactive: false,
    yes: false,
    ...over,
  } as ExecuteDeps & { io: ReturnType<typeof fakeIo> };
}

type Spy = ReturnType<typeof vi.fn>;

/**
 * 造一条命令：记录 run / describe 是否被调用，两者都可覆盖。
 *
 * 返回的是**cmd 上实际生效**的那两个函数（而不是这里的局部变量）——
 * 覆盖时若返回局部变量，断言就会落在一个从没被调用的 spy 上。
 */
function makeCmd(over: Partial<CommandSpec> = {}) {
  const cmd = {
    name: 'demo run',
    summary: '测试命令',
    group: 'stats',
    args: [],
    danger: 'destructive',
    describe: vi.fn(async () => ['变更：user → core']),
    run: vi.fn(async () => ({ lines: ['done'] })),
    ...over,
  } as CommandSpec;
  return {
    cmd,
    run: cmd.run as unknown as Spy,
    // describe 可能被显式设为 undefined（测「没写预检」那条），所以不能假定它有值
    describe: cmd.describe as unknown as Spy,
  };
}

const ARGS: Args = {};

/** 断言 promise 以 CliError 拒绝，并把那个错误取回来做进一步断言。 */
async function expectRejection(p: Promise<unknown>): Promise<CliError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(CliError);
    return e as CliError;
  }
  throw new Error('预期抛出 CliError，但没有抛');
}

// ── 测试 ─────────────────────────────────────────────────────────────────────

describe('isDangerous', () => {
  it('safe 与未标注都不算危险', () => {
    expect(isDangerous(makeCmd({ danger: 'safe' }).cmd)).toBe(false);
    expect(isDangerous(makeCmd({ danger: undefined }).cmd)).toBe(false);
  });

  it('destructive 与 irreversible 都算危险', () => {
    expect(isDangerous(makeCmd({ danger: 'destructive' }).cmd)).toBe(true);
    expect(isDangerous(makeCmd({ danger: 'irreversible' }).cmd)).toBe(true);
  });
});

describe('确认闸：非交互模式（管道 / CI）', () => {
  it('★ 危险操作没有 --yes 时不执行，且退出码 1', async () => {
    const { cmd, run } = makeCmd();
    const d = deps({ interactive: false, yes: false });

    await expect(executeCommand(cmd, ARGS, d)).rejects.toBeInstanceOf(CliError);
    expect(run, '确认未通过却执行了写操作').not.toHaveBeenCalled();
  });

  it('拒绝时把「即将执行什么」一并报出来，而不是只丢一句要加 --yes', async () => {
    const { cmd } = makeCmd();
    const d = deps({ interactive: false, yes: false });

    const err = await expectRejection(executeCommand(cmd, ARGS, d));
    const all = [err.message, ...err.details].join('\n');
    expect(all).toContain('--yes');
    expect(all).toContain('user → core');
    expect(all).toContain('demo run');
  });

  it('★ 绝不因为缺 --yes 而去等 stdin（脚本会看起来像卡死）', async () => {
    const { cmd } = makeCmd();
    const prompter = fakePrompter(true);
    const d = deps({ interactive: false, yes: false, prompter });

    await expect(executeCommand(cmd, ARGS, d)).rejects.toBeInstanceOf(CliError);
    expect(prompter.asked, '非交互模式下不该弹任何提示').toEqual([]);
  });

  it('带 --yes 才执行', async () => {
    const { cmd, run } = makeCmd();
    const d = deps({ interactive: false, yes: true });

    const r = await executeCommand(cmd, ARGS, d);
    expect(r.output).not.toBeNull();
    expect(run).toHaveBeenCalledTimes(1);
  });
});

describe('确认闸：交互模式（TTY）', () => {
  it('★ 用户答 no → 不执行，且这是「取消」而不是错误（output 为 null）', async () => {
    const { cmd, run } = makeCmd();
    const d = deps({ interactive: true, yes: false, prompter: fakePrompter(false) });

    const r = await executeCommand(cmd, ARGS, d);
    expect(r.output, '取消不是一个结果，必须返回 null').toBeNull();
    expect(run, '用户拒绝了却执行了写操作').not.toHaveBeenCalled();
  });

  it('用户答 yes → 执行', async () => {
    const { cmd, run } = makeCmd();
    const d = deps({ interactive: true, yes: false, prompter: fakePrompter(true) });

    const r = await executeCommand(cmd, ARGS, d);
    expect(r.output).not.toBeNull();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('--yes 在交互模式下也直接放行，不弹提示', async () => {
    const { cmd, run } = makeCmd();
    const prompter = fakePrompter(true);
    const d = deps({ interactive: true, yes: true, prompter });

    await executeCommand(cmd, ARGS, d);
    expect(prompter.asked).toEqual([]);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('确认屏打到 stderr（stdout 留给命令结果）', async () => {
    const { cmd } = makeCmd();
    const d = deps({ interactive: true, prompter: fakePrompter(false) });

    await executeCommand(cmd, ARGS, d);
    expect(d.io.err.join('\n')).toContain('即将执行');
    expect(d.io.out).toEqual([]);
  });
});

describe('预检（describe）', () => {
  it('★ 预检跑在确认之前：真问题先报，而不是先要 --yes', async () => {
    const { cmd, run } = makeCmd({
      describe: async () => {
        throw new CliError('错误：用户 nobody 不存在');
      },
    });
    const d = deps({ interactive: false, yes: false });

    const err = await expectRejection(executeCommand(cmd, ARGS, d));
    expect(err.message).toContain('用户 nobody 不存在');
    expect(err.message).not.toContain('--yes');
    expect(run).not.toHaveBeenCalled();
  });

  it('describe 返回空数组 = 本次没有实际变更 → 跳过确认直接执行', async () => {
    const { cmd, run, describe } = makeCmd({ describe: vi.fn(async () => []) });
    const d = deps({ interactive: false, yes: false });

    const r = await executeCommand(cmd, ARGS, d);
    expect(describe).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledTimes(1);
    expect(r.output).not.toBeNull();
  });

  it('★ describe 缺席 ≠ 无变更：仍然要求确认，绝不静默放行', async () => {
    // 「describe 返回空数组」与「压根没写 describe」必须区分开：前者是命令明确
    // 声明「本次无事可做」，后者只是这条命令没人写后果说明。
    const { cmd, run } = makeCmd({ describe: undefined });
    const d = deps({ interactive: false, yes: false });

    await expect(executeCommand(cmd, ARGS, d)).rejects.toBeInstanceOf(CliError);
    expect(run, '没有后果说明的危险命令被静默执行了').not.toHaveBeenCalled();
  });

  it('describe 缺席 + --yes 仍可执行（逃生口留给明确知道自己在做什么的人）', async () => {
    const { cmd, run } = makeCmd({ describe: undefined });
    const d = deps({ interactive: false, yes: true });

    const r = await executeCommand(cmd, ARGS, d);
    expect(r.output).not.toBeNull();
    expect(run).toHaveBeenCalledTimes(1);
  });
});

describe('只读 / 安全命令', () => {
  it('非危险命令既不预检也不确认，直接执行', async () => {
    const { cmd, run, describe } = makeCmd({ danger: 'safe' });
    const prompter = fakePrompter(true);
    const d = deps({ interactive: true, yes: false, prompter });

    const r = await executeCommand(cmd, ARGS, d);
    expect(r.output).not.toBeNull();
    expect(describe, '安全命令不该跑预检').not.toHaveBeenCalled();
    expect(prompter.asked).toEqual([]);
    expect(run).toHaveBeenCalledTimes(1);
  });
});
