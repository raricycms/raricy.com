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
        // 后台/接口/鉴权路径不放给爬虫（对齐 Flask 无公开后台的意图）；
        // /chat 是登录后的内部工作台，同样不索引。
        // 图片放在 allow 列表里：图走 /api/images/<id>/raw，本会被 '/api/' 挡住，
        // 而公开图床的图本来就该能被抓（见 raw 路由的 X-Robots-Tag，私有图仍挡）。
        // 注：同一对象里不能写两个 allow —— 后者会覆盖前者。
        allow: ['/', '/api/images/'],
        disallow: ['/api/', '/auth/', '/admin/', '/chat'],
      },
    ],
    sitemap: `${base}/sitemap.xml`,
    host: base,
  };
}
