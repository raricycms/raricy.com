import {
  listBlogs,
  parseSortParam,
  validateBlogData,
  countBlogsToday,
  getCategoryPostingMeta,
  banActionMessage,
  createBlog,
  BLOG_DAILY_LIMIT,
  ALL_SEARCH_FIELDS,
  type SearchField,
} from '@/lib/blog-service';
import { categoryFullPath, ymd, apiOk, apiErr } from '@/lib/format';
import { getCurrentUser, isCoreUser, hasAdminRights, isCurrentlyBanned } from '@/lib/auth';
import { rateLimit, RULES } from '@/lib/rate-limit';
import { sendNotification } from '@/lib/notification-service';
import { prisma } from '@/lib/db';

// GET /api/blogs?page=&per_page=&category=&featured=&search=&search_fields=&sort=
// per_page：可选（缺省走服务默认 200，行为不变）；传了则 clamp 1..50
// （讨论「引用博客」弹窗用 20 条一页）。
// search_fields：逗号分隔的搜索字段，可选值见 ALL_SEARCH_FIELDS。
//   **缺省 = 标题 / 简介 / 作者名**（与改动前逐字一致；引用弹窗走的就是这条）。
//   含 content（正文）时另计入 RULES.blogSearchMinute（见下）。
//
// 【鉴权】需 core+ 登录，与 `/blog` 页面同档（见 `docs/architecture.md` §8
// 「档位阶梯：页面与接口必须同档，每层都自己判」）。
// 这条此前完全免认证：匿名拉一次就能拿到全站文章的标题、简介、作者名、栏目与计数 ——
// 与 `/api/blogs/:id` 合起来等于把整个博客区敞开。未登录 → 401；非 core → 403。
export async function GET(req: Request) {
  const user = await getCurrentUser();
  if (!user) return apiErr(401, '请先登录');
  if (!isCoreUser(user)) return apiErr(403, '需要核心用户权限');

  const url = new URL(req.url);
  const perPageRaw = url.searchParams.get('per_page');
  const parsedPerPage = Number.parseInt(perPageRaw ?? '', 10);
  // 精选筛选三态，同 /blog 页：'1' → 只看精选，'0' → 只看非精选，缺省 → 不筛。
  // 不能把「没传」算成 false —— 那是生效的筛选，会让精选文章从调用方的列表里
  // 整体消失（QuoteBlogModal 就不传 featured，引用弹窗曾因此搜不到精选文）。
  const featuredRaw = url.searchParams.get('featured');

  // 搜索字段做白名单校验。**未知字段名直接 400，不静默丢弃** —— 调用方把 titel
  // 拼错却拿到一份「看着正常、其实搜的是别的字段」的结果，是最难查的那类问题。
  const fieldsRaw = url.searchParams.get('search_fields');
  const fields: SearchField[] = [];
  for (const raw of (fieldsRaw ?? '').split(',')) {
    const name = raw.trim();
    if (!name) continue;
    if (!(ALL_SEARCH_FIELDS as readonly string[]).includes(name)) {
      return apiErr(
        400,
        `未知的搜索字段 "${name}"，可选：${ALL_SEARCH_FIELDS.join(' / ')}`
      );
    }
    const field = name as SearchField;
    if (!fields.includes(field)) fields.push(field);
  }

  // 正文是重活：一次请求 = count + findMany 两次全表 LIKE 扫描（正文约 48.6MB）。
  // 所以与 /blog 页面**共用** blog:search:{userId} 这条配额 —— 同一笔开销就该共用
  // 同一个预算，否则两条路各 30 次/分等于额度翻倍。
  // 档位不在这里判：本路由整体已在上方收成 core+，此处只管**多久能来一次**。
  if (fields.includes('content')) {
    const gate = rateLimit(`blog:search:${user.id}`, RULES.blogSearchMinute);
    if (!gate.allowed) return apiErr(429, '搜索太频繁了，请稍后再试');
  }

  const result = await listBlogs({
    page: parseInt(url.searchParams.get('page') || '1', 10),
    perPage:
      perPageRaw != null && Number.isFinite(parsedPerPage)
        ? Math.min(50, Math.max(1, parsedPerPage))
        : undefined,
    categorySlug: url.searchParams.get('category'),
    featured: featuredRaw === '1' ? true : featuredRaw === '0' ? false : undefined,
    search: url.searchParams.get('search'),
    sort: parseSortParam(url.searchParams.get('sort')),
    // 没传 search_fields 时给 undefined，让 service 用 DEFAULT_SEARCH_FIELDS。
    searchFields: fields.length ? fields : undefined,
  });

  return Response.json({
    code: 200,
    message: 'ok',
    blogs: result.blogs.map((b: {
      id: string;
      title: string;
      description: string | null;
      authorId: string;
      author?: { username: string | null } | null;
      createdAt: Date | null;
      likesCount?: number | null;
      commentsCount?: number | null;
      fishCount?: number | null;
      isFeatured?: boolean | null;
      category?: { name: string } | null;
      content?: { updatedAt: Date | null } | null;
      snippet?: string | null;
    }) => ({
      id: b.id,
      title: b.title,
      description: b.description,
      author_id: b.authorId,
      author: b.author?.username ?? null,
      date: b.createdAt ? ymd(b.createdAt) : null,
      updated_at: b.content?.updatedAt ? ymd(b.content.updatedAt) : null,
      // 正文命中处的片段；没搜正文、或只在标题/简介/作者命中时是 null。
      // 有它调用方才答得出「这篇为什么被搜出来」—— 片段本身是纯文本，
      // 正文含字面 HTML，渲染侧必须走文本节点，别当 HTML 拼。
      snippet: b.snippet ?? null,
      likes_count: b.likesCount ?? 0,
      comments_count: b.commentsCount ?? 0,
      fish_count: b.fishCount ?? 0,
      is_featured: b.isFeatured ?? false,
      category: b.category?.name ?? null,
      category_path: b.category
        ? categoryFullPath({ name: b.category.name, parentId: null, parent: null })
        : null,
    })),
    pagination: {
      page: result.page,
      pages: result.pages,
      total: result.total,
      has_prev: result.hasPrev,
      has_next: result.hasNext,
    },
  });
}

