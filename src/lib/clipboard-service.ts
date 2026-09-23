// ─────────────────────────────────────────────────────────────────────────────
// clipboard-service.ts — 云剪贴板业务逻辑
//
// 纯函数 + 显式参数，与 blog-service 风格一致。软删除：ClipBoard.ignore = true
// 一律排除。ClipBoard 存元信息（title/publicity），ClipText 存正文，一对一分表。
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from './db';
import { nowForDb } from './db-time';
import { generateShortId } from './short-id';
import { collectClipboardRefIds, MAX_BLOG_REF_ITEMS } from './content-refs';
import { maskMarkdownCode } from './favorite-refs';

// 校验上限
export const CLIP_TITLE_MAX = 40;
export const CLIP_CONTENT_MAX = 50000;
// 每用户剪贴板总数上限：count >= 200 时拒绝，即**最多 200 条**。
// ⚠️ 边界是有意的：写成 `count > 200 才拒绝` 会实际放行到 201 条，
//    与站内文案「一个用户只能发布200篇云剪贴板！」对不上。这里就是真正的 200。
export const CLIP_PER_USER_MAX = 200;

export interface CreateClipInput {
  title: string;
  content: string;
  publicity?: boolean;
}

/** 长度校验失败的原因，与 route 层的 'title too long' / 'content too long' 一一对应。 */
export type ClipLengthReason = 'title_too_long' | 'content_too_long';

export type CreateClipResult =
  | { ok: true; id: string }
  | { ok: false; reason: 'limit' | ClipLengthReason };

/**
 * 标题 / 正文长度校验。
 * 合法返回 null，否则返回失败原因。空标题与超长标题同属 title_too_long 一条分支
 * （len<1 与 len>40 走同一个 'title too long'，前端文案与此一一对应）。
 */
function validateClipLength(title: string, content: string): ClipLengthReason | null {
  if (content.length > CLIP_CONTENT_MAX) return 'content_too_long';
  if (title.length < 1 || title.length > CLIP_TITLE_MAX) return 'title_too_long';
  return null;
}

/**
 * 创建剪贴板。
 * 先校验长度（route 层也校验，但 service 自己必须设防：任何绕过 route 的调用方
 * 都不该能写超长数据）；再按 authorId 统计总数（含软删除 —— 这个上限管的是
 * 「这个人名下有多少行」，不是「有效几条」），超限返回 limit。
 * 最后生成 8 位短 ID，写 ClipBoard + ClipText。
 */
export async function createClip(
  authorId: string,
  input: CreateClipInput
): Promise<CreateClipResult> {
  const lengthErr = validateClipLength(input.title, input.content);
  if (lengthErr) return { ok: false, reason: lengthErr };

  const count = await prisma.clipBoard.count({ where: { authorId } });
  if (count >= CLIP_PER_USER_MAX) {
    return { ok: false, reason: 'limit' };
  }

  const id = generateShortId(8);
  const now = nowForDb();

  await prisma.clipBoard.create({
    data: {
      id,
      title: input.title,
      authorId,
      publicity: input.publicity ?? true,
      ignore: false,
      createdAt: now,
      content: {
        create: { content: input.content, updatedAt: now },
      },
    },
  });

  return { ok: true, id };
}

export interface UpdateClipInput {
  title: string;
  content: string;
  publicity: boolean;
}

export type UpdateClipResult =
  | { ok: true; id: string }
  | { ok: false; reason: 'not_found' | 'forbidden' | ClipLengthReason };

/**
 * 编辑剪贴板。
 * - 先校验长度（与 route 层同一套规则，service 自己也设防，见 createClip 的说明）。
 * - 再取剪贴板并排除软删除（ignore=true）→ not_found。
 * - 权限=作者本人；非作者 → forbidden（**无站长例外** —— 站长能删任何人的，
 *   但不能替别人改内容）。
 * - 更新 title/publicity，并 upsert 正文（无 ClipText 记录时新建）。
 * - 不改动 ignore，保留软删除语义。
 */
export async function updateClip(
  clipId: string,
  editorId: string,
  input: UpdateClipInput
): Promise<UpdateClipResult> {
  const lengthErr = validateClipLength(input.title, input.content);
  if (lengthErr) return { ok: false, reason: lengthErr };

  const clip = await prisma.clipBoard.findFirst({
    where: { id: clipId, ignore: false },
    select: { id: true, authorId: true },
  });

  if (!clip) return { ok: false, reason: 'not_found' };
  if (clip.authorId !== editorId) return { ok: false, reason: 'forbidden' };

  const now = nowForDb();
  await prisma.clipBoard.update({
    where: { id: clipId },
    data: {
      title: input.title,
      publicity: input.publicity,
      content: {
        upsert: {
          create: { content: input.content, updatedAt: now },
          update: { content: input.content, updatedAt: now },
        },
      },
    },
  });

  return { ok: true, id: clipId };
}

