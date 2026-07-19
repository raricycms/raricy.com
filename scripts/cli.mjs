#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// cli.mjs —— 运维命令行（对齐 Flask app/cli.py 的 `flask <cmd>`）
//
// 【为什么必须有】Flask 侧有 8 个 CLI 命令（升降权限、发/扣鱼干…）。删掉 Flask 后
// 若没有等价物，就**失去了给人升管理员、手动发鱼干的运维手段** —— 这类操作没有
// 网页入口（也不该有），只能在服务器上跑。
//
// 用法（对照 Flask）：
//   flask promote-admin <u>   →  npm run cli -- promote-admin <u>
//   flask fish grant <u> <n>  →  npm run cli -- fish grant <u> <n> [-d "说明"]
//   flask fish balance <u>    →  npm run cli -- fish balance <u>
//
// 全部命令：
//   promote-admin / demote-admin / promote-core / demote-core / promote-owner / demote-owner
//   fish grant <username> <amount> [-d 说明]
//   fish deduct <username> <amount> [-d 说明]
//   fish balance <username>
//   oauth create-app <name> [--owner <username>] [--homepage URL] [-d 说明] --redirect-uri URI [--redirect-uri URI2 ...]
//   oauth list-apps
//   oauth disable-app <id_or_client_id>
//   oauth enable-app  <id_or_client_id>
//
// 退出码（对齐 Flask）：0 成功 / 1 参数或用户错误 / 2 账户服务同步失败（本地已回滚）
//
// ⚠️ 未迁移：`flask fish compensate`（全站群发补偿）。它涉及限频、批次幂等、断点续跑，
//    且是一次性运营动作 —— 需要时另写专用脚本（参考 compensate-unclaimed-fortunes.mjs）。
//    `flask import-blogs` 亦未迁：正文早已存 DB（BlogContent），该命令是历史导入工具。
// ─────────────────────────────────────────────────────────────────────────────

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createRequire } from 'node:module';

// 让脚本能直接 import src/lib 的 TS（走 tsx，与测试同一套解析）
const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ── 输出（ANSI 颜色，对齐 Flask 的 click.echo 配色）─────────────────────────
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;
const die = (msg, code = 1) => {
  console.error(msg);
  process.exit(code);
};

