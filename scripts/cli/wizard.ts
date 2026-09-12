// ─────────────────────────────────────────────────────────────────────────────
// wizard.ts —— 交互式前端：菜单循环 + 逐参数引导
//
// 【它为什么存在】「运维不该需要背命令」。这个前端把 registry 里的元数据反过来
// 当脚本用：每条命令的每个参数都带着 label / help / 校验 / 候选项，向导照着问就行。
// 于是**加命令不需要改这个文件** —— 注册表加一条，菜单和提问自动出现。
//
// 【返回 / 取消是返回值，不是异常】哨兵 NAV_BACK / NAV_CANCEL 一层层往回传。
// 异常只留给两种东西：inquirer 的 Ctrl-C（ExitPromptError），以及真正的失败。
//
// 【不留半完成的写】向导自己**不写任何东西** —— 它只负责收集参数，然后交给
// executeCommand（那里才有唯一的写库点，且在确认闸之后）。
//
// 【回退时不清空上一个参数】退回上一题时会带出原答案当默认值，比清空重填好。
// ─────────────────────────────────────────────────────────────────────────────

import type { PrismaClient } from '@prisma/client';
import type { SafeUser } from '../../src/lib/auth';
import { resolveActor } from './actor';
import { executeCommand } from './execute';
import { printResult } from './output';
import { isExitPromptError, type Prompter } from './prompt';
import { COMMANDS } from './registry';
import {
  CliError,
  GROUP_LABELS,
  NAV_BACK,
  NAV_CANCEL,
  type Args,
  type ArgSpec,
  type Choice,
  type CommandSpec,
  type GroupId,
  type Output,
  type PromptSpec,
  type SearchSource,
} from './types';

export interface WizardDeps {
  prisma: PrismaClient;
  io: Output;
  prompter: Prompter;
  /** --as <username>，可为空。 */
  as: string | null;
}

/** 菜单里分组的展示顺序（按运维频率排，不按字母）。 */
const GROUP_ORDER: GroupId[] = [
  'users',
  'roles',
  'blogs',
  'comments',
  'clips',
  'votes',
  'images',
  'invites',
  'fish',
  'audit',
  'appeals',
  'stats',
  'oauth',
];

/** 一次提问的结果。 */
type Asked =
  | { kind: 'value'; value: string | number | boolean | string[] }
  | { kind: 'skip' }
  | { kind: 'back' }
  | { kind: 'cancel' };

function navResult(v: string): Asked {
  return v === NAV_BACK ? { kind: 'back' } : { kind: 'cancel' };
}

function isNav(v: string): boolean {
  return v === NAV_BACK || v === NAV_CANCEL;
}

// ── 主循环 ───────────────────────────────────────────────────────────────────

export async function wizardLoop(deps: WizardDeps): Promise<number> {
  // 用对象持有而不是 let 变量：闭包里赋值会让 TS 把 let 变量的收窄算成 never
  const state: { actor: SafeUser | null; name: string | null } = { actor: null, name: deps.as };

  /** 惰性解析审计主体：只有真的要执行写命令时才去查库。 */
  const ensureActor = async (): Promise<SafeUser> => {
    if (state.actor) return state.actor;
    state.actor = await resolveActor(deps.prisma, deps.io, { as: state.name });
    return state.actor;
  };

  for (;;) {
    const actorLabel = state.actor
      ? `${state.actor.role} ${state.actor.username}`
      : state.name
        ? `（待解析：${state.name}）`
        : '（首次写操作时确定）';
    const topChoices: Choice[] = [
      ...GROUP_ORDER.filter((g) => COMMANDS.some((c) => c.group === g)).map((g) => ({
        value: `g:${g}`,
        label: GROUP_LABELS[g],
        hint: `${COMMANDS.filter((c) => c.group === g).length} 条命令`,
      })),
      { value: 'actor', label: `审计身份：${actorLabel}`, hint: '切换' },
      { value: 'help', label: '查看全部命令与用法', hint: '--help' },
      { value: 'quit', label: '退出' },
    ];

    let picked: string;
    try {
      picked = await deps.prompter.pick('聪明山 运维台', topChoices, { nav: false });
    } catch (e) {
      if (isExitPromptError(e)) return 0;
      throw e;
    }

    if (picked === 'quit') return 0;
    if (picked === 'help') {
      const { generateHelp } = await import('./args');
      deps.io.line(generateHelp(COMMANDS));
      continue;
    }
    if (picked === 'actor') {
      state.name = await pickActor(deps, state.name);
      state.actor = null; // 换人后重新解析
      continue;
    }

    const cmd = await pickCommand(picked.slice(2) as GroupId, deps);
    if (cmd) await runOne(cmd, deps, ensureActor);
  }
}

