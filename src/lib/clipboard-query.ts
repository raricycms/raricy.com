// ─────────────────────────────────────────────────────────────────────────────
// clipboard-query.ts — 云剪贴板的**只读**查询（含公开性判定）
//
// 读取正文引用与写入校验共用这条查询，查询本身只依赖 Prisma 和格式工具。
//
// 规则随查询本身（软删不可见、私有仅本人 / 站长）；写用例仍在 clipboard-service。
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from './db';
import { parseContentFormat } from './content-format';
import type { ContentFormat } from './content-format';
import { createHash } from 'node:crypto';

export type GetClipResult =
  | { ok: true; clip: ClipDetail }
  | { ok: false; reason: 'not_found' | 'forbidden' };

export interface ClipDetail {
  id: string;
  title: string;
  authorId: string;
  authorName: string | null;
  publicity: boolean;
  content: string;
  /**
   * 正文格式。**null = 库里的值不认识**（或正文行缺失）—— 绝不猜成 markdown：
   * 猜错等于把另一种语言的源码交给 Markdown 解析器。读取方必须保留字面量 / 走链接。
   */
  format: ContentFormat | null;
  /** 写入时记录的语法版本，随正文一起通过 API 返回。 */
  syntaxVersion: string | null;
  /** Shared by API, member embeds and public embeds. */
  version: string;
  createdAt: Date | null;
}

/**
 * 取剪贴板详情（含可见性判定）。
 *
 * ignore=true（软删除）→ not_found；私有（publicity=false）且非作者 → forbidden。
 *
 * @param viewerIsOwner 观看者是否为站长。★ 别漏 ★ —— 可见性判定是
 *   「publicity=true 或 本人 或 站长」：站长能看任何人的私有剪贴板
 *   （他本来就有硬删图床、裁决申诉这类权限，看私有内容属于同一档）。
 *   这个例外一度漏掉，站长访问会吃 403，连页面上那个「删除」按钮都够不着
 *   —— 而删除权限是给了他的。
 *   调用方必须显式传，不给默认 true：默认放行的参数一旦漏传就是越权。
 */
export async function getClip(
  id: string,
  viewerId?: string,
  viewerIsOwner = false
): Promise<GetClipResult> {
  const clip = await prisma.clipBoard.findFirst({
    where: { id, ignore: false },
    select: {
      id: true,
      title: true,
      authorId: true,
      publicity: true,
      createdAt: true,
      author: { select: { username: true } },
      content: { select: { content: true, format: true, syntaxVersion: true } },
    },
  });

  if (!clip) return { ok: false, reason: 'not_found' };

  const isPublic = clip.publicity ?? true;
  if (!isPublic && clip.authorId !== viewerId && !viewerIsOwner) {
    return { ok: false, reason: 'forbidden' };
  }

  return {
    ok: true,
    clip: {
      id: clip.id,
      title: clip.title,
      authorId: clip.authorId,
      authorName: clip.author?.username ?? null,
      publicity: isPublic,
      content: clip.content?.content ?? '',
      // 未知存量值给 null，不猜 markdown（见 ClipDetail.format 的说明）。
      format: parseContentFormat(clip.content?.format) ?? null,
      syntaxVersion: clip.content?.syntaxVersion ?? null,
      version: createHash('sha256').update(JSON.stringify([
        clip.content?.format ?? null, clip.content?.syntaxVersion ?? null,
        clip.title, clip.content?.content ?? '',
      ])).digest('hex'),
      createdAt: clip.createdAt ?? null,
    },
  };
}
