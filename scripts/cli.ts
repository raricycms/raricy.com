#!/usr/bin/env tsx
// ─────────────────────────────────────────────────────────────────────────────
// cli.ts —— 运维命令行入口（薄壳）
//
// 全部命令声明在 scripts/cli/registry.ts；本文件只负责：
//   1. 判断走哪个前端（命令式 / 交互式）
//   2. 解析 argv、构造 Ctx
//   3. 统一的输出与退出码
//
// 用法（对照 Flask）：
//   flask promote-admin <u>   →  npm run cli -- promote-admin <u>
//   flask fish grant <u> <n>  →  npm run cli -- fish grant <u> <n> [-d "说明"]
//
// 退出码（对齐 Flask）：0 成功 / 1 参数或用户错误 / 2 账户服务同步失败（本地已回滚）
//
// ⚠️ 惰性加载约定：本文件**不静态 import 任何 src/lib 的运行时值**，Prisma 只在
//    真正要执行命令时才 `await import()`。所以 `--help` 与向导菜单在没有数据库的
//    机器上也能渲染，且是瞬时的。
//
// ⚠️ 未迁移：`flask fish compensate`（全站群发补偿，涉及限频/批次幂等/断点续跑）
//    与 `flask import-blogs`。需要时另写专用脚本。
// ─────────────────────────────────────────────────────────────────────────────

import {
  commandHelp,
  generateHelp,
  parseCommandArgs,
  resolveCommand,
  splitGlobals,
  type GlobalFlags,
} from './cli/args';
import { createOutput, shouldUseColor } from './cli/output';
import { COMMANDS } from './cli/registry';
import { CliError, type CmdOutput, type CommandSpec, type Output } from './cli/types';

/** 执行一条已解析好的命令。返回值即进程退出码。 */
async function execute(cmd: CommandSpec, argv: string[], flags: GlobalFlags): Promise<number> {
  const args = parseCommandArgs(cmd, argv);
  const io = createOutput({ color: shouldUseColor(flags), json: flags.json });

  // ↓↓↓ 唯一一处加载 Prisma 的地方：--help 与参数错误都在此之前返回 ↓↓↓
  const { prisma } = await import('../src/lib/db');
  try {
    const out = await cmd.run({ args, actor: null, prisma, io });
    printResult(io, cmd, out, flags.json);
    return 0;
  } finally {
    await prisma.$disconnect().catch(() => {});
  }
}

/** 人读输出；--json 时 stdout 只留一个 JSON 对象，其余一律走 stderr。 */
function printResult(io: Output, cmd: CommandSpec, out: CmdOutput, jsonMode: boolean): void {
  const notes = out.notes ?? [];
  const warnings = out.warnings ?? [];

  if (jsonMode) {
    process.stdout.write(
      JSON.stringify({ ok: true, command: cmd.name, data: out.json ?? null }, null, 2) + '\n'
    );
    for (const n of notes) io.error(io.green(n));
    for (const w of warnings) io.error(io.yellow(w));
    return;
  }

  for (const l of out.lines ?? []) io.line(l);
  for (const n of notes) io.line(io.green(n));
  for (const w of warnings) io.line(io.yellow(w));
}

async function run(): Promise<number> {
  const argv = process.argv.slice(2);
  // 全局参数可能出现在任何位置，先整体摘一遍；剩下的 token 才是命令与它自己的参数。
  const { args: bare, flags } = splitGlobals(argv);

  // 不带参数：交互模式留给下一步（TTY 下进菜单向导）。眼下先打印帮助，
  // 且**非 TTY 时也必须打印帮助而不是猜** —— 管道 / 构建脚本里不能挂住等输入。
  if (bare.length === 0) {
    process.stdout.write(generateHelp(COMMANDS) + '\n');
    return 0;
  }

  const resolved = resolveCommand(COMMANDS, bare);
  if (!resolved) {
    throw new CliError(`错误：未知命令 ${bare[0]}。跑 \`npm run cli -- --help\` 看用法。`);
  }
  const { cmd, rest } = resolved;

  if (flags.help) {
    process.stdout.write(commandHelp(cmd) + '\n');
    return 0;
  }

  return execute(cmd, rest, flags);
}

async function main(): Promise<void> {
  const flags = splitGlobals(process.argv.slice(2)).flags;
  try {
    process.exitCode = await run();
  } catch (e) {
    const io = createOutput({ color: shouldUseColor(flags), json: false });
    if (e instanceof CliError) {
      // --json 下错误也要是 JSON，脚本才能统一解析
      if (flags.json) {
        process.stdout.write(
          JSON.stringify({ ok: false, error: { code: e.exitCode, message: e.message } }, null, 2) + '\n'
        );
      } else {
        io.error(io.red(e.message));
      }
      for (const d of e.details) io.error(d);
      process.exitCode = e.exitCode;
    } else {
      io.error(io.red('未捕获异常：'));
      io.error(e instanceof Error ? (e.stack ?? e.message) : String(e));
      process.exitCode = 1;
    }
  }
}

main();
