// ─────────────────────────────────────────────────────────────────────────────
// cli-registry.test.ts —— 命令注册表的完整性守卫
//
// 【为什么值得写】注册表是**唯一权威**：`--help`、交互式向导、参数校验全从它生成。
// 它同时也是最容易被改坏的地方 —— 加一条命令时漏个 label、位置参数跳号、
// 或者把 flag 名撞上全局参数，症状都不会在 tsc 或 build 阶段暴露，
// 而是在运维**正在敲命令的时候**才炸。
//
// 最后一条 LEGACY_COMMANDS 是迁移完整性闸：scripts/cli/mjs 时代支持的每个命令
// 路径都必须在注册表里，漏一条就红。
// ─────────────────────────────────────────────────────────────────────────────

import { describe, expect, it } from 'vitest';
import { COMMANDS, LEGACY_COMMANDS } from '../../scripts/cli/registry';
import { GLOBAL_FLAGS, parseCommandArgs, usageLine } from '../../scripts/cli/args';
import { GROUP_LABELS, type ArgSpec, type CommandSpec } from '../../scripts/cli/types';

const GLOBAL_SET = new Set<string>(GLOBAL_FLAGS);

/** 把所有命令的参数摊平，便于逐条断言。 */
const ALL_ARGS: { cmd: string; arg: ArgSpec }[] = COMMANDS.flatMap((c) =>
  c.args.map((arg) => ({ cmd: c.name, arg }))
);

