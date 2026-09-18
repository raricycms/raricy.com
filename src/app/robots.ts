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
        // 后台/接口/鉴权路径不放给爬虫（本站没有公开的后台页面）；
        // /chat 与 /blog 都是登录后的内部工作台，同样不索引。
        // ⚠️ disallow 与 sitemap 是一件事的两半，必须同进同退：sitemap 说「请来抓」、
        // robots 说「别抓」，只做一半就是自相矛盾。**这里的每一条都是「不索引」**，
        // 将来真有对外公开的页面（如对外博客），别顺手往这个列表里加。
        // 图片放在 allow 列表里：图走 /api/images/<id>/raw，本会被 '/api/' 挡住，
        // 而公开图床的图本来就该能被抓（见 raw 路由的 X-Robots-Tag，私有图仍挡）。
        // 注：同一对象里不能写两个 allow —— 后者会覆盖前者。
        allow: ['/', '/api/images/'],
        disallow: ['/api/', '/auth/', '/admin/', '/chat', '/blog'],
      },
    ],
    sitemap: `${base}/sitemap.xml`,
    host: base,
  };
}