/** 二级菜单：组内选一条命令。 */
async function pickCommand(group: GroupId, deps: WizardDeps): Promise<CommandSpec | null> {
  const list = COMMANDS.filter((c) => c.group === group).sort(
    (a, b) => (a.order ?? 0) - (b.order ?? 0) || a.name.localeCompare(b.name)
  );
  const choices: Choice[] = list.map((c) => ({ value: c.name, label: c.name, hint: c.summary }));
  const picked = await deps.prompter.pick(GROUP_LABELS[group], choices, { nav: true });
  if (isNav(picked)) return null;
  return list.find((c) => c.name === picked) ?? null;
}

/** 切换审计身份。返回新的用户名（未切换则原样返回）。 */
async function pickActor(deps: WizardDeps, current: string | null): Promise<string | null> {
  const name = await deps.prompter.text('输入要作为审计身份的用户名', {
    defaultValue: current ?? undefined,
  });
  if (isNav(name) || name.trim() === '') return current;

  const { loadSafeUserByUsername } = await import('../../src/lib/admin-user-service');
  const u = await loadSafeUserByUsername(name.trim());
  if (!u) {
    deps.io.error(deps.io.red(`错误：用户 ${name.trim()} 不存在`));
    return current;
  }
  if (u.role !== 'owner') {
    deps.io.error(deps.io.yellow(`⚠️  ${u.username} 不是站长，多数写操作会被拒绝。`));
  }
  return u.username;
}

/** 收集参数 → 执行 → 打印。任何失败都只报错回菜单，不退出整个向导。 */
async function runOne(
  cmd: CommandSpec,
  deps: WizardDeps,
  ensureActor: () => Promise<SafeUser>
): Promise<void> {
  try {
    const args = await collectArgs(cmd, deps);
    if (args === null) {
      deps.io.error(deps.io.yellow('已取消，未做任何改动。'));
      return;
    }

    const actor = cmd.needsActor ? await ensureActor() : null;
    const { output } = await executeCommand(cmd, args, {
      prisma: deps.prisma,
      io: deps.io,
      prompter: deps.prompter,
      actor,
      interactive: true,
      yes: false,
    });

    if (output === null) {
      deps.io.error(deps.io.yellow('已取消，未做任何改动。'));
      return;
    }
    printResult(deps.io, cmd.name, output, false);
  } catch (e) {
    if (isExitPromptError(e)) {
      deps.io.error(deps.io.yellow('\n已取消本次操作。'));
      return;
    }
    if (e instanceof CliError) {
      deps.io.error(deps.io.red(e.message));
      for (const d of e.details) deps.io.error(d);
      return;
    }
    throw e;
  }
}

// ── 逐参数收集 ───────────────────────────────────────────────────────────────

/**
 * 按注册表的顺序逐个问。返回 null = 用户取消。
 *
 * 语义与命令式前端一致，因为 validate 是同一份：必填为空会重问，
 * 「返回上一步」回到前一题（带出原答案当默认值）。
 */
export async function collectArgs(cmd: CommandSpec, deps: WizardDeps): Promise<Args | null> {
  const specs = cmd.args.filter((a) => !a.helpOnly);
  const args: Args = {};

  let i = 0;
  while (i < specs.length) {
    const asked = await askArg(specs[i], args, deps);

    if (asked.kind === 'cancel') return null;
    if (asked.kind === 'back') {
      if (i === 0) return null; // 已经在第一题，再往回就等于取消
      i--;
      continue;
    }
    if (asked.kind === 'value') args[specs[i].name] = asked.value;
    i++;
  }

  // 与命令式前端同样的必填收口（这里兜住 requiredIf 在收齐参数后才成立的情形）
  for (const spec of specs) {
    if (args[spec.name] === undefined && spec.defaultValue !== undefined) {
      args[spec.name] = spec.defaultValue;
    }
    const needed = spec.required || spec.requiredIf?.(args) === true;
    if (needed && args[spec.name] === undefined) {
      deps.io.error(deps.io.red(`错误：缺少${spec.label}`));
      return collectArgs(cmd, deps); // 重来一轮
    }
  }

  return args;
}

/** 按 kind 推断提问方式（注册表没显式写 prompt 时）。 */
function promptFor(spec: ArgSpec): PromptSpec {
  if (spec.prompt) return spec.prompt;
  if (spec.kind === 'int' || spec.kind === 'number') return { type: 'number' };
  if (spec.kind === 'boolean') return { type: 'confirm' };
  return { type: 'input' };
}

