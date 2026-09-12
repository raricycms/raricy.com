// ─────────────────────────────────────────────────────────────────────────────
// cli-args.test.ts —— 命令式前端的 argv 解析
//
// 解析器是两条前端共用的校验入口（validate 只写这一份），所以它的边界行为
// 值得钉死：位置参数怎么填、--flag=value 认不认、可重复 flag 的顺序、
// 必填/条件必填什么时候报错、退出码是不是 1。
// ─────────────────────────────────────────────────────────────────────────────

import { describe, expect, it } from 'vitest';
import { parseCommandArgs, resolveCommand, splitGlobals, usageLine } from '../../scripts/cli/args';
import { CliError, type ArgSpec, type CommandSpec } from '../../scripts/cli/types';

function makeCmd(args: ArgSpec[], name = 'demo run'): CommandSpec {
  return {
    name,
    summary: '测试用命令',
    group: 'stats',
    args,
    async run() {
      return {};
    },
  };
}

const POS0: ArgSpec = {
  name: 'username',
  flags: [],
  positional: 0,
  required: true,
  label: '用户名',
  help: '目标用户',
};
const POS1: ArgSpec = { name: 'amount', flags: [], positional: 1, kind: 'int', label: '数量', help: '数量' };
const FLAG: ArgSpec = { name: 'description', flags: ['-d', '--description'], label: '说明', help: '说明' };
const DRY_RUN: ArgSpec = {
  name: 'dryRun',
  flags: ['--dry-run'],
  kind: 'boolean',
  label: '只预览',
  help: '只显示计划，不实际执行',
};

/** 断言抛的是 CliError 且退出码符合预期（参数错误一律 1）。 */
function expectCliError(fn: () => unknown, code = 1): CliError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(CliError);
    expect((e as CliError).exitCode).toBe(code);
    return e as CliError;
  }
  throw new Error('预期抛出 CliError，但没有抛');
}

describe('splitGlobals：全局参数可以出现在任何位置', () => {
  it('从中间、开头、结尾都能摘出来，且不动其余 token 的顺序', () => {
    const r = splitGlobals(['fish', 'grant', '--json', 'alice', '--yes', '100']);
    expect(r.args).toEqual(['fish', 'grant', 'alice', '100']);
    expect(r.flags).toMatchObject({ json: true, yes: true });
  });

  it('--as 会吃掉后面那个 token 当值', () => {
    const r = splitGlobals(['--as', 'cms', 'blog', 'search']);
    expect(r.flags.as).toBe('cms');
    expect(r.args).toEqual(['blog', 'search']);
  });

  it('-y 与 --yes 等价，-h 与 --help 等价', () => {
    expect(splitGlobals(['-y']).flags.yes).toBe(true);
    expect(splitGlobals(['-h']).flags.help).toBe(true);
  });
});

describe('resolveCommand：按最长前缀匹配', () => {
  const commands = [makeCmd([], 'oauth'), makeCmd([], 'oauth create-app')];

  it('多段命令名优先于它的前缀', () => {
    expect(resolveCommand(commands, ['oauth', 'create-app', 'foo'])?.cmd.name).toBe('oauth create-app');
  });

  it('只有前缀时仍能匹配到短命令', () => {
    expect(resolveCommand(commands, ['oauth', 'list-apps'])?.cmd.name).toBe('oauth');
  });

  it('剩余 token 原样返回', () => {
    const r = resolveCommand(commands, ['oauth', 'create-app', 'foo', '-d', '说明']);
    expect(r?.rest).toEqual(['foo', '-d', '说明']);
  });

  it('完全不认识时返回 null', () => {
    expect(resolveCommand(commands, ['nope'])).toBeNull();
  });
});

describe('parseCommandArgs：取值', () => {
  it('位置参数按序号填', () => {
    const cmd = makeCmd([POS0, POS1]);
    expect(parseCommandArgs(cmd, ['alice', '100'])).toMatchObject({ username: 'alice', amount: 100 });
  });

  it('flag 支持 `--flag value` 与 `--flag=value` 两种写法', () => {
    const cmd = makeCmd([POS0, FLAG]);
    expect(parseCommandArgs(cmd, ['alice', '-d', '补偿']).description).toBe('补偿');
    expect(parseCommandArgs(cmd, ['alice', '--description=补偿']).description).toBe('补偿');
  });

  it('位置参数与 flag 可以交错', () => {
    const cmd = makeCmd([POS0, POS1, FLAG]);
    expect(parseCommandArgs(cmd, ['alice', '-d', 'x', '100'])).toMatchObject({
      username: 'alice',
      amount: 100,
      description: 'x',
    });
  });

  it('可重复 flag 按出现顺序累积', () => {
    const cmd = makeCmd([
      {
        name: 'redirectUris',
        flags: ['--redirect-uri'],
        repeatable: true,
        label: '回调',
        help: '回调',
      },
    ]);
    expect(
      parseCommandArgs(cmd, ['--redirect-uri', 'a', '--redirect-uri', 'b']).redirectUris
    ).toEqual(['a', 'b']);
  });

  it('缺省值在参数缺席时生效', () => {
    const cmd = makeCmd([{ ...FLAG, defaultValue: '管理员手动赠送' }]);
    expect(parseCommandArgs(cmd, []).description).toBe('管理员手动赠送');
  });
});

