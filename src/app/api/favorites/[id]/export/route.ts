// GET /api/favorites/:id/export — 导出为 JSON 文件（所有者限定，私密也能导出）
//
// 导出物**只有标题 + 博客列表**，不含收藏夹 id、不含是否公开 ——
// 这正是「私密收藏夹可以导出 JSON」与「私密收藏夹不泄 id」能同时成立的原因：
// 文件里没有任何能反推出它身份的字段。
//
// 这是本站第一个应用层的文件下载接口，所以把既有先例里的两条纪律照抄过来
// （api/images/[id]/raw/route.ts 与 api/poster/*）：
//   · 中文文件名必须走 RFC 5987 的 filename*，并用 ASCII 名兜底；
//   · 标题是不可信输入，**绝不能直接拼进响应头**（CRLF 注入）。
// 导入端（/api/favorites/import）只认 id / title / url 三个字段，所以这个形状是闭环的。
import { exportFavorite } from '@/lib/favorite-service';
import { siteOrigin } from '@/lib/site-url';
import { favoriteFail, requireCoreUser } from '../../_shared';

export const dynamic = 'force-dynamic';

/**
 * RFC 5987 的 ext-value 编码。
 *
 * encodeURIComponent 会漏掉 `!'()*`，而这几个字符不属于 attr-char（`*` 尤其会与
 * ext-value 的语法撞车），所以补一轮手动编码。这样 CR/LF/引号也一并被百分号化，
 * 标题里塞换行也注入不了响应头。
 */
function rfc5987(value: string): string {
  return encodeURIComponent(value).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireCoreUser();
  if ('denied' in auth) return auth.denied;

  const { id } = await ctx.params;
  const res = await exportFavorite(id, auth.user.id);
  if (!res.ok) return favoriteFail(res.reason);

  const origin = siteOrigin();
  const payload = {
    version: res.data.version,
    title: res.data.title,
    // url 只是为了让人打开文件时能看懂/手改；导入端优先认 id，id 不在时从 url 末段取
    blogs: res.data.blogs.map((b) => ({
      id: b.id,
      title: b.title,
      ...(origin ? { url: `${origin}/blog/${b.id}` } : {}),
    })),
  };

  return new Response(JSON.stringify(payload, null, 2), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      // ASCII 兜底名（不含用户输入）+ RFC 5987 真名
      'Content-Disposition': `attachment; filename="favorite.json"; filename*=UTF-8''${rfc5987(
        `${res.data.title}.json`
      )}`,
      'Cache-Control': 'private, no-store',
      'X-Robots-Tag': 'noindex',
    },
  });
}
