import fs from 'node:fs/promises';
import { getCurrentUser, hasAdminRights } from '@/lib/auth';
import { getImageForServe } from '@/lib/image-service';
import { sanitizeFilename, storagePathFor } from '@/lib/image-upload';
import {
  PRIVATE_BYTES_CACHE_CONTROL,
  PUBLIC_BYTES_CACHE_CONTROL,
  ifNoneMatchMatches,
  weakFileEtag,
} from '@/lib/http-cache';

// 文件路由需 Node 运行时（fs 读盘）
export const runtime = 'nodejs';

/**
 * 所有 404 都带 `Cache-Control: no-store`。
 *
 * 这条路由上的 404 有三重身份：不存在 / 已软删 / 私有图对无权者伪装成不存在。
 * 无论哪一种都不能被记住 —— 尤其「已软删」：它正是删图的正常反馈，一旦被浏览器
 * 或中间缓存存下来，访客下次回来连问都不问，会一直对着一张已删除的图（或者一直
 * 裂着，即使图已经恢复）。
 */
function notFound(): Response {
  return new Response('Not Found', { status: 404, headers: { 'Cache-Control': 'no-store' } });
}

// GET /api/images/:id/raw — 从磁盘串流图片字节
//   · ignore → 404
//   · 私有图（isPublic = false）→ 仅作者 / 管理员可见
//   · SVG → Content-Disposition: attachment（强制下载，防内联 XSS）
//
// 【缓存口径：`public, no-cache` + 弱 ETag，**不是**一年 immutable】
// 图片 ID 定稿后内容不变（这一点以前被拿来论证「可以 immutable」），但**存在性**
// 会变：图床里的「删除」是软删，同一个 URL 从此返回 404。发 immutable 就等于
// 告诉浏览器「这一年别回来问」，于是删掉的图在看过这篇博客的访客屏幕上一直活着
// （线上真发生过的那次「删了图还能看见」）。
// 现在每次使用前回来验证：没变 → 304（零字节），删了 → 404。
// 详见 src/lib/http-cache.ts 的文件头。
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const img = await getImageForServe(id);
  if (!img || img.ignore) return notFound();

  if (img.isPublic === false) {
    const user = await getCurrentUser();
    if (!user || (user.id !== img.authorId && !hasAdminRights(user))) {
      return notFound(); // 私有图对无权访问者伪装成不存在
    }
  }

  const filePath = storagePathFor(img.id, img.mimeType);

  const headers = new Headers({
    'Content-Type': img.mimeType,
    // 禁止浏览器 MIME 嗅探：即便有字节被塞进错误的 Content-Type，也不会被当成
    // SVG/HTML 渲染。与上传侧的 magic byte 校验互为兜底。
    'X-Content-Type-Options': 'nosniff',
    // 私有图绝不能进共享缓存（CDN / 反代 / 中间缓存），否则鉴权形同虚设：
    // 缓存命中后会绕过本路由的作者/管理员校验，直接向无权者下发。
    // 公开图是 no-cache（见上面与 http-cache.ts），不是长缓存。
    'Cache-Control': img.isPublic
      ? PUBLIC_BYTES_CACHE_CONTROL
      : PRIVATE_BYTES_CACHE_CONTROL,
    // robots.txt 里 /api/ 整段 disallow，只在 allow 列表里给 /api/images/ 开了口
    // （见 src/app/robots.ts）—— 那是**按路径**放行，粒度不到单张图。私有图必须
    // 逐张挡掉，靠的就是这个响应头：公开图 all、私有图 noindex。
    'X-Robots-Tag': img.isPublic ? 'all' : 'noindex',
  });

  // 公开图走条件请求：**先 stat、命中就 304**，真要下发字节时才 readFile。
  // 304 省掉的是整张图的磁盘读与传输（图片可以到 10MB），不是只省一个响应头。
  // 私有图是 no-store，没有条件请求可言，也绝不能按 ETag 走 304 —— 那等于
  // 把「作者能看」这一判断结果缓存出去。
  if (img.isPublic) {
    let stat: { size: number; mtimeMs: number };
    try {
      stat = await fs.stat(filePath);
    } catch {
      return notFound();
    }
    const etag = weakFileEtag(stat);
    headers.set('ETag', etag);
    if (ifNoneMatchMatches(req.headers.get('if-none-match'), etag)) {
      return new Response(null, { status: 304, headers });
    }
  }

  let data: Buffer;
  try {
    data = await fs.readFile(filePath);
  } catch {
    return notFound();
  }

  if (img.mimeType === 'image/svg+xml') {
    // SVG 以附件形式下发，避免浏览器内联执行脚本
    const base = sanitizeFilename(img.filename).replace(/\.svg$/i, '') || 'image';
    const asciiBase = base.replace(/[^\x20-\x7e]/g, '_'); // header 只允许 ASCII
    headers.set(
      'Content-Disposition',
      `attachment; filename="${asciiBase}.svg"; filename*=UTF-8''${encodeURIComponent(`${base}.svg`)}`
    );
  }

  return new Response(new Uint8Array(data), { headers });
}