// POST /api/blogs — 发布新文章
// 处理顺序固定：登录 → 禁言 → 核心用户 → 校验 → 日限额 → 栏目管理员专属 → 建文 → 通知。
export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return apiErr(401, '请先登录'); // 需登录（API 返回 JSON 401）

  // 禁言检查（对所有用户生效，含管理员）
  if (isCurrentlyBanned(user)) return apiErr(403, banActionMessage(user));

  // 仅核心用户可发布
  if (!isCoreUser(user)) return apiErr(403, '只有核心用户才能发布文章');

  const body = await req.json().catch(() => null);
  const v = await validateBlogData(body);
  if (!v.ok) return apiErr(400, v.message);

  // 每日发文上限（20 篇）
  const todayCount = await countBlogsToday(user.id);
  if (todayCount >= BLOG_DAILY_LIMIT) {
    return apiErr(429, '今日发布数量已达上限（20篇）');
  }

  // 栏目“仅管理员可发”校验（含父栏目）
  let notifyEffective = false;
  let fullPath = '';
  if (v.data.categoryId != null) {
    const meta = await getCategoryPostingMeta(v.data.categoryId);
    if (meta.adminOnlyEffective && !hasAdminRights(user)) {
      return apiErr(403, '该栏目仅允许管理员发布文章');
    }
    notifyEffective = meta.notifyEffective;
    fullPath = meta.fullPath;
  }

  const blogId = await createBlog(user.id, v.data);

  // 栏目发文提醒：通知所有管理员/站长（跳过自己），失败忽略
  if (v.data.categoryId != null && notifyEffective) {
    const admins = await prisma.user.findMany({
      where: { role: { in: ['admin', 'owner'] } },
      select: { id: true },
    });
    for (const admin of admins) {
      if (admin.id === user.id) continue;
      try {
        await sendNotification({
          recipientId: admin.id,
          action: '栏目发文提醒',
          actorId: user.id,
          objectType: 'blog',
          objectId: blogId,
          detail: `用户 ${user.username} 在栏目 "${fullPath}" 发布了新文章：${v.data.title}`,
        });
      } catch {
        // 忽略单条通知失败
      }
    }
  }

  return apiOk({ blog_id: blogId, redirect: `/blog/${blogId}` }, '上传成功');
}
