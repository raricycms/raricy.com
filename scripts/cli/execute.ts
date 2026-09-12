// ─────────────────────────────────────────────────────────────────────────────
// execute.ts —— 两条前端共用的执行尾段
//
// 流程：预检（describe，只读）→ 确认闸 → 执行（run，唯一的写库点）→ 调用方打印。
//
// 【为什么确认屏要跑 describe 而不是让 run 自己问】确认屏必须在**任何写入之前**
// 就把「即将发生什么」摆出来。describe 因此被约定为只读：它读库没问题，但绝不能写。
// 它抛 CliError 就等于预检失败 —— 而且这个失败发生在 --yes 闸之前，
// 所以「用户不存在」这类真问题先报出来，而不是先报「请加 --yes」。
//
// 【describe 返回空数组 = 本次没有实际变更】例如角色命令的目标已经是那个角色。
// 这种情况下跳过确认，直接执行（run 会返回一条「提示：已是…」）。
//
// 【Ctrl-C 不会留下半完成的写】唯一的写库点 run() 在确认闸之后，且是一次 await。
// ─────────────────────────────────────────────────────────────────────────────

import type { PrismaClient } from '@prisma/client';
import type { SafeUser } from '../../src/lib/auth';
import { describeActor } from './actor';
import { renderKv } from './output';
import type { Prompter } from './prompt';
import { CliError, type Args, type CmdOutput, type CommandSpec, type Ctx, type Output } from './types';

export interface ExecuteDeps {
  prisma: PrismaClient;
  io: Output;
  prompter: Prompter;
  actor: SafeUser | null;
  /** 交互模式：stdin 与 stdout 都是 TTY。非交互时危险操作必须显式 --yes。 */
  interactive: boolean;
  yes: boolean;
}

export interface ExecuteResult {
  /** null 表示用户主动取消（不是错误，退出码 0）。 */
  output: CmdOutput | null;
}

export function isDangerous(cmd: CommandSpec): boolean {
  return !!cmd.danger && cmd.danger !== 'safe';
}

export async function executeCommand(
  cmd: CommandSpec,
  args: Args,
  deps: ExecuteDeps
): Promise<ExecuteResult> {
  const ctx: Ctx = { args, actor: deps.actor, prisma: deps.prisma, io: deps.io };

  if (isDangerous(cmd)) {
    // 只读预检。先于 --yes 闸，好让真问题（用户不存在 / 文章已删除）先报出来。
    //
    // describe **返回空数组** = 本次没有实际变更（例如目标已是那个角色）→ 跳过确认。
    // 但 describe **压根没声明**是另一回事：那意味着这条危险命令没人写后果说明，
    // 此时绝不能当成「无变更」放行 —— 按「有变更、但说不清后果」处理，照样要确认。
    // （注册表那边另有一条守卫要求 danger 必须配 describe，这里是运行期兜底。）
    const plan = cmd.describe ? await cmd.describe(ctx) : [];
    const nothingToDo = cmd.describe !== undefined && plan.length === 0;

    if (!nothingToDo) {
      const proceed = await confirmDanger(cmd, args, plan, deps);
      if (!proceed) return { output: null };
    }
  }

  return { output: await cmd.run(ctx) };
}

/** 确认闸。返回 false = 用户取消。 */
async function confirmDanger(
  cmd: CommandSpec,
  args: Args,
  plan: string[],
  deps: ExecuteDeps
): Promise<boolean> {
  const kind = cmd.danger === 'irreversible' ? '不可逆' : '破坏性';

  if (!deps.interactive) {
    // 非交互（管道 / CI）：--yes 之外一律拒绝，**绝不**去等 stdin。
    // 一个挂在 stdin 上的脚本是最坏的结果 —— 它看起来像卡死。
    if (deps.yes) return true;
    throw new CliError(`错误：${cmd.name} 是${kind}操作，非交互模式必须显式加 --yes`, 1, [
      ...planFrame(cmd, args, plan, deps),
      '',
      '  确认无误后重跑，并在命令末尾加上 --yes。',
    ]);
  }

  if (deps.yes) return true;

  // 确认屏走 stderr：stdout 留给命令结果（脚本可能把它重定向走）。
  for (const line of planFrame(cmd, args, plan, deps)) deps.io.error(line);
  return deps.prompter.confirm('确认执行？', false);
}

/** 「即将执行」框的完整内容。 */
function planFrame(cmd: CommandSpec, args: Args, plan: string[], deps: ExecuteDeps): string[] {
  return [
    '──────────────────────── 即将执行 ────────────────────────',
    `命令：${cmd.name}`,
    `执行者：${describeActor(deps.actor)}`,
    ...paramEcho(cmd, args),
    '──────────────────────────────────────────────────────',
    ...plan,
    '──────────────────────────────────────────────────────',
  ];
}

/** 参数回显。标记了 secret 的参数打码 —— 否则确认屏会把新密码直接印在屏幕上。 */
function paramEcho(cmd: CommandSpec, args: Args): string[] {
  const rows: [string, string][] = [];
  for (const spec of cmd.args) {
    const v = args[spec.name];
    if (v === undefined) continue;
    const text = Array.isArray(v) ? v.join(', ') : String(v);
    rows.push([spec.label, spec.secret ? '••••••' : text]);
  }
  if (rows.length === 0) return [];
  return ['', ...renderKv(rows).map((l) => `  ${l}`), ''];
}
