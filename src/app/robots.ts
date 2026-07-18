import type { MetadataRoute } from 'next';

// 站点根地址：优先 env，否则回退正式域名。
function siteUrl(): string {
  return (process.env.NEXT_PUBLIC_SITE_URL || 'https://raricy.com').replace(/\/$/, '');
}

export default function robots(): MetadataRoute.Robots {
  const base = siteUrl();
  return {
    rules: [
      {
        userAgent: '*',
        allow: '/',
        // 后台/接口/鉴权路径不放给爬虫（对齐 Flask 无公开后台的意图）
        disallow: ['/api/', '/auth/', '/admin/'],
      },
    ],
    sitemap: `${base}/sitemap.xml`,
    host: base,
  };
}
