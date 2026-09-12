// ─────────────────────────────────────────────────────────────────────────────
// cli-wizard.test.ts —— 交互式前端的逐参数引导
//
// 【为什么能这么测】向导只依赖 Prompter 接口，不直接碰 @inquirer/prompts。
// 于是一条「脚本化的假 Prompter」就能把整条流程跑进单测：不需要 TTY、
// 不需要模拟终端转义序列（那种测试既脆又其实在测库）。
//
// 这里钉的是向导独有的行为：返回/取消怎么传、必填为空怎么重问、
// 校验失败怎么原地纠正、「先搜后选」怎么串起来。
// 「取消时绝不执行写操作」在 cli-execute.test.ts 里钉。
// ─────────────────────────────────────────────────────────────────────────────

import { describe, expect, it } from 'vitest';
import { collectArgs, type WizardDeps } from '../../scripts/cli/wizard';
import type { Prompter } from '../../scripts/cli/prompt';
import {
  NAV_BACK,
  NAV_CANCEL,
  type ArgSpec,
  type Choice,
  type CommandSpec,
  type Output,
} from '../../scripts/cli/types';

// ── 测试替身 ─────────────────────────────────────────────────────────────────

type Step =
  | { text: string }
  | { pick: string }
  | { num: number }
  | { secret: string }
  | { confirm: boolean };

// 注意不能写 keyof Step —— 联合类型的 keyof 求的是**键的交集**，结果是 never。
type StepKind = 'text' | 'pick' | 'num' | 'secret' | 'confirm';

/** 脚本化的假 Prompter：按顺序吐出预设答案，并记录被问到的提示语。 */
function scripted(steps: Step[]) {
  const asked: string[] = [];
  let i = 0;

  const take = (kind: StepKind): unknown => {
    if (i >= steps.length) throw new Error(`脚本已用完：第 ${i + 1} 次提问（${kind}）没有预设答案`);
    const step = steps[i++] as Record<string, unknown>;
    if (!(kind in step)) {
      throw new Error(`第 ${i} 次提问期望 ${kind}，脚本给的是 ${Object.keys(step)[0]}`);
    }
    return step[kind];
  };
  const note = (m: string): void => void asked.push(m);

  const prompter: Prompter = {
    confirm: async (m) => {
      note(m);
      return take('confirm') as boolean;
    },
    text: async (m) => {
      note(m);
      return take('text') as string;
    },
    num: async (m) => {
      note(m);
      return take('num') as number;
    },
    pick: async (m) => {
      note(m);
      return take('pick') as string;
    },
    secret: async (m) => {
      note(m);
      return take('secret') as string;
    },
  };
  return { prompter, asked, remaining: () => steps.length - i };
}

