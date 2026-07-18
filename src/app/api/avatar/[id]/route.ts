import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { generateIdenticonSvg } from '@/lib/identicon';

export const runtime = 'nodejs';

// 头像目录（真实数据在 instance/avatars/<uuid>.png）；缺省回退 ./instance/avatars。
function avatarsDir(): string {
  return process.env.AVATARS_DIR || path.resolve(process.cwd(), './instance/avatars');
}

// GET /api/avatar/[id]
// 对齐 Flask /auth/avatar/<id>：优先返回已存的头像文件（<id>.png），
// 不存在则确定性生成 GitHub 风格 identicon（SVG）兜底——永不 404、永不碎图。
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  // 防目录穿越：id 只允许 UUID/字母数字-下划线
  if (/^[a-zA-Z0-9_-]+$/.test(id)) {
    try {
      const file = path.join(avatarsDir(), `${id}.png`);
      // 确认解析后仍在头像目录内
      if (path.dirname(path.resolve(file)) === path.resolve(avatarsDir())) {
        const buf = await readFile(file);
        return new Response(new Uint8Array(buf), {
          headers: {
            'Content-Type': 'image/png',
            'Cache-Control': 'public, max-age=86400',
          },
        });
      }
    } catch {
      // 文件不存在 → 落到 identicon 兜底
    }
  }

  const svg = generateIdenticonSvg(id);
  return new Response(svg, {
    headers: {
      'Content-Type': 'image/svg+xml; charset=utf-8',
      'Cache-Control': 'public, max-age=86400',
    },
  });
}
