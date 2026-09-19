import {
  getBlogDetail,
  validateBlogData,
  getCategoryPostingMeta,
  banActionMessage,
  updateBlog,
  setBlogVisibility,
  parseVisibility,
  BLOG_VISIBILITIES,
} from '@/lib/blog-service';
import type { BlogVisibility } from '@/lib/blog-service';
import { setBlogIgnore } from '@/lib/admin-blog-service';
import { categoryFullPath, apiOk, apiErr } from '@/lib/format';
import { prisma } from '@/lib/db';
import { getCurrentUser, isCoreUser, hasAdminRights, isCurrentlyBanned } from '@/lib/auth';
import { sendNotification } from '@/lib/notification-service';

// GET /api/blogs/:id — 文章详情（含 Markdown 正文）
//
// 【鉴权】需 core+ 登录，与 `/blog/:id` 页面同档（见 `docs/architecture.md` §8
// 「档位阶梯：页面与接口必须同档，每层都自己判」）。
// 这条此前完全免认证 —— 页面那道 `requireCoreUser()` 于是只挡住浏览器，挡不住任何拿到
// id 的调用方：匿名 curl 一下就是全文 Markdown。未登录 → 401；已登录但非 core → 403，
// 错误走 { code, message } 信封。**成功路径的形状一字不动**（加鉴权不该顺带改对外契约）。
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return apiErr(401, '请先登录');
  if (!isCoreUser(user)) return apiErr(403, '需要核心用户权限');

  const { id } = await ctx.params;
  // 上一行已经挡掉非 core，所以这里恒为「core+ 视角」；传真值而不是硬编码
  // `isCore: true`，是为了让页面层与接口层走同一条口径（`docs/architecture.md` §8）。
  const blog = await getBlogDetail(id, { id: user.id, isCore: isCoreUser(user) });
  if (!blog) return apiErr(404, '文章不存在');

  return Response.json({
    code: 200,
    message: 'ok',
    blog: {
      id: blog.id,
      title: blog.title,
      description: blog.description,
      author: blog.author?.username ?? null,
      author_id: blog.authorId,
      created_at: blog.createdAt?.toISOString() ?? null,
      likes_count: blog.likesCount ?? 0,
      comments_count: blog.commentsCount ?? 0,
      fish_count: blog.fishCount ?? 0,
      category: blog.category?.name ?? null,
      category_path: blog.category ? categoryFullPath(blog.category) : null,
      content: blog.content?.content ?? '',
      // 对外可见性。**必须下发**：PUT 是整体覆盖，调用方要能「读-改-写」（否则改一次
      // 标题就可能把档位写错），也要能判断这篇此刻对外可不可达。
      visibility: blog.visibility,
    },
  });
}

// PATCH /api/blogs/:id — **只改可见性**（详情页「管理文章」弹窗里的那一项）
//
// 【为什么单开一条窄接口，不复用 PUT】PUT 是整体覆盖：只为改一列就要把标题、摘要、
// 正文全回传，既有丢更新的竞态（另一个标签页刚改过标题就会被这次覆盖掉），又把正文
// 白往返一遍。窄接口只认一个键，从形状上就没有这些问题。
//
// 【权限与 PUT 逐条一致】登录 → core+ → 文章存在（未软删）→ **作者本人** →
// 禁言（管理员除外）。抄的不是形状而是判据：任何一条放宽都等于开一个新口子。
//
// ⚠️ 特别是**管理员改不了别人的文章** —— PUT 的 403 早就确立了这条边界
// （档位管「你有没有资格写文章」，归属管「这篇是不是你的」，见 blog-service 文件头
// 不变量【4】）。「让管理员能把别人的私密文章推成公开」是个独立的隐私决定，
// 不该顺手在这里实现。
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;

  const user = await getCurrentUser();
  if (!user) return apiErr(401, '请先登录');
  if (!isCoreUser(user)) return apiErr(403, '需要核心用户权限');

  const blog = await prisma.blog.findFirst({
    where: { id, ignore: false },
    select: { authorId: true },
  });
  if (!blog) return apiErr(404, '文章不存在');
  if (blog.authorId !== user.id) return apiErr(403, '无权编辑该文章');
  if (!hasAdminRights(user) && isCurrentlyBanned(user)) {
    return apiErr(403, banActionMessage(user));
  }

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return apiErr(400, '请求体格式不正确');
  }

  // 键集封闭，多传的键**报错而不是忽略** —— 忽略的话调用方会以为「我传了 title，
  // 它一定改了吧」。这与 `search_fields` 对未知字段的处理是同一种口径。
  const extra = Object.keys(body).filter((k) => k !== 'visibility');
  if (extra.length) {
    return apiErr(400, `本接口只接受 visibility，多传了：${extra.join(' / ')}`);
  }

  // 取值必须**恰好**是三档之一。刻意不用 parseVisibility()：那把 '' 与缺省都归一化成
  // 'private'（那是给表单 / 旧客户端设计的「没提这件事」语义）。而这条接口上「显式传了
  // 一个空串」几乎一定是调用方写错了，静默当成「改成私密」会让他在文章从公网消失之后
  // 才发现。
  const raw = body.visibility;
  if (typeof raw !== 'string' || !(BLOG_VISIBILITIES as readonly string[]).includes(raw)) {
    return apiErr(400, `可见性取值不合法，可选：${BLOG_VISIBILITIES.join(' / ')}`);
  }

  const result = await setBlogVisibility(id, raw as BlogVisibility);
  if (!result) return apiErr(404, '文章不存在'); // 取详情与更新之间被软删了

  return apiOk({ visibility: raw, changed: result.changed }, result.message);
}

