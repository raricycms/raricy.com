// ─────────────────────────────────────────────────────────────────────────────
// args.ts —— 命令式前端：命令解析 + argv 解析 + 生成式 --help
//
// 三个东西都从 registry 的元数据生成，不手写。向导（wizard.ts）走的是同一份
// ArgSpec，只是把「从 argv 取值」换成「问用户」，校验函数共用。
//
// 退出码语义（对齐 Flask，历史约定不能动）：参数/用户错误一律退出码 1。
// ─────────────────────────────────────────────────────────────────────────────

import { CliError, GROUP_LABELS, type ArgSpec, type Args, type CommandSpec, type GroupId } from './types';

/** 全局参数。它们不出现在任何命令的 args 里，由解析器在任何位置剥离。 */
export interface GlobalFlags {
  help: boolean;
  json: boolean;
  yes: boolean;
  as: string | null;
  noColor: boolean;
}

export const GLOBAL_FLAGS = ['--help', '-h', '--json', '--yes', '-y', '--as', '--no-color'] as const;

const HELP_ALIASES = ['--help', '-h'];
const YES_ALIASES = ['--yes', '-y'];

/** 取命令的展示用主 flag 名（长的那个），错误信息里用它。 */
function primaryFlag(arg: ArgSpec): string {
  return arg.flags.find((f) => f.startsWith('--')) ?? arg.flags[0];
}

/** 命令的用法行，`--help` 与「缺少参数」提示共用。 */
export function usageLine(cmd: CommandSpec): string {
  const positionals = cmd.args
    .filter((a) => a.positional !== undefined)
    .sort((a, b) => a.positional! - b.positional!)
    .map((a) => (a.required ? `<${a.name}>` : `[<${a.name}>]`));
  const flags = cmd.args
    .filter((a) => a.flags.length > 0)
    .map((a) => (a.required ? `${primaryFlag(a)} <${a.name}>` : `[${primaryFlag(a)} <${a.name}>]`));
  const parts = [cmd.name, ...positionals, ...flags];
  return `npm run cli -- ${parts.join(' ')}`;
}

/**
 * 从 argv 里解析出命令与全局参数。
 *
 * 命令名可能有多段（'blog search' / 'oauth create-app'），所以按**最长前缀**匹配：
 * `oauth create-app foo` 要匹配到 'oauth create-app' 而不是 'oauth'。
 */
export function resolveCommand(
  commands: CommandSpec[],
  argv: string[]
): { cmd: CommandSpec; rest: string[]; flags: GlobalFlags } | null {
  const maxWords = Math.max(...commands.map((c) => c.name.split(' ').length));
  for (let n = Math.min(maxWords, argv.length); n >= 1; n--) {
    const candidate = argv.slice(0, n).join(' ');
    const cmd = commands.find((c) => c.name === candidate);
    if (cmd) {
      const { args: rest, flags } = splitGlobals(argv.slice(n));
      return { cmd, rest, flags };
    }
  }
  return null;
}

/** 把全局参数从任意位置摘出来，剩下的原样返回。 */
export function splitGlobals(tokens: string[]): { args: string[]; flags: GlobalFlags } {
  const flags: GlobalFlags = { help: false, json: false, yes: false, as: null, noColor: false };
  const args: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (HELP_ALIASES.includes(t)) flags.help = true;
    else if (YES_ALIASES.includes(t)) flags.yes = true;
    else if (t === '--json') flags.json = true;
    else if (t === '--no-color') flags.noColor = true;
    else if (t === '--as') flags.as = tokens[++i] ?? null;
    else args.push(t);
  }
  return { args, flags };
}

