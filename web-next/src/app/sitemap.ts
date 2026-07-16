import type { MetadataRoute } from 'next';
import { prisma } from '@/lib/db';
import { listStories } from '@/lib/story-service';

export const dynamic = 'force-dynamic'; // 依赖数据库/磁盘，禁用静态化

// 站点根地址：优先 env，否则回退正式域名。
function siteUrl(): string {
  return (process.env.NEXT_PUBLIC_SITE_URL || 'https://raricy.com').replace(/\/$/, '');
}

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const base = siteUrl();

  // 静态路由（对齐 Flask sitemap static_pages：首页 / 故事根 / 博客菜单）
  const staticRoutes: MetadataRoute.Sitemap = [
    { url: `${base}/`, changeFrequency: 'daily', priority: 1 },
    { url: `${base}/blog`, changeFrequency: 'daily', priority: 0.8 },
    { url: `${base}/story`, changeFrequency: 'weekly', priority: 0.6 },
    { url: `${base}/audit`, changeFrequency: 'daily', priority: 0.3 },
  ];

  // 博客明细：软删除排除（ignore=false）
  let blogRoutes: MetadataRoute.Sitemap = [];
  try {
    const blogs = await prisma.blog.findMany({
      where: { ignore: false },
      select: { id: true, createdAt: true, lastCommentAt: true },
      orderBy: { createdAt: 'desc' },
    });
    blogRoutes = blogs.map((b) => ({
      url: `${base}/blog/${b.id}`,
      lastModified: b.lastCommentAt ?? b.createdAt ?? undefined,
      changeFrequency: 'weekly',
      priority: 0.7,
    }));
  } catch {
    blogRoutes = []; // 数据库不可用时退化，不阻断 sitemap 生成
  }

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

  return [...staticRoutes, ...blogRoutes, ...storyRoutes];
}
