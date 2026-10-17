import { resolveAvatar } from '@/lib/avatar';
import { prisma } from '@/lib/db';
import { generateIdenticonSvg } from '@/lib/identicon';

export const runtime = 'nodejs';

// GET /api/avatar/[id]
// 优先返回已存的头像文件（<id>.png），
// 不存在则确定性生成 GitHub 风格 identicon（SVG）兜底——永不 404、永不碎图。
// 解析逻辑在 src/lib/avatar.ts（画报渲染也要头像，共用同一份防穿越守卫）。
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const active = await prisma.user.findUnique({ where: { id }, select: { id: true } });
  const { buffer, contentType } = active
    ? await resolveAvatar(id)
    : { buffer: Buffer.from(generateIdenticonSvg(id)), contentType: 'image/svg+xml; charset=utf-8' };

  return new Response(new Uint8Array(buffer), {
    headers: {
      'Content-Type': contentType,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'public, max-age=86400',
    },
  });
}
