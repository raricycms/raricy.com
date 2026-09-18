import type { MetadataRoute } from 'next';
import { listStories } from '@/lib/story-service';

export const dynamic = 'force-dynamic'; // 依赖磁盘（故事条目），禁用静态化

// 站点根地址：优先 env，否则回退正式域名。
function siteUrl(): string {
  return (process.env.NEXT_PUBLIC_SITE_URL || 'https://raricy.com').replace(/\/$/, '');
}

// ⚠️ 只列**当前对游客真的打得开**的路径。这是给爬虫的邀请函，写进来的每一条都等于
// 「请来抓、请建索引」。
//
// 本文件曾列出 `/blog`、`/audit` 与**每一篇未软删的博客明细** —— 那三条都是 core+ 的
// 页面（`requireCoreUser()`），爬虫抓到的只是 307 到登录页。危害不在「抓到登录页」，
// 而在 `/blog/<uuid>` 这批 URL：它等于把全站文章的 id 编成一份公开清单发出去，
// 而同一时期 `GET /api/blogs/:id` 是**免认证**的（现已收紧为 core+）—— 那份清单
// 直接就是全文的取件码。**列进 sitemap 之前，先确认它对匿名请求返回 200。**
//
// 博客明细要等「每篇可选对外公开」这件事落地、能**只列对外可见的那些**之后再回来；
// 在那之前，站内博客一律不进 sitemap。加回来时记得同步 robots.ts 的 disallow。
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const base = siteUrl();

  // 静态路由：只有首页与故事区对游客开放（`/tool`、`/login` 等无索引价值，不入表）
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

  return [...staticRoutes, ...storyRoutes];
}
