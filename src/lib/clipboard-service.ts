// ─────────────────────────────────────────────────────────────────────────────
// clipboard-service.ts — 云剪贴板业务逻辑
//
// 纯函数 + 显式参数，与 blog-service 风格一致。软删除：ClipBoard.ignore = true
// 一律排除。ClipBoard 存元信息（title/publicity），ClipText 存正文，一对一分表。
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from './db';
import { nowForDb } from './db-time';
import { generateShortId } from './short-id';
import {
  DEFAULT_CONTENT_FORMAT,
  parseContentFormat,
  resolveContentWriteFormat,
} from './content-format';
import type { ContentFormat } from './content-format';
import type { ExternalClipData } from './reactive/ref-types';
import { createHash } from 'node:crypto';
import {
  collectClipboardRefIds,
  createConcurrencyLimiter,
  MAX_REF_CONCURRENCY,
  MAX_REF_EXPAND_CHARS,
  MAX_REF_FETCHES,
} from './content-refs';
import { maskMarkdownCode } from './favorite-refs';

// 校验上限
export const CLIP_TITLE_MAX = 40;
export const CLIP_CONTENT_MAX = 50000;
// 每用户剪贴板总数上限：count >= 200 时拒绝，即**最多 200 条**。
// ⚠️ 边界是有意的：写成 `count > 200 才拒绝` 会实际放行到 201 条，
//    与站内文案「一个用户只能发布200篇云剪贴板！」对不上。这里就是真正的 200。
export const CLIP_PER_USER_MAX = 200;

/** 正文写入闸门的失败原因（与 blog-service 同形，但两域各自设防）。 */
export type ClipContentWriteFailure = 'invalid_format' | 'reactive_not_ready';

export type ClipContentWriteGate =
  | { ok: true; format: ContentFormat }
  | { ok: false; reason: ClipContentWriteFailure };

/**
 * 剪贴板正文的**唯一写入闸门**（createClip / updateClip / 两条写接口都调它）。
 *
 * 规则与博客侧逐条一致（见 blog-service.resolveBlogContentFormat）：
 *   · 省略 = 保留库里的原值（新建时默认 markdown）；
 *   · 未知请求值 → 拒绝；
 *   · 未知存量值 / 存量 reactive → 拒绝 —— 本期没有同版本快照可回滚，
 *     任何写入都会静默丢格式或把 reactive 源码按 Markdown 改写。
 */
export function resolveClipContentFormat(
  requested: unknown,
  stored: unknown = undefined
): ClipContentWriteGate {
  const current =
    stored === undefined ? DEFAULT_CONTENT_FORMAT : parseContentFormat(stored);
  if (current === null) return { ok: false, reason: 'invalid_format' };
  if (current === 'reactive') return { ok: false, reason: 'reactive_not_ready' };
  return resolveContentWriteFormat(requested, current);
}

/** 写入闸门失败时的对外文案（route 层直接用它，避免两处措辞漂移）。 */
export function clipContentWriteMessage(reason: ClipContentWriteFailure): string {
  return reason === 'invalid_format'
    ? '内容格式取值不合法，可选：markdown / reactive'
    : 'ReactiveMD 内容暂未开放写入';
}

export interface CreateClipInput {
  title: string;
  content: string;
  publicity?: boolean;
  /**
   * 正文格式。`unknown` 而不是 `ContentFormat`：service 自己必须校验任何绕过 route
   * 的调用方（同长度校验的理由）。缺省 = 新建默认 markdown。
   */
  format?: unknown;
}

/** 长度校验失败的原因，与 route 层的 'title too long' / 'content too long' 一一对应。 */
export type ClipLengthReason = 'title_too_long' | 'content_too_long';

export type CreateClipResult =
  | { ok: true; id: string }
  | { ok: false; reason: 'limit' | ClipLengthReason | ClipContentWriteFailure };

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

  // 写入闸门放在查库之前：非法 / reactive 请求连配额都不该消耗。
  const write = resolveClipContentFormat(input.format);
  if (!write.ok) return { ok: false, reason: write.reason };

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
        create: {
          content: input.content,
          format: write.format,
          syntaxVersion: null,
          updatedAt: now,
        },
      },
    },
  });

  return { ok: true, id };
}

export interface UpdateClipInput {
  title: string;
  content: string;
  publicity: boolean;
  /** 与 CreateClipInput.format 同：unknown 由 service 自己校验；省略 = 保留原格式。 */
  format?: unknown;
}

