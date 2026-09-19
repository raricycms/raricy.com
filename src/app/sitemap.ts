import type { MetadataRoute } from 'next';
import { listStories } from '@/lib/story-service';
import { listIndexableBlogs } from '@/lib/blog-service';
import { siteBaseUrl } from '@/lib/site-url';
import { isoWithOffset } from '@/lib/db-time';

export const dynamic = 'force-dynamic'; // 依赖磁盘（故事条目）与库（博客），禁用静态化

// ⚠️ 只列**当前对游客真的打得开**的路径。这是给爬虫的邀请函，写进来的每一条都等于
// 「请来抓、请建索引」。
//
// 本文件曾列出 `/blog`、`/audit` 与**每一篇未软删的博客明细** —— 那三条都是 core+ 的
// 页面（`requireCoreUser()`），爬虫抓到的只是 307 到登录页。危害不在「抓到登录页」，
// 而在 `/blog/<uuid>` 这批 URL：它等于把全站文章的 id 编成一份公开清单发出去，
// 而同一时期 `GET /api/blogs/:id` 是**免认证**的（现已收紧为 core+）—— 那份清单
// 直接就是全文的取件码。
//
// 「每篇可选对外公开」落地后博客明细回来了，但**只列 public 档**（link 档拿到链接
// 就能读，可是不该被列举 —— 这正是两档的差别所在，见 src/lib/blog-visibility.ts）。
// 过滤在 `listIndexableBlogs()` 里，这里不再手写第二遍。
//
// ★「列进 sitemap 之前，先确认它对匿名请求返回 200」—— 这条现在**由测试保证**，
//   不再是一句提醒：tests/e2e/blog-visibility.spec.ts 断言 public 文章匿名 200、
//   private 匿名落登录页，同时断言本文件含 public、不含 link/private。
//
// 【体量】sitemap 单文件上限 5 万条，本站约 6200 篇，远未触及。真接近上限时要上
// Next 的 `generateSitemaps`（分片），别在这里做手工分页。
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const base = siteBaseUrl();

  // 静态路由：首页与故事区对游客开放（`/tool`、`/login` 等无索引价值，不入表）
  const staticRoutes: MetadataRoute.Sitemap = [
    { url: `${base}/`, changeFrequency: 'daily', priority: 1 },
    { url: `${base}/story`, changeFrequency: 'weekly', priority: 0.6 },
  ];

  // 故事条目（防御式读盘，缺失则为空）
  let storyRoutes: MetadataRoute.Sitemap = [];
  try {
    storyRoutes = listStories().items.map((it) => ({
      url: `${base}/story/${it.id}`,
      changeFrequency: 'monthly',
      priority: 0.5,
    }));
  } catch {
    storyRoutes = [];
  }

  // 对外公开的文章（只 public 档）。lastModified 取正文的 updatedAt ——
  // 「什么时候改的」对爬虫比「什么时候发的」有用；没有正文行时回落 createdAt。
  //
  // ⚠️ 必须过 isoWithOffset()，不能直接把 Date 交给 Next —— Next 内部用
  // toISOString() 序列化，而库里的数字是「UTC+8 墙上时间贴 Z」（见 db-time.ts 文件头），
  // 裸序列化会让爬虫以为每篇都晚了 8 小时才更新。
  const blogRoutes: MetadataRoute.Sitemap = (await listIndexableBlogs()).map((b) => ({
    url: `${base}/blog/${b.id}`,
    lastModified: isoWithOffset(b.updatedAt ?? b.createdAt) ?? undefined,
    changeFrequency: 'monthly',
    priority: 0.6,
  }));

  return [...staticRoutes, ...storyRoutes, ...blogRoutes];
}