// PUT /api/blogs/:id — 编辑文章
// 权限：core+ **且** 作者本人（非作者一律 403 '无权编辑该文章'；FeedButton 也仅对作者
// 显示编辑入口）。两层别混：档位管「你有没有资格写文章」，归属管「这篇是不是你的」。
// 顺序：登录 → core+ → 文章存在(未软删) → 作者本人 → 禁言(管理员除外) → 校验 → 栏目管理员专属 → 更新 → （管理员编辑他人时）通知。
export async function PUT(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;

  const user = await getCurrentUser();
  if (!user) return apiErr(401, '请先登录'); // 需登录
  // 编辑页是 `requireCoreUser()` + 作者（src/app/blog/[id]/edit/page.tsx:24,30），
  // 接口必须同档。少了这一层，被降权（core→user）的作者仍能 curl 改自己的文章。
  if (!isCoreUser(user)) return apiErr(403, '需要核心用户权限');

  // 文章存在且未软删（软删等同不存在 → 404）
  const blog = await prisma.blog.findFirst({
    where: { id, ignore: false },
    // visibility 是给下面「缺键时回填现值」取的。与 getBlogForEdit 一样归一化到白名单
    // （列是 TEXT、没有 CHECK 约束，取值白名单在 TS 侧）。
    select: { id: true, authorId: true, visibility: true },
  });
  if (!blog) return apiErr(404, '文章不存在');

  // 权限：仅作者本人
  if (blog.authorId !== user.id) return apiErr(403, '无权编辑该文章');

  // 禁言检查（管理员除外）
  if (!hasAdminRights(user) && isCurrentlyBanned(user)) {
    return apiErr(403, banActionMessage(user));
  }

  const body = await req.json().catch(() => null);

  // 缺 `visibility` 键时**用库里现值补齐**。
  //
  // 这条路径是**整体覆盖**（没传的字段会被一起写掉），而 validateBlogData 对「键不存在」
  // 给的是 'private' 这个**默认档**。直接放过去的话，一个只认识旧那 4 个键的调用方
  // ——恰恰是 parseVisibility 的注释点名要保护的那类「不带这个字段的 bot」—— 改一次标题
  // 就会把 link/public 的文章**静默改回私密**：对外消失、退出 sitemap，而已被抓走的
  // 副本收不回来。所以缺键 = 不改动这一列，而不是 = 打回默认档。
  //
  // 显式传 `"private"` 仍然照改 —— 那是明确的意图，与「压根没提这件事」不是一回事。
  const payload =
    body && typeof body === 'object' && !Array.isArray(body) && !('visibility' in body)
      ? {
          ...(body as Record<string, unknown>),
          visibility: parseVisibility(blog.visibility) ?? 'private',
        }
      : body;

  const v = await validateBlogData(payload);
  if (!v.ok) return apiErr(400, v.message);

  // 栏目“仅管理员可发”校验（含父栏目）
  if (v.data.categoryId != null) {
    const meta = await getCategoryPostingMeta(v.data.categoryId);
    if (meta.adminOnlyEffective && !hasAdminRights(user)) {
      return apiErr(403, '该栏目仅允许管理员发布文章');
    }
  }

  const { hasChanges, changesDetail } = await updateBlog(id, v.data);

  // 管理员编辑他人文章时通知作者（因本路由仅作者可入，此分支实际不会触发）。
  if (hasChanges && hasAdminRights(user) && blog.authorId !== user.id) {
    try {
      const changesText = changesDetail.length ? changesDetail.join('、') : '文章内容已更新';
      await sendNotification({
        recipientId: blog.authorId,
        action: '文章编辑',
        actorId: user.id,
        objectType: 'blog',
        objectId: id,
        detail: `你的文章《${v.data.title}》已被管理员编辑。修改内容：${changesText}`,
      });
    } catch {
      // 忽略通知失败
    }
  }

  return apiOk({ blog_id: id, redirect: `/blog/${id}` }, '更新成功');
}

// DELETE /api/blogs/:id — 作者本人删自己的文章
// 权限：core+ **且** 作者本人（同 PUT，两层别混）。
// 管理员删他人请走 /api/admin/blogs/:id（要求 reason + 写日志 + 通知作者）。
export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return apiErr(401, '请先登录');
  if (!isCoreUser(user)) return apiErr(403, '需要核心用户权限');

  const { id } = await ctx.params;
  const blog = await prisma.blog.findFirst({
    where: { id, ignore: false },
    select: { id: true, authorId: true },
  });
  if (!blog) return apiErr(404, '文章不存在');
  if (blog.authorId !== user.id) return apiErr(403, '无权删除该文章');

  const result = await setBlogIgnore(id, true);
  if (!result.ok) return apiErr(404, result.message);
  return apiOk({ blog: result.data }, '文章已删除');
}