/** 解析命令自己的参数（全局参数已由 resolveCommand 摘走）。 */
export function parseCommandArgs(cmd: CommandSpec, tokens: string[]): Args {
  const byFlag = new Map<string, ArgSpec>();
  for (const a of cmd.args) for (const f of a.flags) byFlag.set(f, a);

  const positionalSpecs = cmd.args
    .filter((a) => a.positional !== undefined)
    .sort((a, b) => a.positional! - b.positional!);

  const args: Args = {};
  let posIndex = 0;

  const assign = (spec: ArgSpec, raw: string): void => {
    if (spec.kind === 'int') {
      const n = Number.parseInt(raw, 10);
      if (!Number.isInteger(n)) {
        throw new CliError(`错误：${primaryFlag(spec)} 需要一个整数，收到 ${raw}`, 1, [usageLine(cmd)]);
      }
      args[spec.name] = n;
    } else if (spec.kind === 'number') {
      const n = Number(raw);
      if (!Number.isFinite(n)) {
        throw new CliError(`错误：${primaryFlag(spec)} 需要一个数字，收到 ${raw}`, 1, [usageLine(cmd)]);
      }
      args[spec.name] = n;
    } else if (spec.repeatable) {
      const cur = args[spec.name];
      args[spec.name] = Array.isArray(cur) ? [...cur, raw] : [raw];
    } else {
      args[spec.name] = raw;
    }

    const err = spec.validate?.(raw, args);
    if (err) throw new CliError(`错误：${err}`, 1, [usageLine(cmd)]);
  };

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];

    if (t.startsWith('-') && t !== '-') {
      // --flag=value 形式
      const eq = t.indexOf('=');
      const flagName = eq >= 0 ? t.slice(0, eq) : t;
      const inlineValue = eq >= 0 ? t.slice(eq + 1) : null;

      const spec = byFlag.get(flagName);
      if (!spec) {
        throw new CliError(`错误：未知参数 ${flagName}`, 1, [usageLine(cmd)]);
      }

      if (inlineValue !== null) {
        assign(spec, inlineValue);
        continue;
      }
      const next = tokens[i + 1];
      // 下一个 token 也是个参数 → 说明这个 flag 缺值，别把别人吞了
      if (next === undefined || (next.startsWith('-') && next !== '-')) {
        throw new CliError(`错误：${flagName} 后面缺少值`, 1, [usageLine(cmd)]);
      }
      assign(spec, next);
      i++;
      continue;
    }

    const spec = positionalSpecs[posIndex];
    if (!spec) {
      throw new CliError(`错误：多出一个参数 ${t}`, 1, [usageLine(cmd)]);
    }
    assign(spec, t);
    posIndex++;
  }

  // 默认值 + 必填检查
  for (const spec of cmd.args) {
    if (args[spec.name] === undefined && spec.defaultValue !== undefined) {
      args[spec.name] = spec.defaultValue;
    }
    const present = args[spec.name] !== undefined;
    const needed = spec.required || spec.requiredIf?.(args) === true;
    if (!present && needed) {
      const label = spec.flags.length > 0 ? primaryFlag(spec) : spec.label;
      throw new CliError(`错误：缺少${label}`, 1, [usageLine(cmd)]);
    }
  }

  return args;
}

/** 单条命令的详细帮助。 */
export function commandHelp(cmd: CommandSpec): string {
  const lines = [cmd.summary, ''];
  if (cmd.details) lines.push(cmd.details, '');
  lines.push(`用法：${usageLine(cmd)}`, '');
  if (cmd.args.length > 0) {
    lines.push('参数：');
    for (const a of cmd.args) {
      const primary = a.flags.length > 0 ? primaryFlag(a) : '';
      // 别名要把主 flag 自己排除掉，否则会渲染成 `--description (--description)`
      const aliases = a.flags.filter((f) => f !== primary);
      const name =
        a.flags.length > 0
          ? `${primary}${aliases.length > 0 ? ` (${aliases.join(', ')})` : ''}`
          : `<${a.name}>`;
      lines.push(`  ${name.padEnd(22)} ${a.help}${a.required ? '（必填）' : ''}`);
    }
    lines.push('');
  }
  if (cmd.danger && cmd.danger !== 'safe') {
    lines.push(`⚠️  这是${cmd.danger === 'irreversible' ? '不可逆' : '破坏性'}操作，需要确认。非交互模式下必须显式加 --yes。`, '');
  }
  return lines.join('\n');
}

/** 顶层帮助：按分组列出全部命令。 */
export function generateHelp(commands: CommandSpec[]): string {
  const lines = [
    '用法：npm run cli -- <命令> [参数]',
    '',
    '  命令式：直接跑一条命令（脚本 / CI / 明确知道自己要做什么时）。',
    '  交互式：不带任何参数跑 `npm run cli`，进入菜单向导 —— 每一步都有提示，不用背命令。',
    '',
    '全局参数：--json（结构化输出）  --yes/-y（跳过危险操作确认）  --as <username>（审计身份）',
    '          --no-color  --help/-h',
    '退出码：0 成功 / 1 参数或用户错误 / 2 账户服务同步失败（本地已回滚）',
    '',
  ];

  const groups = new Map<GroupId, CommandSpec[]>();
  for (const c of commands) {
    const list = groups.get(c.group) ?? [];
    list.push(c);
    groups.set(c.group, list);
  }

  const nameWidth = Math.min(34, Math.max(...commands.map((c) => c.name.length)));
  for (const [group, list] of groups) {
    lines.push(`${GROUP_LABELS[group] ?? group}`);
    for (const c of list.sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.name.localeCompare(b.name))) {
      lines.push(`  ${c.name.padEnd(nameWidth + 2)}${c.summary}`);
    }
    lines.push('');
  }
  lines.push('看单条命令的详细帮助：npm run cli -- <命令> --help');
  return lines.join('\n');
}
