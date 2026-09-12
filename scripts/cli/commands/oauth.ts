// ─────────────────────────────────────────────────────────────────────────────
// oauth.ts —— OAuth 2.0 第三方应用管理（对齐 Flask 时代的 cli.mjs）
//
// 协议细节与安全约束见 docs/oauth.md。要点：client_secret 用与 User.passwordHash
// 同款的 werkzeug 兼容哈希入库，**原始值永不落库**，所以它只在创建时显示一次。
//
// 【关于 --owner】这里解析出来的 owner 会写进 oauth_applications.created_by，
// 是个指向 users.id 的**真实外键** —— 不能用伪造 ID，所以「库内一个站长都没有」
// 时必须报错，而不是自动造一个。
// ─────────────────────────────────────────────────────────────────────────────

import { CliError, type CommandSpec, type Ctx } from '../types';

const OWNER_SELECT = { id: true, username: true, role: true } as const;

/**
 * 解析应用 owner：`--owner` 指定优先，否则取库内最早的站长。
 * 与 scripts/cli.ts 里 oauth create-app 的历史行为逐字一致。
 */
async function resolveOwner(ctx: Ctx, ownerUsername: string | undefined) {
  if (ownerUsername) {
    const owner = await ctx.prisma.user.findUnique({
      where: { username: ownerUsername },
      select: OWNER_SELECT,
    });
    if (!owner) throw new CliError(`错误：用户 ${ownerUsername} 不存在`);
    if (owner.role !== 'owner') throw new CliError(`错误：${ownerUsername} 不是站长`);
    return owner;
  }
  const owner = await ctx.prisma.user.findFirst({
    where: { role: 'owner' },
    select: OWNER_SELECT,
    orderBy: { createdAt: 'asc' },
  });
  if (!owner) throw new CliError('错误：库内无站长用户，请用 --owner <username> 指定');
  return owner;
}

export const oauthCommands: CommandSpec[] = [
  {
    name: 'oauth list-apps',
    summary: '列出全部 OAuth 应用',
    group: 'oauth',
    order: 0,
    readOnly: true,
    args: [],
    async run(ctx) {
      const { listOAuthApplications } = await import('../../../src/lib/oauth');
      const apps = await listOAuthApplications();
      if (apps.length === 0) return { lines: [ctx.io.yellow('（暂无 OAuth 应用）')], json: { apps: [] } };

      const lines: string[] = [];
      for (const app of apps) {
        const status = app.disabledAt ? ctx.io.yellow('已禁用') : ctx.io.green('启用中');
        const uris = JSON.parse(app.redirectUris) as string[];
        lines.push(`${app.name}  [${status}]`);
        lines.push(`  id:        ${app.id}`);
        lines.push(`  client_id: ${app.clientId}`);
        lines.push(`  callback:  ${uris.join(', ')}`);
        if (app.homepageUrl) lines.push(`  homepage:  ${app.homepageUrl}`);
        if (app.description) lines.push(`  desc:      ${app.description}`);
      }
      return {
        lines,
        json: {
          apps: apps.map((a) => ({
            id: a.id,
            clientId: a.clientId,
            name: a.name,
            redirectUris: JSON.parse(a.redirectUris) as string[],
            homepageUrl: a.homepageUrl,
            description: a.description,
            disabled: !!a.disabledAt,
          })),
        },
      };
    },
  },
  {
    name: 'oauth create-app',
    summary: '注册新应用（client_secret 仅显示一次）',
    group: 'oauth',
    order: 1,
    needsActor: false,
    args: [
      {
        name: 'name',
        flags: [],
        positional: 0,
        required: true,
        label: '应用名',
        help: '应用显示名',
        prompt: { type: 'input' as const },
      },
      {
        name: 'owner',
        flags: ['--owner'],
        label: '归属站长',
        help: '写进 created_by 的用户名；省略则取库内最早的站长',
        prompt: { type: 'input' as const },
      },
      {
        name: 'homepageUrl',
        flags: ['--homepage'],
        label: '应用主页',
        help: '可选，应用自己的站点地址',
        prompt: { type: 'input' as const },
      },
      {
        name: 'description',
        flags: ['-d', '--description'],
        label: '说明',
        help: '可选，应用用途说明',
        prompt: { type: 'input' as const },
      },
      {
        name: 'redirectUris',
        flags: ['--redirect-uri'],
        repeatable: true,
        required: true,
        label: '回调 URI',
        help: '可重复；授权码只回调到这里，精确匹配（无通配/前缀）',
        prompt: { type: 'input' as const },
      },
    ],
    async run(ctx) {
      const owner = await resolveOwner(ctx, ctx.args.owner ? String(ctx.args.owner) : undefined);
      const { createOAuthApplication } = await import('../../../src/lib/oauth');

      const created = await createOAuthApplication(
        {
          name: String(ctx.args.name),
          description: ctx.args.description ? String(ctx.args.description) : null,
          homepageUrl: ctx.args.homepageUrl ? String(ctx.args.homepageUrl) : null,
          redirectUris: (ctx.args.redirectUris as string[]) ?? [],
        },
        owner.id
      );

      return {
        lines: [
          ctx.io.green(
            `成功：已创建应用 ${created.application.name}（owner: ${owner.username}）`
          ),
          '',
          `  client_id:     ${created.clientId}`,
          `  client_secret: ${created.clientSecret}`,
          '',
          ctx.io.yellow('  ⚠️  client_secret 仅此一次显示，请立即复制保存。'),
        ],
        json: { clientId: created.clientId, clientSecret: created.clientSecret, owner: owner.username },
      };
    },
  },
  ...(['disable-app', 'enable-app'] as const).map(
    (name, i): CommandSpec => ({
      name: `oauth ${name}`,
      summary: name === 'disable-app' ? '禁用应用（token 校验随即失败）' : '重新启用应用',
      group: 'oauth',
      order: i + 2,
      args: [
        {
          name: 'idOrClientId',
          flags: [],
          positional: 0,
          required: true,
          label: '应用 id 或 client_id',
          help: '两者都可以',
          prompt: { type: 'input' as const },
        },
      ],
      async run(ctx) {
        const idOrCid = String(ctx.args.idOrClientId);
        const oauth = await import('../../../src/lib/oauth');
        const app = await oauth.findApplication(idOrCid);
        if (!app) throw new CliError(`错误：未找到应用 ${idOrCid}`);

        const updated =
          name === 'disable-app'
            ? await oauth.disableOAuthApplication(app.id)
            : await oauth.enableOAuthApplication(app.id);

        const verb = name === 'disable-app' ? '禁用' : '启用';
        return {
          lines: [ctx.io.green(`成功：已${verb}应用 ${updated.name}`)],
          json: { id: updated.id, name: updated.name, disabled: !!updated.disabledAt },
        };
      },
    })
  ),
];