export type UpdateClipResult =
  | { ok: true; id: string }
  | { ok: false; reason: 'not_found' | 'forbidden' | ClipLengthReason | ClipContentWriteFailure };

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
    // content.format 是写入闸门的当前值：省略 format 的编辑必须保留原值，
    // 而存量 reactive 当前一律拒绝写入（理由见 resolveClipContentFormat）。
    select: { id: true, authorId: true, content: { select: { format: true } } },
  });

  if (!clip) return { ok: false, reason: 'not_found' };
  if (clip.authorId !== editorId) return { ok: false, reason: 'forbidden' };

  const write = resolveClipContentFormat(input.format, clip.content?.format);
  if (!write.ok) return { ok: false, reason: write.reason };

  const now = nowForDb();
  await prisma.clipBoard.update({
    where: { id: clipId },
    data: {
      title: input.title,
      publicity: input.publicity,
      content: {
        upsert: {
          create: {
            content: input.content,
            format: write.format,
            syntaxVersion: null,
            updatedAt: now,
          },
          update: {
            content: input.content,
            format: write.format,
            syntaxVersion: null,
            updatedAt: now,
          },
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
  /**
   * 正文格式。**null = 库里的值不认识**（或正文行缺失）—— 绝不猜成 markdown：
   * 猜错等于把另一种语言的源码交给 Markdown 解析器。读取方必须保留字面量 / 走链接。
   */
  format: ContentFormat | null;
  /** 仅 format='reactive' 时有意义；只用于升级审计，不是渲染开关。 */
  syntaxVersion: string | null;
  /** Shared by API, member embeds and public embeds. */
  version: string;
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

/**
 * 解析正文里所有 `[@8位]` 剪贴板引用，返回**只有公开档**的 id → 结构化数据
 * （`{ content, format, version?, title? }`）。
 *
 * ⚠️ 返回的 `content` 是**源码**，`format` 才是调用方该看的判据：
 *   · markdown → 旧渲染器可以内联；
 *   · reactive → **不得内联**（旧渲染器读不懂），消费端（ContentRefResolver /
 *     useResolvedContent）只生成一个安全的 Markdown 链接；
 *   · format 认不出（库里是脏值）→ 这条**不进表**，调用方保留字面量。
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
 * 【条数上限与客户端同源，且是**取数**那一档】取正文里出现的前 `MAX_REF_FETCHES`
 * 条（按出现顺序，去重）。这里要的是「服务端为这一篇最多查几次库、最多下发多少条」，
 * 对应客户端那个**取数候选**上限，而不是它的**显示**上限（`MAX_BLOG_REF_ITEMS`）——
 * 两个数当前都是 50，但语义不同：显示上限管「替换几处」，取数上限管「取几次」。
 * 见 content-refs.ts 里 `MAX_REF_FETCHES` 的说明。没有它，一篇塞满引用的文章会让
 * **每一次**访客请求打出成千上万条查询。
 *
 * 【并发与总量也有上限】查库走 `MAX_REF_CONCURRENCY` 的闸门（同一时刻最多 4 条），
 * 入映射的正文合计封顶 `MAX_REF_EXPAND_CHARS`（500000）—— 防的是**匿名 RSC payload
 * 被放大**：50 条各 5 万字的公开剪贴板加起来是 250 万字符，随每一次访客请求下发。
 * 入映射**按源文出现顺序**（`ids` 就是按出现顺序去重来的）：累计超预算的那条跳过、
 * 不占后续名额（后面的小剪贴板照样能进来）—— 与客户端那条「装不下就保留 token」同义。
 * 重复的 id 只计一次（`ids` 已去重）。
 *
 * 【盖码：代码块里的引用一个都不解析】与渲染器那条分流同口径
 * （`maskMarkdownCode`）——《内容引用语法指南》对读者的承诺是「代码里的引用一律
 * 不展开」，两边必须一致：不一致的形态是同一篇正文在成员视图与对外视图里显示
 * 不同的东西，**而且都不报错**。
 */
export async function resolvePublicClipRefs(
  markdown: string
): Promise<Record<string, ExternalClipData>> {
  const ids = collectClipboardRefIds(maskMarkdownCode(markdown)).slice(0, MAX_REF_FETCHES);
  if (ids.length === 0) return {};

  // 按**下标**收集结果 —— 并发完成顺序不定，映射要按源文顺序重建。
  const contents: Array<ExternalClipData | undefined> = new Array(ids.length);
  const gate = createConcurrencyLimiter(MAX_REF_CONCURRENCY);
  await Promise.all(
    ids.map((id, i) =>
      gate(async () => {
        // 不传 viewerId / viewerIsOwner：拿不到「本人」或「站长」这两个例外，
        // 于是结果只可能是公开档（下面那句是第二道确认，别删）。
        const result = await getClip(id);
        if (!result.ok || !result.clip.publicity) return;
        const clip = result.clip;
        // 未知 / 缺失格式（null）一律**不进表**：调用方会保留字面量。
        // 绝不把它当 Markdown 下发 —— 那等于替库里一个认不出的值做决定。
        if (clip.format === null) return;
        // 版本 = 这份公开快照的稳定标识（格式 + 标题 + 正文）。相同内容同版本，
        // 引用方编辑后版本变化 —— 缓存与快照失效都靠它，不需要另存一张版本表。
        const version = clip.version;
        contents[i] = {
          content: clip.content,
          format: clip.format,
          version,
          title: clip.title,
        };
      })
    )
  );

  const out: Record<string, ExternalClipData> = {};
  let total = 0;
  for (let i = 0; i < ids.length; i += 1) {
    const data = contents[i];
    if (data === undefined) continue;
    if (total + data.content.length > MAX_REF_EXPAND_CHARS) continue;
    out[ids[i]] = data;
    total += data.content.length;
  }
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
