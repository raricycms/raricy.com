// GET /api/poster/favorite/:publicId — 公开收藏夹的分享二维码（PNG）
//
// ⚠️ 参数是 **6 位公开 ID**，不是内部 UUID —— 私密收藏夹没有这个句柄，所以它在
//    这里**结构性地不可达**（不是「记得判一下」）。这是需求里
//    「私密收藏夹不能导出二维码」的实现方式。
//
// 需要登录（与另两张海报一致）。二维码指向 /favorite/<id>，而那个页面是 core+ 可见的，
// 给游客生成一张打不开的码没有意义；顺带也解决了限频分桶 —— 免认证的话没有 uid 可用。
//
// 守卫链照 api/poster/collect/route.ts：限频 → siteOrigin 未配置 503 → 光栅化 →
// 响应头 inline + private, no-store + X-Robots-Tag: noindex，**不写 filename**
// （一旦给了文件名，前端 <a download="..."> 会被浏览器无视）。

import { getCurrentUser, isCoreUser } from '@/lib/auth';
import { apiErr } from '@/lib/format';
import { RULES, rateLimit } from '@/lib/rate-limit';
import { siteOrigin } from '@/lib/site-url';
import { renderFavoritePoster } from '@/lib/poster-render';
import { getPublicFavorite } from '@/lib/favorite-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return apiErr(401, '请先登录');
  if (!isCoreUser(user)) return apiErr(403, '需要核心用户权限');

  const gate = rateLimit(`poster:${user.id}`, RULES.posterMinute);
  if (!gate.allowed) return apiErr(429, '生成太频繁了，请稍后再试');

  const { id } = await ctx.params;
  // 只按公开句柄查、且过 PUBLIC_FAVORITE_WHERE —— 私密 / 不存在 / 已软删同为一个 404
  const res = await getPublicFavorite(id);
  if (!res.ok || !res.favorite.publicId) return apiErr(404, '收藏夹不存在');

  if (!siteOrigin()) return apiErr(503, '服务器未配置 SITE_URL，无法生成二维码');

  const png = await renderFavoritePoster({
    title: res.favorite.title,
    publicId: res.favorite.publicId,
    count: res.favorite.items.length,
  });

  return new Response(new Uint8Array(png), {
    headers: {
      'Content-Type': 'image/png',
      'Content-Disposition': 'inline',
      'Cache-Control': 'private, no-store',
      'X-Robots-Tag': 'noindex',
    },
  });
}
