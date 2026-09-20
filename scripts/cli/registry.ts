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
import { frameCommands } from './commands/frames';

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
  ...frameCommands,
];

/** 按名字取命令。命令名可能多段（'oauth create-app'）。 */
export function findCommand(name: string): CommandSpec | undefined {
  return COMMANDS.find((c) => c.name === name);
}

/**
 * 迁移完整性闸：历史 CLI（cli.mjs）支持过的全部命令路径。
 * 注册表必须是它的超集 —— 改注册表时漏掉一条老命令，这里会红。
 *
 * ⚠️ 只有**刻意撤销**的命令才从这份名单里去掉（并在此注明），
 *    别用它来表达「暂时没人用」。
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
  // 'fish sync-retry' 已随账户微服务一起撤销（账户搬进站内后不再有「本地已提交、
  // 远端没落地」的行可重放）。这是**刻意**去掉的一条，不是重构中弄丢了 ——
  // 上面那条纪律说的就是这种情况。'fish pending' 同理（它从来不在历史名单里）。
  'fish credential-list',
  'fish credential-revoke',
  'fish webhooks',
  'fish webhook-retry',
  'oauth create-app',
  'oauth list-apps',
  'oauth disable-app',
  'oauth enable-app',
];
