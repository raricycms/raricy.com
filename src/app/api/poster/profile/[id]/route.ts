import { getCurrentUser } from '@/lib/auth';
import { apiErr } from '@/lib/format';
import { RULES, rateLimit } from '@/lib/rate-limit';
import { siteOrigin } from '@/lib/site-url';
import { renderProfilePoster } from '@/lib/poster-render';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// GET /api/poster/profile/[id] — 个人主页画报（PNG）。
//
// 只允许给**自己**生成：这个功能的用途是「把自己的主页分享出去」，
// 而 /u/[id] 页面上的入口本来就只在自己主页显示。要放开给所有人，
// 改下面那行 403 即可（资料本身是公开的，放开不泄露任何东西）。
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return apiErr(401, '请先登录');

  const gate = rateLimit(`poster:${user.id}`, RULES.posterMinute);
  if (!gate.allowed) return apiErr(429, '生成太频繁了，请稍后再试');

  // SITE_URL 没配就拼不出绝对 URL —— 那种二维码扫出来是废的，宁可明确报错。
  if (!siteOrigin()) return apiErr(503, '服务器未配置 SITE_URL，无法生成二维码');

  const { id } = await params;
  if (id !== user.id) return apiErr(403, '只能生成自己的画报');

  const png = await renderProfilePoster(id);
  if (!png) return apiErr(404, '用户不存在');

  return new Response(new Uint8Array(png), {
    headers: {
      'Content-Type': 'image/png',
      // 只写 inline、**不写 filename**：一旦这里给了文件名，浏览器就把它当成下载名，
      // 前端 <a download="聪明山-xxx-主页画报.png"> 会被无视（实测：下载下来叫
      // raricy-poster.png）。文件名交给调用方 —— 只有它知道用户名。
      'Content-Disposition': 'inline',
      'Cache-Control': 'private, no-store',
      'X-Robots-Tag': 'noindex',
    },
  });
}
