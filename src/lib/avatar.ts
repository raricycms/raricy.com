// ─────────────────────────────────────────────────────────────────────────────
// avatar.ts — 头像解析（/api/avatar/[id] 与画报渲染共用）
//
// 对齐 Flask /auth/avatar/<id>：优先用 instance/avatars/<id>.png（站长手工放的头像），
// 不存在则确定性生成 GitHub 风格 identicon（SVG）兜底 —— **永不 404、永不碎图**。
//
// 抽出来的理由是画报也要头像（要把它 base64 内嵌进 SVG），而**目录穿越守卫只能有一份**
// ——在路由里抄一遍就等于埋第二颗雷（见 docs/architecture.md §6.6）。
// ─────────────────────────────────────────────────────────────────────────────

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { generateIdenticonSvg } from '@/lib/identicon';

export interface ResolvedAvatar {
  buffer: Buffer;
  contentType: string;
}

/** 头像目录（真实数据在 instance/avatars/<uuid>.png）；缺省回退 ./instance/avatars。 */
export function avatarsDir(): string {
  return process.env.AVATARS_DIR || path.resolve(process.cwd(), './instance/avatars');
}

/**
 * 解析某个用户的头像字节。
 * id 只允许 UUID/字母数字-下划线，并在解析后确认仍在头像目录内（防目录穿越）；
 * 任何失败（不存在 / id 非法 / 读盘出错）都落到 identicon，绝不抛。
 */
export async function resolveAvatar(id: string): Promise<ResolvedAvatar> {
  if (/^[a-zA-Z0-9_-]+$/.test(id)) {
    try {
      const file = path.join(avatarsDir(), `${id}.png`);
      // 确认解析后仍在头像目录内
      if (path.dirname(path.resolve(file)) === path.resolve(avatarsDir())) {
        const buf = await readFile(file);
        return { buffer: buf, contentType: 'image/png' };
      }
    } catch {
      // 文件不存在 → 落到 identicon 兜底
    }
  }

  return {
    buffer: Buffer.from(generateIdenticonSvg(id), 'utf8'),
    contentType: 'image/svg+xml; charset=utf-8',
  };
}