describe('parseCommandArgs：报错', () => {
  it('缺必填参数 → 退出码 1，且错误信息里带用法行', () => {
    const cmd = makeCmd([POS0]);
    const err = expectCliError(() => parseCommandArgs(cmd, []));
    expect(err.message).toContain('缺少');
    expect(err.details[0]).toContain('npm run cli --');
  });

  it('缺必填 flag 时用 flag 名提示', () => {
    const cmd = makeCmd([{ ...FLAG, required: true, flags: ['--reason', '-r'] }]);
    expect(expectCliError(() => parseCommandArgs(cmd, [])).message).toContain('--reason');
  });

  it('未知 flag 会被指名道姓地拒绝', () => {
    const cmd = makeCmd([POS0]);
    expect(expectCliError(() => parseCommandArgs(cmd, ['alice', '--nope'])).message).toContain('--nope');
  });

  it('flag 后面缺值时不会把下一个 flag 吞掉', () => {
    const cmd = makeCmd([POS0, FLAG]);
    expect(
      expectCliError(() => parseCommandArgs(cmd, ['alice', '-d', '--description'])).message
    ).toContain('缺少值');
  });

  it('多出一个位置参数会被拒绝（而不是静默丢弃）', () => {
    const cmd = makeCmd([POS0]);
    expect(expectCliError(() => parseCommandArgs(cmd, ['alice', '多余'])).message).toContain('多余');
  });

  it('int 参数收到非数字 → 退出码 1', () => {
    const cmd = makeCmd([POS0, POS1]);
    expect(expectCliError(() => parseCommandArgs(cmd, ['alice', 'abc'])).message).toContain('整数');
  });

  it('validate 返回的中文错误会原样上报', () => {
    const cmd = makeCmd([
      {
        name: 'amount',
        flags: [],
        positional: 0,
        kind: 'int',
        label: '数量',
        help: '数量',
        validate: (raw) => (Number.parseInt(raw, 10) > 0 ? null : 'amount 必须为正整数'),
      },
    ]);
    expect(expectCliError(() => parseCommandArgs(cmd, ['0'])).message).toContain('必须为正整数');
  });

  it('requiredIf 为真时才要求必填', () => {
    const cmd = makeCmd([
      {
        name: 'decision',
        flags: [],
        positional: 0,
        required: true,
        label: '裁决',
        help: '裁决',
      },
      { name: 'note', flags: ['--note'], label: '说明', help: '说明', requiredIf: (a) => a.decision === 'reject' },
    ]);

    expect(() => parseCommandArgs(cmd, ['accept'])).not.toThrow();
    expect(expectCliError(() => parseCommandArgs(cmd, ['reject'])).message).toContain('--note');
  });
});

describe('usageLine', () => {
  it('必填位置参数用 <>，可选位置参数用 []，并把 flag 一起列出来', () => {
    const cmd = makeCmd([POS0, POS1, FLAG]);
    expect(usageLine(cmd)).toBe(
      'npm run cli -- demo run <username> [<amount>] [--description <description>]'
    );
  });

  it('开关渲染成 [--flag]，不带 <值> —— 否则运维会照敲 `--dry-run true`', () => {
    const cmd = makeCmd([POS1, DRY_RUN]);
    expect(usageLine(cmd)).toBe('npm run cli -- demo run [<amount>] [--dry-run]');
  });
});

// 开关的失效方式是**静默的**：若解析器把 `--dry-run` 当成「缺值的字符串参数」，
// 调用方写的是 `args.dryRun === true`，永远为假 —— 于是「只预览」变成「真发全站」。
// 所以这一组是行为契约，不是实现细节。
describe('parseCommandArgs：开关（kind: boolean）', () => {
  it('出现即为真', () => {
    const cmd = makeCmd([POS1, DRY_RUN]);
    expect(parseCommandArgs(cmd, ['5', '--dry-run'])).toEqual({ amount: 5, dryRun: true });
  });

  it('★ 不吞下一个 token（--dry-run 5 与 5 --dry-run 等价）', () => {
    const cmd = makeCmd([POS1, DRY_RUN]);
    expect(parseCommandArgs(cmd, ['--dry-run', '5'])).toEqual({ amount: 5, dryRun: true });
  });

  it('★ 紧跟另一个 flag 时不会把对方吃成自己的值', () => {
    const cmd = makeCmd([POS1, DRY_RUN, FLAG]);
    expect(parseCommandArgs(cmd, ['5', '--dry-run', '-d', '说明'])).toEqual({
      amount: 5,
      dryRun: true,
      description: '说明',
    });
  });

  it('--dry-run=false 显式关掉；--dry-run=true 等价于只写 flag', () => {
    const cmd = makeCmd([POS1, DRY_RUN]);
    expect(parseCommandArgs(cmd, ['5', '--dry-run=false'])).toEqual({ amount: 5, dryRun: false });
    expect(parseCommandArgs(cmd, ['5', '--dry-run=true'])).toEqual({ amount: 5, dryRun: true });
  });

  it('★ 不猜 --dry-run=0 / no / yes（猜错的代价是「以为只预览，实际发了全站」）', () => {
    const cmd = makeCmd([POS1, DRY_RUN]);
    for (const bad of ['--dry-run=0', '--dry-run=no', '--dry-run=yes', '--dry-run=TRUE']) {
      const err = expectCliError(() => parseCommandArgs(cmd, ['5', bad]));
      expect(err.message, bad).toContain('只接受 true / false');
    }
  });

  it('没写就用 defaultValue', () => {
    const cmd = makeCmd([POS1, { ...DRY_RUN, defaultValue: false }]);
    expect(parseCommandArgs(cmd, ['5'])).toEqual({ amount: 5, dryRun: false });
  });

  it('★ 开关声明成位置参数 → 直接报错（不能当字符串 "true" 静默放行）', () => {
    const cmd = makeCmd([{ ...DRY_RUN, flags: [], positional: 0 }]);
    const err = expectCliError(() => parseCommandArgs(cmd, ['true']));
    expect(err.message).toContain('开关');
  });
});