// ── 角色命令的语义表（逐条对齐 app/cli.py）──────────────────────────────────
//
// 每项：允许从哪些角色变更、变更到什么、各分支的文案。文案逐字照抄 Flask。
const ROLE_COMMANDS = {
  'promote-admin': {
    // 已是 admin/owner → 提示；owner 不降级（Flask: `if role != 'owner': role = 'admin'`）
    run: (role) =>
      ['admin', 'owner'].includes(role)
        ? { kind: 'notice', msg: (u) => yellow(`提示：${u} 已是管理员`) }
        : { kind: 'set', to: 'admin', msg: (u) => green(`成功：已授予 ${u} 管理员权限`) },
  },
  'demote-admin': {
    run: (role) =>
      role === 'owner'
        ? { kind: 'error', msg: (u) => red(`错误：${u} 是站长，请先使用 demote-owner`) }
        : role !== 'admin'
          ? { kind: 'notice', msg: (u) => yellow(`提示：${u} 不是管理员`) }
          : {
              kind: 'set',
              to: 'core',
              msg: (u) => green(`成功：已移除 ${u} 的管理员权限（降级为核心用户）`),
            },
  },
  'promote-core': {
    run: (role) =>
      ['core', 'admin', 'owner'].includes(role)
        ? { kind: 'notice', msg: (u) => yellow(`提示：${u} 已是核心用户（或更高角色）`) }
        : { kind: 'set', to: 'core', msg: (u) => green(`成功：已授予 ${u} 核心用户权限`) },
  },
  'demote-core': {
    run: (role) =>
      role !== 'core'
        ? { kind: 'notice', msg: (u) => yellow(`提示：${u} 不是核心用户（或已超出该角色范围）`) }
        : { kind: 'set', to: 'user', msg: (u) => green(`成功：已移除 ${u} 的核心用户权限`) },
  },
  'promote-owner': {
    run: (role) =>
      role === 'owner'
        ? { kind: 'notice', msg: (u) => yellow(`提示：${u} 已是站长`) }
        : { kind: 'set', to: 'owner', msg: (u) => green(`成功：已授予 ${u} 站长权限`) },
  },
  'demote-owner': {
    // 站长降为 admin（保留管理员），对齐 Flask
    run: (role) =>
      role !== 'owner'
        ? { kind: 'notice', msg: (u) => yellow(`提示：${u} 不是站长`) }
        : {
            kind: 'set',
            to: 'admin',
            msg: (u) => green(`成功：已移除 ${u} 的站长权限（保留管理员）`),
          },
  },
};

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];

  if (!cmd || cmd === '--help' || cmd === '-h') {
    console.log(`用法：npm run cli -- <命令> [参数]

角色管理（对齐 flask promote-admin 等）：
  promote-admin <username>     授予管理员
  demote-admin  <username>     移除管理员（降为核心用户）
  promote-core  <username>     授予核心用户
  demote-core   <username>     移除核心用户（降为普通用户）
  promote-owner <username>     授予站长
  demote-owner  <username>     移除站长（保留管理员）

小鱼干（对齐 flask fish ...）：
  fish grant   <username> <amount> [-d "说明"]   赠送（fail-closed）
  fish deduct  <username> <amount> [-d "说明"]   扣减（fail-closed）
  fish balance <username>                        查询余额

OAuth 2.0 第三方应用：
  oauth create-app <name> [--owner <username>] [--homepage URL] [-d 说明] --redirect-uri URI [...]   注册新应用，client_secret 仅显示一次
  oauth list-apps                                                    列出全部应用
  oauth disable-app <id|client_id>                                   禁用（保留 token 但 token 验证失败）
  oauth enable-app  <id|client_id>                                   恢复

退出码：0 成功 / 1 参数或用户错误 / 2 账户服务同步失败（本地已回滚）`);
    process.exit(0);
  }

  // 动态 import：让 --help 不必加载 Prisma
  const { prisma } = await import('../src/lib/db.ts');

  // ── 角色命令 ──────────────────────────────────────────────────────────────
  if (ROLE_COMMANDS[cmd]) {
    const username = argv[1];
    if (!username) die(red(`错误：缺少用户名。用法：npm run cli -- ${cmd} <username>`));

    const user = await prisma.user.findUnique({
      where: { username },
      select: { id: true, role: true },
    });
    if (!user) die(red(`错误：用户 ${username} 不存在`));

    const action = ROLE_COMMANDS[cmd].run(user.role ?? 'user');
    if (action.kind === 'error') die(action.msg(username));
    if (action.kind === 'notice') {
      console.log(action.msg(username));
      process.exit(0);
    }
    await prisma.user.update({ where: { id: user.id }, data: { role: action.to } });
    console.log(action.msg(username));
    process.exit(0);
  }

  // ── fish 命令组 ───────────────────────────────────────────────────────────
  if (cmd === 'fish') {
    const sub = argv[1];
    const username = argv[2];
    if (!sub) die(red('错误：缺少子命令（grant / deduct / balance）'));
    if (!username) die(red(`错误：缺少用户名。用法：npm run cli -- fish ${sub} <username> ...`));

    const user = await prisma.user.findUnique({
      where: { username },
      select: { id: true, driedFish: true },
    });
    if (!user) die(red(`错误：用户 ${username} 不存在`));

    if (sub === 'balance') {
      const { getBalance } = await import('../src/lib/fish-service.ts');
      console.log(`${username} 的小鱼干余额：${await getBalance(user.id)}`);
      process.exit(0);
    }

    if (sub !== 'grant' && sub !== 'deduct') die(red(`错误：未知子命令 ${sub}`));

    const amount = Number.parseInt(argv[3], 10);
    if (!Number.isInteger(amount) || amount <= 0) {
      die(red('错误：amount 必须为正整数'));
    }
    const dIdx = argv.findIndex((a) => a === '-d' || a === '--description');
    const description =
      dIdx >= 0 && argv[dIdx + 1]
        ? argv[dIdx + 1]
        : sub === 'grant'
          ? '管理员手动赠送'
          : '管理员手动扣减';

    const { adminGrantFish, adminDeductFish } = await import('../src/lib/fish-admin.ts');
    const { accountServiceEnabled } = await import('../src/lib/account-client.ts');
    const remote = accountServiceEnabled();
    try {
      const balance =
        sub === 'grant'
          ? await adminGrantFish(user.id, amount, description)
          : await adminDeductFish(user.id, amount, description);
      console.log(
        green(`成功：已${sub === 'grant' ? '赠送' : '扣减'} ${amount} 小鱼干${sub === 'grant' ? '给' : '从'} ${username}`)
      );
      console.log(`  当前余额：${balance}`);
      // 别无条件打印「已同步」—— dev fallback 下压根没打远端，那样会误导运维
      // 以为账目已经平了。
      if (remote) {
        console.log('  已同步至账户服务');
      } else {
        console.log(yellow('  ⚠️ 账户服务未配置，仅写入本地库（远端账目未同步）'));
      }
      process.exit(0);
    } catch (e) {
      // fail-closed：本地事务已回滚，余额未变，返回退出码 2（对齐 Flask）
      const isBiz = e && typeof e === 'object' && e.name === 'FishBusinessError';
      if (isBiz) die(red(`错误：${e.message}`), 1);
      console.error(red('失败：账户服务同步失败，本地事务已回滚'));
      console.error(`  原因: ${e?.message ?? e}`);
      console.error(`  本地余额未变更（${user.driedFish}），请稍后重试。`);
      process.exit(2);
    }
  }

  // ── oauth 命令组 ─────────────────────────────────────────────────────────
  if (cmd === 'oauth') {
    const sub = argv[1];
    if (!sub) die(red('错误：缺少 oauth 子命令（create-app / list-apps / disable-app / enable-app）'));

    const oauth = await import('../src/lib/oauth.ts');

    if (sub === 'list-apps') {
      const apps = await oauth.listOAuthApplications();
      if (apps.length === 0) {
        console.log(yellow('（暂无 OAuth 应用）'));
        process.exit(0);
      }
      for (const app of apps) {
        const status = app.disabledAt ? yellow('已禁用') : green('启用中');
        const uris = JSON.parse(app.redirectUris);
        console.log(`${app.name}  [${status}]`);
        console.log(`  id:        ${app.id}`);
        console.log(`  client_id: ${app.clientId}`);
        console.log(`  callback:  ${uris.join(', ')}`);
        if (app.homepageUrl) console.log(`  homepage:  ${app.homepageUrl}`);
        if (app.description) console.log(`  desc:      ${app.description}`);
      }
      process.exit(0);
    }

    if (sub === 'create-app') {
      const name = argv[2];
      if (!name) die(red('错误：缺少应用名。用法：npm run cli -- oauth create-app <name> --redirect-uri URI [...]'));

      // 解析参数：--owner / --homepage / -d / --redirect-uri (可重复)
      let ownerUsername = '';
      let homepage = '';
      let description = '';
      const redirectUris = [];
      for (let i = 3; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--owner') {
          ownerUsername = argv[++i] || '';
        } else if (a === '--homepage') {
          homepage = argv[++i] || '';
        } else if (a === '-d' || a === '--description') {
          description = argv[++i] || '';
        } else if (a === '--redirect-uri') {
          const v = argv[++i];
          if (!v) die(red('错误：--redirect-uri 后必须接一个 URI'));
          redirectUris.push(v);
        } else {
          die(red(`错误：未知参数 ${a}`));
        }
      }
      if (redirectUris.length === 0) {
        die(red('错误：至少需要一个 --redirect-uri'));
      }

      // owner 解析：--owner 指定 → 否则取库内第一个 owner
      let owner;
      if (ownerUsername) {
        owner = await prisma.user.findUnique({
          where: { username: ownerUsername },
          select: { id: true, username: true, role: true },
        });
        if (!owner) die(red(`错误：用户 ${ownerUsername} 不存在`));
        if (owner.role !== 'owner') die(red(`错误：${ownerUsername} 不是站长`));
      } else {
        owner = await prisma.user.findFirst({
          where: { role: 'owner' },
          select: { id: true, username: true, role: true },
          orderBy: { createdAt: 'asc' },
        });
        if (!owner) die(red('错误：库内无站长用户，请用 --owner <username> 指定'));
      }

      const created = await oauth.createOAuthApplication(
        {
          name,
          description: description || null,
          homepageUrl: homepage || null,
          redirectUris,
        },
        owner.id
      );

      console.log(green(`成功：已创建应用 ${created.application.name}（owner: ${owner.username}）`));
      console.log('');
      console.log(`  client_id:     ${created.clientId}`);
      console.log(`  client_secret: ${created.clientSecret}`);
      console.log('');
      console.log(yellow('  ⚠️  client_secret 仅此一次显示，请立即复制保存。'));
      process.exit(0);
    }

    if (sub === 'disable-app' || sub === 'enable-app') {
      const idOrCid = argv[2];
      if (!idOrCid) die(red(`错误：缺少应用 id 或 client_id。用法：npm run cli -- oauth ${sub} <id|client_id>`));
      const app = await oauth.findApplication(idOrCid);
      if (!app) die(red(`错误：未找到应用 ${idOrCid}`));
      const updated = sub === 'disable-app'
        ? await oauth.disableOAuthApplication(app.id)
        : await oauth.enableOAuthApplication(app.id);
      console.log(green(`成功：已${sub === 'disable-app' ? '禁用' : '启用'}应用 ${updated.name}`));
      process.exit(0);
    }

    die(red(`错误：未知 oauth 子命令 ${sub}`));
  }

  die(red(`错误：未知命令 ${cmd}。跑 \`npm run cli -- --help\` 看用法。`));
}

main().catch((e) => {
  console.error(red('未捕获异常：'), e);
  process.exit(1);
});