async function askArg(spec: ArgSpec, args: Args, deps: WizardDeps): Promise<Asked> {
  const prompt = promptFor(spec);
  const required = spec.required || spec.requiredIf?.(args) === true;
  const label = required ? `${spec.label}（必填）` : spec.label;

  switch (prompt.type) {
    case 'search':
      return askSearch(spec, prompt.source, deps);

    case 'select': {
      const v = await deps.prompter.pick(label, prompt.choices, {
        nav: true,
        pageSize: prompt.pageSize,
      });
      if (isNav(v)) return navResult(v);
      const err = spec.validate?.(v, args);
      if (err) return retry(spec, args, deps, err);
      return { kind: 'value', value: v };
    }

    case 'number': {
      const dflt = typeof spec.defaultValue === 'number' ? spec.defaultValue : undefined;
      const n = await deps.prompter.num(label, { defaultValue: dflt });
      if (Number.isNaN(n)) {
        if (required) return retry(spec, args, deps, '请填一个数字。');
        return { kind: 'skip' };
      }
      const err = spec.validate?.(String(n), args);
      if (err) return retry(spec, args, deps, err);
      return { kind: 'value', value: n };
    }

    case 'confirm': {
      const b = await deps.prompter.confirm(label, false);
      return { kind: 'value', value: b };
    }

    case 'password': {
      const v = await deps.prompter.secret(label);
      const err = spec.validate?.(v, args);
      if (err) return retry(spec, args, deps, err);
      return { kind: 'value', value: v };
    }

    default: {
      // 可重复参数：连续问，留空结束
      if (spec.repeatable) return askRepeatable(spec, label, deps);

      const dflt = typeof spec.defaultValue === 'string' ? spec.defaultValue : undefined;
      const v = await deps.prompter.text(label, { defaultValue: dflt });
      if (isNav(v)) return navResult(v);

      const trimmed = v.trim();
      if (trimmed === '') {
        if (required) return retry(spec, args, deps, `「${spec.label}」不能为空。`);
        if (dflt !== undefined) return { kind: 'value', value: dflt };
        return { kind: 'skip' };
      }
      const err = spec.validate?.(trimmed, args);
      if (err) return retry(spec, args, deps, err);
      return { kind: 'value', value: trimmed };
    }
  }
}

/** 报错并重问同一题（不是「返回上一步」，是原地纠正）。 */
async function retry(spec: ArgSpec, args: Args, deps: WizardDeps, message: string): Promise<Asked> {
  deps.io.error(deps.io.red(`  ${message}`));
  return askArg(spec, args, deps);
}

async function askRepeatable(spec: ArgSpec, label: string, deps: WizardDeps): Promise<Asked> {
  const values: string[] = [];
  for (;;) {
    const message = values.length === 0 ? label : `${spec.label}（再输一个，直接回车结束）`;
    const v = await deps.prompter.text(message);
    if (isNav(v)) return navResult(v);
    const trimmed = v.trim();
    if (trimmed === '') break;
    const err = spec.validate?.(trimmed, { [spec.name]: values });
    if (err) {
      deps.io.error(deps.io.red(`  ${err}`));
      continue;
    }
    values.push(trimmed);
  }
  if (values.length === 0) {
    if (spec.required) return retry(spec, {}, deps, `至少需要一个「${spec.label}」。`);
    return { kind: 'skip' };
  }
  return { kind: 'value', value: values };
}

/**
 * 「先搜后选」：先问关键词，再从结果里挑一个。
 *
 * 这是「不用背命令」的落点 —— 操作者不需要知道文章 UUID、申诉 id，输入一个词就行。
 * 关键词为空时退回 source.initial()（例如「最近 20 条」）。
 */
async function askSearch(spec: ArgSpec, source: SearchSource, deps: WizardDeps): Promise<Asked> {
  for (;;) {
    const kw = await deps.prompter.text(`${spec.label}：输入关键词搜索`, {
      placeholder: source.emptyHint,
    });
    if (isNav(kw)) return navResult(kw);

    const query = kw.trim();
    let choices: Choice[];
    try {
      choices = query === '' ? (source.initial ? await source.initial() : []) : await source.search(query);
    } catch (e) {
      deps.io.error(deps.io.red(`  搜索失败：${e instanceof Error ? e.message : String(e)}`));
      continue;
    }

    if (choices.length === 0) {
      if (source.allowFreeTextFallback && query !== '') return { kind: 'value', value: query };
      deps.io.error(deps.io.yellow('  没有匹配的结果，换个关键词试试。'));
      continue;
    }

    const picked = await deps.prompter.pick('选择', choices, { nav: true });
    // 在搜索结果里按「返回上一步」= 回到关键词输入（而不是退回上一个参数），
    // 因为此刻「上一步」在这个流程里就是搜索框。
    if (picked === NAV_BACK) continue;
    if (picked === NAV_CANCEL) return { kind: 'cancel' };
    return { kind: 'value', value: picked };
  }
}
