// ─────────────────────────────────────────────────────────────────────────────
// registry.ts —— 命令注册表（唯一权威）
//
// 这里是**加命令的唯一入口**。加一条 = 往下面的数组里加一个 CommandSpec：
// `--help`、交互式向导、参数校验全部自动跟上，不存在「加了命令忘了更新文档」。
//
// ⚠️ 本文件与 commands/* 一律不许在顶层 import src/lib 的**运行时值** ——
//    只允许 `import type`。对服务层的调用一律写在 run() 里的 `await import()`，
//    这样 `--help` 与向导菜单在没有任何数据库的机器上也能渲染。
//    有一条静态守卫测试盯着这件事（tests/unit/cli-guards.test.ts）。
// ─────────────────────────────────────────────────────────────────────────────

import type { CommandSpec } from './types';
import { roleCommands } from './commands/roles';
import { userCommands } from './commands/users';
import { blogCommands } from './commands/blogs';
import { commentCommands } from './commands/comments';
import { clipCommands } from './commands/clips';
import { voteCommands } from './commands/votes';
import { imageCommands } from './commands/images';
import { inviteCommands } from './commands/invites';
import { fishCommands } from './commands/fish';
import { auditCommands } from './commands/audit';
import { appealCommands } from './commands/appeals';
import { statsCommands } from './commands/stats';
import { oauthCommands } from './commands/oauth';

export const COMMANDS: CommandSpec[] = [
  ...userCommands,
  ...roleCommands,
  ...blogCommands,
  ...commentCommands,
  ...clipCommands,
  ...voteCommands,
  ...imageCommands,
  ...inviteCommands,
  ...fishCommands,
  ...auditCommands,
  ...appealCommands,
  ...statsCommands,
  ...oauthCommands,
];

/** 按名字取命令。命令名可能多段（'oauth create-app'）。 */
export function findCommand(name: string): CommandSpec | undefined {
  return COMMANDS.find((c) => c.name === name);
}

/**
 * 迁移完整性闸：scripts/cli.ts（Flask 时代的 cli.mjs）支持过的全部命令路径。
 * 注册表必须是它的超集 —— 改注册表时漏掉一条老命令，这里会红。
 */
export const LEGACY_COMMANDS: string[] = [
  'promote-admin',
  'demote-admin',
  'promote-core',
  'demote-core',
  'promote-owner',
  'demote-owner',
  'fish grant',
  'fish deduct',
  'fish balance',
  'fish sync-retry',
  'oauth create-app',
  'oauth list-apps',
  'oauth disable-app',
  'oauth enable-app',
];