function fakeIo(): Output & { err: string[] } {
  const err: string[] = [];
  return {
    err,
    line: () => {},
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
  return { prisma: {} as WizardDeps['prisma'], io, prompter, as: null };
}

function cmd(args: ArgSpec[]): CommandSpec {
  return {
    name: 'demo run',
    summary: '测试命令',
    group: 'stats',
    args,
    async run() {
      return {};
    },
  };
}

const NAME: ArgSpec = { name: 'username', flags: [], positional: 0, label: '用户名', help: '用户名' };
const DESC: ArgSpec = { name: 'description', flags: ['-d'], label: '说明', help: '说明' };
const AMOUNT: ArgSpec = {
  name: 'amount',
  flags: [],
  positional: 1,
  kind: 'int',
  label: '数量',
  help: '数量',
};

// ── 基本收集 ─────────────────────────────────────────────────────────────────

describe('collectArgs：按顺序收集', () => {
  it('文本与数字按注册表顺序问下来', async () => {
    const s = scripted([{ text: 'alice' }, { num: 5 }]);
    const args = await collectArgs(cmd([NAME, AMOUNT]), deps(s.prompter));
    expect(args).toEqual({ username: 'alice', amount: 5 });
  });

  it('无参数的命令直接返回空参数表（不提问）', async () => {
    const s = scripted([]);
    expect(await collectArgs(cmd([]), deps(s.prompter))).toEqual({});
    expect(s.asked).toEqual([]);
  });

  it('逐题提示里带上参数自己的 label', async () => {
    const s = scripted([{ text: 'alice' }, { num: 1 }]);
    await collectArgs(cmd([NAME, AMOUNT]), deps(s.prompter));
    expect(s.asked[0]).toContain('用户名');
    expect(s.asked[1]).toContain('数量');
  });
});

// ── 导航 ─────────────────────────────────────────────────────────────────────

describe('collectArgs：返回与取消', () => {
  it('★ 第一题按「返回上一步」= 取消整个命令（返回 null）', async () => {
    const s = scripted([{ text: NAV_BACK }]);
    expect(await collectArgs(cmd([NAME]), deps(s.prompter))).toBeNull();
  });

  it('★ 取消哨兵 → 返回 null，命令不会被执行', async () => {
    const s = scripted([{ text: 'alice' }, { text: NAV_CANCEL }]);
    expect(await collectArgs(cmd([NAME, DESC]), deps(s.prompter))).toBeNull();
  });

  it('★ 后面一题按「返回上一步」→ 回到前一题重问，之后再往前走', async () => {
    const s = scripted([
      { text: 'alice' }, // 第 1 题
      { text: NAV_BACK }, // 第 2 题要求退回
      { text: 'alice2' }, // 第 1 题重问
      { text: '补偿' }, // 第 2 题重来
    ]);
    const args = await collectArgs(cmd([NAME, DESC]), deps(s.prompter));
    expect(args).toEqual({ username: 'alice2', description: '补偿' });
  });
});

// ── 校验与必填 ───────────────────────────────────────────────────────────────

describe('collectArgs：校验与必填', () => {
  it('★ 必填项留空 → 原地重问，而不是把空串收下', async () => {
    const s = scripted([{ text: '   ' }, { text: 'alice' }]);
    const args = await collectArgs(cmd([{ ...NAME, required: true }]), deps(s.prompter));
    expect(args).toEqual({ username: 'alice' });
    expect(s.asked).toHaveLength(2);
  });

  it('★ 校验失败 → 报错并原地重问（不是退回上一题）', async () => {
    const spec: ArgSpec = {
      ...AMOUNT,
      validate: (raw) => (Number.parseInt(raw, 10) > 0 ? null : 'amount 必须为正整数'),
    };
    const s = scripted([{ num: 0 }, { num: 3 }]);
    const d = deps(s.prompter);
    const args = await collectArgs(cmd([spec]), d);
    expect(args).toEqual({ amount: 3 });
    expect(d.io.err.join('\n')).toContain('必须为正整数');
  });

  it('可选参数留空 → 不收进参数表（走命令自己的缺省逻辑）', async () => {
    const s = scripted([{ text: 'alice' }, { text: '' }]);
    expect(await collectArgs(cmd([NAME, DESC]), deps(s.prompter))).toEqual({ username: 'alice' });
  });

  it('可选参数留空但有 defaultValue → 用缺省值', async () => {
    const s = scripted([{ text: 'alice' }, { text: '' }]);
    const args = await collectArgs(
      cmd([NAME, { ...DESC, defaultValue: '管理员手动赠送' }]),
      deps(s.prompter)
    );
    expect(args).toEqual({ username: 'alice', description: '管理员手动赠送' });
  });

  it('校验用的是注册表里那一份（两条前端共用，不会各写一套）', async () => {
    let calls = 0;
    const spec: ArgSpec = {
      ...DESC,
      validate: () => {
        calls++;
        return null;
      },
    };
    const s = scripted([{ text: 'x' }]);
    await collectArgs(cmd([spec]), deps(s.prompter));
    expect(calls).toBe(1);
  });
});

// ── 先搜后选 ─────────────────────────────────────────────────────────────────

describe('collectArgs：先搜后选（「不用背命令」的落点）', () => {
  const CHOICES: Choice[] = [
    { value: 'id-1', label: '《构建报错排查》', hint: 'alice · 已删除' },
    { value: 'id-2', label: '《中文排版》', hint: 'bob' },
  ];
  function searchSpec(over: Partial<ArgSpec['prompt'] & object> = {}): ArgSpec {
    return {
      name: 'target',
      flags: [],
      positional: 0,
      required: true,
      label: '目标文章',
      help: '文章',
      prompt: {
        type: 'search',
        source: {
          search: async (q) => CHOICES.filter((c) => c.label.includes(q)),
          initial: async () => CHOICES,
        },
        ...over,
      },
    } as ArgSpec;
  }

  it('★ 输入关键词 → 从候选里挑，最终收下的是候选的 value（不是关键词）', async () => {
    const s = scripted([{ text: '报错' }, { pick: 'id-1' }]);
    const args = await collectArgs(cmd([searchSpec()]), deps(s.prompter));
    expect(args).toEqual({ target: 'id-1' });
  });

  it('关键词留空 → 退回 initial()（不输入也能选，例如「最近 20 条」）', async () => {
    const s = scripted([{ text: '' }, { pick: 'id-2' }]);
    const args = await collectArgs(cmd([searchSpec()]), deps(s.prompter));
    expect(args).toEqual({ target: 'id-2' });
  });

  it('没搜到结果 → 提示并重新问关键词，而不是收下空值', async () => {
    const s = scripted([{ text: '不存在的词' }, { text: '报错' }, { pick: 'id-1' }]);
    const d = deps(s.prompter);
    const args = await collectArgs(cmd([searchSpec()]), d);
    expect(args).toEqual({ target: 'id-1' });
    expect(d.io.err.join('\n')).toContain('没有匹配');
  });

  it('在候选列表里按「返回上一步」→ 回到关键词输入（此刻的「上一步」就是搜索框）', async () => {
    const s = scripted([{ text: '报错' }, { pick: NAV_BACK }, { text: '' }, { pick: 'id-2' }]);
    const args = await collectArgs(cmd([searchSpec()]), deps(s.prompter));
    expect(args).toEqual({ target: 'id-2' });
  });

  it('在候选列表里按「取消」→ 取消整个命令', async () => {
    const s = scripted([{ text: '报错' }, { pick: NAV_CANCEL }]);
    expect(await collectArgs(cmd([searchSpec()]), deps(s.prompter))).toBeNull();
  });
});

// ── 可重复参数 ───────────────────────────────────────────────────────────────

describe('collectArgs：可重复参数', () => {
  const REPEAT: ArgSpec = {
    name: 'redirectUris',
    flags: ['--redirect-uri'],
    repeatable: true,
    required: true,
    label: '回调 URI',
    help: '回调',
  };

  it('连续输入直到留空结束', async () => {
    const s = scripted([{ text: 'https://a/cb' }, { text: 'https://b/cb' }, { text: '' }]);
    const args = await collectArgs(cmd([REPEAT]), deps(s.prompter));
    expect(args).toEqual({ redirectUris: ['https://a/cb', 'https://b/cb'] });
  });

  it('一个都没输且必填 → 原地重问', async () => {
    const s = scripted([{ text: '' }, { text: 'https://a/cb' }, { text: '' }]);
    const d = deps(s.prompter);
    const args = await collectArgs(cmd([REPEAT]), d);
    expect(args).toEqual({ redirectUris: ['https://a/cb'] });
    expect(d.io.err.join('\n')).toContain('至少需要一个');
  });
});
