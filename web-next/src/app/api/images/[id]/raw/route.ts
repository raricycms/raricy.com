import fs from 'node:fs/promises';
import { getCurrentUser, hasAdminRights } from '@/lib/auth';
import { getImageForServe } from '@/lib/image-service';
import { sanitizeFilename, storagePathFor } from '@/lib/image-upload';

// 文件路由需 Node 运行时（fs 读盘）
export const runtime = 'nodejs';

function notFound(): Response {
  return new Response('Not Found', { status: 404 });
}

// GET /api/images/:id/raw — 从磁盘串流图片字节
//   · ignore → 404
//   · 私有图（isPublic = false）→ 仅作者 / 管理员可见
//   · SVG → Content-Disposition: attachment（强制下载，防内联 XSS，对齐 Flask）
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const img = await getImageForServe(id);
  if (!img || img.ignore) return notFound();

  if (img.isPublic === false) {
    const user = await getCurrentUser();
    if (!user || (user.id !== img.authorId && !hasAdminRights(user))) {
      return notFound(); // 私有图对无权访问者伪装成不存在
    }
  }

  let data: Buffer;
  try {
    data = await fs.readFile(storagePathFor(img.id, img.mimeType));
  } catch {
    return notFound();
  }

  const headers = new Headers({
    'Content-Type': img.mimeType,
    // 禁止浏览器 MIME 嗅探：即便有字节被塞进错误的 Content-Type，也不会被当成
    // SVG/HTML 渲染。与上传侧的 magic byte 校验互为兜底。
    'X-Content-Type-Options': 'nosniff',
    // 私有图绝不能进共享缓存（CDN / 反代 / 中间缓存），否则鉴权形同虚设：
    // 缓存命中后会绕过本路由的作者/管理员校验，直接向无权者下发。
    'Cache-Control': img.isPublic
      ? 'public, max-age=31536000, immutable'
      : 'private, no-store',
  });

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
