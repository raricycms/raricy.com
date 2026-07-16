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
    'Cache-Control': 'public, max-age=31536000, immutable',
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