describe('命令注册表：命名', () => {
  it('命令名唯一', () => {
    const names = COMMANDS.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('命令名是小写 kebab，多段用单个空格分隔', () => {
    for (const c of COMMANDS) {
      expect(c.name, `非法命令名：${c.name}`).toMatch(/^[a-z][a-z0-9-]*( [a-z][a-z0-9-]*)*$/);
    }
  });

  it('每个命令的 group 都在 GROUP_LABELS 里（否则菜单渲染出 undefined）', () => {
    for (const c of COMMANDS) {
      expect(Object.keys(GROUP_LABELS), `${c.name} 的 group=${c.group}`).toContain(c.group);
    }
  });

  it('每个命令都有非空的 summary 与 label/help', () => {
    for (const c of COMMANDS) {
      expect(c.summary.trim(), `${c.name} 缺 summary`).not.toBe('');
      for (const a of c.args) {
        expect(a.label.trim(), `${c.name} 的 ${a.name} 缺 label`).not.toBe('');
        expect(a.help.trim(), `${c.name} 的 ${a.name} 缺 help`).not.toBe('');
      }
    }
  });
});

describe('命令注册表：参数声明', () => {
  it('位置参数从 0 开始且连续（跳号会让解析器永远填不上那一格）', () => {
    for (const c of COMMANDS) {
      const indexes = c.args
        .filter((a) => a.positional !== undefined)
        .map((a) => a.positional!)
        .sort((a, b) => a - b);
      indexes.forEach((idx, i) => {
        expect(idx, `${c.name} 的位置参数序号不连续：${indexes.join(',')}`).toBe(i);
      });
    }
  });

  // 注：允许一个参数**同时**声明 positional 与 flags（如 `user search foo` 与
  // `user search --keyword foo` 等价）。解析器对二者的处理是无歧义的：带 `-` 前缀的
  // token 走 flag 表，其余按顺序填位置槽。真正要守的是位置槽本身不打架 —— 见上一条
  // 「序号从 0 开始且连续」（重复序号会被它抓到）。
  it('可重复（repeatable）参数不能同时又占位置槽（位置参数没有「重复」语义）', () => {
    for (const { cmd, arg } of ALL_ARGS) {
      if (arg.repeatable) {
        expect(arg.positional, `${cmd} 的 ${arg.name} 既 repeatable 又占了位置槽`).toBeUndefined();
      }
    }
  });

  it('repeatable 只能用在 flag 参数上（位置参数没有「重复」的语义）', () => {
    for (const { cmd, arg } of ALL_ARGS) {
      if (arg.repeatable) {
        expect(arg.positional, `${cmd} 的 ${arg.name} 是位置参数却标了 repeatable`).toBeUndefined();
        expect(arg.flags.length, `${cmd} 的 ${arg.name} 标了 repeatable 却没有 flag`).toBeGreaterThan(0);
      }
    }
  });

  it('flag 名唯一、以 - 开头、且不与全局参数冲突', () => {
    for (const c of COMMANDS) {
      const seen = new Set<string>();
      for (const a of c.args) {
        for (const f of a.flags) {
          expect(f, `${c.name} 的 flag ${f} 没以 - 开头`).toMatch(/^-/);
          expect(
            GLOBAL_SET.has(f),
            `${c.name} 的 ${a.name} 用了全局 flag ${f} —— 会被解析器提前摘走，命令永远收不到`
          ).toBe(false);
          expect(seen.has(f), `${c.name} 里 flag ${f} 重复声明`).toBe(false);
          seen.add(f);
        }
      }
    }
  });

  it('requiredIf 只加在非 required 的参数上（两者叠加没有意义且易误读）', () => {
    for (const { cmd, arg } of ALL_ARGS) {
      if (arg.requiredIf) {
        expect(arg.required, `${cmd} 的 ${arg.name} 同时标了 required 与 requiredIf`).toBeFalsy();
      }
    }
  });
});

describe('命令注册表：与前端约定的耦合', () => {
  it('readOnly 的命令不要求审计主体、也不是不可逆操作', () => {
    for (const c of COMMANDS) {
      if (c.readOnly) {
        expect(c.needsActor, `${c.name} 是只读却要求审计主体`).toBeFalsy();
        expect(c.danger ?? 'safe', `${c.name} 是只读却是不可逆操作`).not.toBe('irreversible');
      }
    }
  });

  it('非 safe 的命令必须提供 describe（确认屏没内容等于没确认）', () => {
    for (const c of COMMANDS) {
      if (c.danger && c.danger !== 'safe') {
        expect(typeof c.describe, `${c.name} 标了 ${c.danger} 却没有 describe`).toBe('function');
      }
    }
  });

  it('search 型 prompt 必须带可调用的 source.search', () => {
    for (const { cmd, arg } of ALL_ARGS) {
      if (arg.prompt?.type === 'search') {
        expect(typeof arg.prompt.source.search, `${cmd} 的 ${arg.name} 的 source.search 不可调用`).toBe(
          'function'
        );
      }
    }
  });
});

describe('命令注册表：迁移完整性', () => {
  it('cli.mjs 时代支持的每个命令路径都还在注册表里', () => {
    const names = new Set(COMMANDS.map((c) => c.name));
    const missing = LEGACY_COMMANDS.filter((n) => !names.has(n));
    expect(missing, `这些老命令在重构中丢了：${missing.join(', ')}`).toEqual([]);
  });

  it('LEGACY_COMMANDS 自身不重复', () => {
    expect(new Set(LEGACY_COMMANDS).size).toBe(LEGACY_COMMANDS.length);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 声明出来的参数，得真的能敲。
//
// 【为什么单列一组】`clip show --full` 的 kind: 'boolean' 声明了却没人验过：
// 解析器当时没有布尔分支，会掉进字符串分支去要值，于是 `--full` 永远报
// 「后面缺少值」—— 这个 flag 从写下那天起就没在命令式前端跑通过。而
// `--full true` 恰好能过（truthy 字符串），更让它藏了很久。
//
// 下面这组把「每条声明的参数都真的能解析」钉成会红的东西：拿注册表里的**真实
// ArgSpec** 单独组一条最小命令去敲 —— 声明与解析器对不上，这里就炸。
// ─────────────────────────────────────────────────────────────────────────────

describe('★ 注册表里声明的参数真的能解析', () => {
  const booleanArgs = ALL_ARGS.filter(({ arg }) => arg.kind === 'boolean');

  it('确实存在开关参数（否则下面这组空转，等于没测）', () => {
    expect(booleanArgs.length, '一个 boolean 参数都没有了？删掉这组测试').toBeGreaterThan(0);
  });

  for (const { cmd, arg } of booleanArgs) {
    const flag = arg.flags.find((f) => f.startsWith('--')) ?? arg.flags[0];
    it(`${cmd} 的 ${flag} 只写 flag 名就能解析成 true`, () => {
      // 只保留这一个参数的最小命令：本组验的是「声明 ↔ 解析器」是否对得上，
      // 不牵扯该命令其余的必填项。
      const minimal: CommandSpec = {
        name: 'probe run',
        summary: '探针',
        group: 'stats',
        args: [{ ...arg, positional: undefined, required: false }],
        async run() {
          return {};
        },
      };
      expect(parseCommandArgs(minimal, [flag])).toEqual({ [arg.name]: true });
    });
  }

  it('usageLine 不为开关渲染 <值>（否则运维会照敲 `--full true`）', () => {
    for (const { cmd, arg } of booleanArgs) {
      const owner = COMMANDS.find((c) => c.name === cmd)!;
      expect(usageLine(owner), `${cmd} 的 ${arg.name}`).not.toContain(`<${arg.name}>`);
    }
  });
});
