// GET /api/og/blog/:id — 文章分享卡片（PNG），给社交平台 unfurl 用。
//
// 【为什么是 route handler 而不是 opengraph-image.tsx 文件约定】那个约定**不在**
// tests/unit/anonymous-read-guard.test.ts 的扫描面内（它只扫 `route.ts`）—— 而
// 「匿名读口没人知道」正是本仓花了一整个守卫去防的东西。写成 route handler 之后，
// 它出现在台账里、必须用一个具名出口（getExternallyVisibleBlog）才过得了那条守卫。
//
// 【为什么放在 /api/og/ 而不是 /api/blogs/[id]/og/】后者会落进
// tests/route/blog-auth.test.ts 的 DOMAIN_DIRS 自检（那一域的 handler 数 14 → 15），
// 逼那份「一律 core+」的断言当场改形状。那一域的口径是整齐的 core+，混进一条方向
// 相反的会让那组三连断言失去意义 —— 它的档位契约单列在那个文件的末尾。
//
// 【没有会话档位，但有 per-object 可见性判定】任何人可请求；只对**对外可见**的
// 文章（link / public）返回 200，其余一律 404 —— 不存在 / 已软删 / private **三者
// 同形**，不确认存在性。判定走 getExternallyVisibleBlog，别在这里手写 where。
//
// 【响应头与三张画报**相反**，别顺手抄】
//   · 画报：`private, no-store` + `X-Robots-Tag: noindex`（用户自己保存的物料）
//   · 本路由：`public, max-age=600` + 按档位发的 X-Robots-Tag（要被 CDN 与爬虫取）
//
// 【404 为什么是 JSON 而不是一张占位图】抓取器拿到 404 就不出卡片 —— 这比一张
// 通用占位图诚实：占位图会把「这篇文章存在、但你看不到」这件事说出去。

import { apiErr } from '@/lib/format';
import { RULES, rateLimit } from '@/lib/rate-limit';
import { clientIp } from '@/lib/request-ip';
import { renderBlogOg } from '@/lib/poster-render';
import { getExternallyVisibleBlog, INDEXABLE_VISIBILITIES } from '@/lib/blog-service';

// sharp 不能在 edge 上跑
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  // 限频按 IP —— 这条是匿名的、且每次请求都要光栅化一张 2400×1260 的 PNG。
  // 取不到 IP 就跳过这一维（别传占位串，那会把所有无 IP 的请求塞进同一个桶）。
  const ip = clientIp(req);
  if (ip) {
    const gate = rateLimit(`og:blog:ip:${ip}`, RULES.ogImagePerIp);
    if (!gate.allowed) return apiErr(429, '请求太频繁了，请稍后再试');
  }

  const { id } = await ctx.params;

  // ★ 对外读一篇的唯一出口 ★ —— 不存在 / 已软删 / private 一律 null，三者同形。
  const blog = await getExternallyVisibleBlog(id);
  if (!blog) {
    return new Response(JSON.stringify({ code: 404, message: '文章不存在' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
    });
  }

  const png = await renderBlogOg({
    id: blog.id,
    title: blog.title,
    description: blog.description,
    author: blog.author?.username ?? '',
    createdAt: blog.createdAt,
    authorId: blog.authorId,
  });

  // 按档位发：public 可索引、link 只可读不可索引。这与页面的 robots 元数据、
  // sitemap 的收录范围是同一套口径的三处落点（见 docs/architecture.md §6.11）。
  const indexable = (INDEXABLE_VISIBILITIES as readonly string[]).includes(blog.visibility);

  return new Response(new Uint8Array(png), {
    headers: {
      'Content-Type': 'image/png',
      // public + 10 分钟：社交平台与 CDN 会缓存它。**不是**画报那三条的 private/no-store。
      // 10 分钟是折中 —— 改了标题或把文章改回 private 之后，平台侧最多陈旧 10 分钟。
      'Cache-Control': 'public, max-age=600',
      'X-Robots-Tag': indexable ? 'all' : 'noindex',
    },
  });
}
