// GET /zhh —— 网页发码入口已关闭（P01，2026-11-07 产品决定）
//
// 邀请码现在**只由运维 CLI 签发**（`npm run cli -- invite generate`，见 docs/cli.md 与
// scripts/cli/commands/invites.ts）。网页会话不再具备签发能力：站长本人访问也只回
// 410（Gone），不生成、不写库、不返回码。
//
// 保留这条路由（而不是删文件）是为了给旧书签/旧脚本一个**明确**的答复：410 说明
// 「入口退役了、不是路径打错」，比 404 更不容易被误判成站内路由坏了。
// 已经发放的有效邀请码不受影响，注册/补码升级照常可用。
//
// 【索引】robots.ts 的 disallow 仍含 `/zhh`（无需改）。
export const dynamic = 'force-dynamic'; // 依赖会话/请求，且明确不可缓存

export async function GET() {
  return new Response(
    '邀请码已改为由运维 CLI 签发：npm run cli -- invite generate\n本网页入口已停用（410 Gone）。',
    {
      status: 410,
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store',
      },
    }
  );
}
