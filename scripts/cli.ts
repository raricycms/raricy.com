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
// ⚠️ 未迁移：`flask import-blogs`（历史博客导入；正文早已存 BlogContent 表）。
//    需要时另写专用脚本。
// ─────────────────────────────────────────────────────────────────────────────

import {
  commandHelp,
  generateHelp,
  parseCommandArgs,
  resolveCommand,
  splitGlobals,
  type GlobalFlags,
} from './cli/args';
import { actorFor } from './cli/actor';
import { executeCommand } from './cli/execute';
import { createOutput, printResult, shouldUseColor } from './cli/output';
import { createPrompter, isExitPromptError } from './cli/prompt';
import { COMMANDS } from './cli/registry';
import { CliError, type CmdOutput, type CommandSpec, type Output } from './cli/types';

/** stdin 与 stdout 都是 TTY 才算交互模式；管道 / 重定向下一律不弹提示。 */
function isInteractive(): boolean {
  return process.stdin.isTTY === true && process.stdout.isTTY === true;
}

/** 执行一条已解析好的命令。返回值即进程退出码。 */
async function execute(cmd: CommandSpec, argv: string[], flags: GlobalFlags): Promise<number> {
  const args = parseCommandArgs(cmd, argv);
  const io = createOutput({ color: shouldUseColor(flags), json: flags.json });

  // ↓↓↓ 唯一一处加载 Prisma 的地方：--help 与参数错误都在此之前返回 ↓↓↓
  const { prisma } = await import('../src/lib/db');
  try {
    const actor = await actorFor(cmd, prisma, io, { as: flags.as });
    const { output } = await executeCommand(cmd, args, {
      prisma,
      io,
      prompter: createPrompter(),
      actor,
      interactive: isInteractive(),
      yes: flags.yes,
    });

    if (output === null) {
      io.error(io.yellow('已取消，未做任何改动。'));
      return 0;
    }
    printResult(io, cmd.name, output, flags.json);
    return 0;
  } finally {
    await prisma.$disconnect().catch(() => {});
  }
}

async function run(): Promise<number> {
  const argv = process.argv.slice(2);
  // 全局参数可能出现在任何位置，先整体摘一遍；剩下的 token 才是命令与它自己的参数。
  const { args: bare, flags } = splitGlobals(argv);

  // 不带参数时两种走法：
  //   TTY + 非 --json → 进交互式菜单向导（每一步都有提示，不用背命令）
  //   其余（管道 / CI / --json）→ 打印帮助
  // **非 TTY 时绝不能猜**：管道或构建脚本里弹提示 = 挂住等输入，看起来像卡死。
  // --json 同理，它是给脚本用的，隐含非交互。
  if (bare.length === 0) {
    if (!isInteractive() || flags.json) {
      process.stdout.write(generateHelp(COMMANDS) + '\n');
      return 0;
    }

    const io = createOutput({ color: shouldUseColor(flags), json: false });
    const { prisma } = await import('../src/lib/db');
    try {
      const { wizardLoop } = await import('./cli/wizard');
      return await wizardLoop({ prisma, io, prompter: createPrompter(), as: flags.as });
    } finally {
      await prisma.$disconnect().catch(() => {});
    }
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
    // Ctrl-C 落在提问期间 = 用户取消，不是崩溃。
    if (isExitPromptError(e)) {
      process.stderr.write('\n已取消，未做任何改动。\n');
      process.exitCode = 0;
      return;
    }
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
