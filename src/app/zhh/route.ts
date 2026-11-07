// GET /zhh — 生成邀请码（仅站长可访问的 GET 视图，纯文本返回）
//
// 站长 → 返回 12 位邀请码文本；非站长 → 403。
// 码格式必须与存量已发出的码一致（12 位 base62，注册侧按 length===12 校验），
// 不能改。
//
// 【索引】本路径不在 sitemap，且 `robots.ts` 的 disallow 已含 `/zhh`（不是「由宽松的
// allow 覆盖」——是显式挡住）。改 robots 时别把它删掉。
// 【注意：GET 有写副作用】每次**站长会话**访问都会 `generateInviteCode()` 插一条新码；
// 响应没有 Cache-Control、也没有限频，反复刷新会持续建码。这不是纯读接口。
import { getCurrentUser, isOwner } from '@/lib/auth';
import { generateInviteCode } from '@/lib/invite-code';

export const dynamic = 'force-dynamic'; // 依赖登录态且每次生成新码，禁用静态化

export async function GET() {
  const user = await getCurrentUser();
  if (!isOwner(user)) {
    return new Response('Forbidden', { status: 403 });
  }

  const code = await generateInviteCode();
  return new Response(code, {
    status: 200,
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
}
