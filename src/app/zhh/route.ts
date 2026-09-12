// GET /zhh — 生成邀请码（对齐 Flask home_bp /zhh：@owner_required + generate_invite_code()）
//
// 原实现是一个仅站长可访问的 GET 视图，直接把新生成的邀请码作为纯文本返回。
// 这里保持同一 URL 与语义：站长 → 返回 12 位邀请码文本；非站长 → 403（对齐原
// @owner_required 的 abort(403)）。robots.txt / robots.ts 已 Disallow: /zhh/。
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