export type DeleteClipResult = { ok: true } | { ok: false; reason: 'not_found' | 'forbidden' };

/**
 * 软删除剪贴板。
 * - 取剪贴板并排除软删除（ignore=true）→ not_found。
 * - 权限=作者本人或站长（站长可删任何人的 —— 比编辑宽一档，见 updateClip）。
 * - 仅把 ignore 置 true，数据保留，站长可恢复。
 */
export async function deleteClip(
  clipId: string,
  actorId: string,
  actorIsOwner: boolean
): Promise<DeleteClipResult> {
  const clip = await prisma.clipBoard.findFirst({
    where: { id: clipId, ignore: false },
    select: { id: true, authorId: true },
  });

  if (!clip) return { ok: false, reason: 'not_found' };
  if (clip.authorId !== actorId && !actorIsOwner) return { ok: false, reason: 'forbidden' };

  await prisma.clipBoard.update({
    where: { id: clipId },
    data: { ignore: true },
  });

  return { ok: true };
}

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
  createdAt: Date | null;
}

/**
 * 按 id 取剪贴板正文（含可见性判定）。
 * ignore=true（软删除）→ not_found；私有（publicity=false）且非作者 → forbidden。
 */
/**
 * 取剪贴板详情。
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
      content: { select: { content: true } },
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
      createdAt: clip.createdAt ?? null,
    },
  };
}

/**
 * 解析正文里所有 `[@8位]` 剪贴板引用，返回**只有公开档**的 id → 正文映射。
 *
 * 【谁在用】文章详情页的**对外视图**（`blog/[id]/page.tsx` 的访客分支）：把结果当
 * `externalClips` 交给 `MarkdownRenderer`。
 *
 * 【为什么非得在服务端做】访客没有会话，而 `GET /api/clipboard/:id` 要 core+ ——
 * 客户端去拉只会吃 401。所以判档在服务端做完，只把能给的那几条随 RSC payload 下发
 * （同 docs/architecture.md §7.3「闸门必须在服务端」）。**别为此把那条接口放开**：
 * 放开的是「所有公开剪贴板对匿名可读」，而这里要的只是「这篇文章引用了的那几条」。
 *
 * 【为什么只给公开档】剪贴板的 `publicity=false` 是「只有作者本人（和站长）」——
 * 比 core+ 更窄的一档，绝不能因为「有人把它引用进了一篇公开文章」而放宽。
 * 私有 / 已软删 / 不存在三种情况**同形**：都不出现在结果里，调用方一律保留字面量，
 * 不区分（区分等于确认存在性）。
 *
 * 【条数上限与客户端同源】取正文里出现的前 `MAX_BLOG_REF_ITEMS` 条（按出现顺序，
 * 去重）。这个数必须与渲染器那边的替换上限是同一个 —— 见 content-refs.ts 的说明。
 * 没有它，一篇塞满引用的文章会让**每一次**访客请求打出成千上万条查询。
 *
 * 【盖码：代码块里的引用一个都不解析】与渲染器那条分流同口径
 * （`maskMarkdownCode`）——《内容引用语法指南》对读者的承诺是「代码里的引用一律
 * 不展开」，两边必须一致：不一致的形态是同一篇正文在成员视图与对外视图里显示
 * 不同的东西，**而且都不报错**。
 */
export async function resolvePublicClipRefs(markdown: string): Promise<Record<string, string>> {
  const ids = collectClipboardRefIds(maskMarkdownCode(markdown)).slice(0, MAX_BLOG_REF_ITEMS);
  if (ids.length === 0) return {};

  const out: Record<string, string> = {};
  await Promise.all(
    ids.map(async (id) => {
      // 不传 viewerId / viewerIsOwner：拿不到「本人」或「站长」这两个例外，
      // 于是结果只可能是公开档（下面那句是第二道确认，别删）。
      const result = await getClip(id);
      if (result.ok && result.clip.publicity) out[id] = result.clip.content;
    })
  );
  return out;
}

export interface ClipListItem {
  id: string;
  title: string;
  publicity: boolean;
  createdAt: Date | null;
}

/**
 * 列出某用户的剪贴板。
 * 排除软删除，按 createdAt 倒序。
 */
export async function listUserClips(userId: string): Promise<ClipListItem[]> {
  const rows = await prisma.clipBoard.findMany({
    where: { authorId: userId, ignore: false },
    orderBy: { createdAt: 'desc' },
    select: { id: true, title: true, publicity: true, createdAt: true },
  });
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    publicity: r.publicity ?? true,
    createdAt: r.createdAt ?? null,
  }));
}
