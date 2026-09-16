import { resolveAvatar } from '@/lib/avatar';

export const runtime = 'nodejs';

// GET /api/avatar/[id]
// 对齐 Flask /auth/avatar/<id>：优先返回已存的头像文件（<id>.png），
// 不存在则确定性生成 GitHub 风格 identicon（SVG）兜底——永不 404、永不碎图。
// 解析逻辑在 src/lib/avatar.ts（画报渲染也要头像，共用同一份防穿越守卫）。
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { buffer, contentType } = await resolveAvatar(id);

  return new Response(new Uint8Array(buffer), {
    headers: {
      'Content-Type': contentType,
      'Cache-Control': 'public, max-age=86400',
    },
  });
}
