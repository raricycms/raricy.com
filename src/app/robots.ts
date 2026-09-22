import type { MetadataRoute } from 'next';
import { siteBaseUrl } from '@/lib/site-url';

// ⚠️ disallow 与 sitemap 是一件事的两半，必须同进同退：sitemap 说「请来抓」、
// robots 说「别抓」，只做一半就是自相矛盾。
//
// ── 本文件里的每一条「放行」，配的都是**按行/按页**的第二道闸 ─────────────────
//
// 路径级的 robots.txt 只能表达「这一段能不能抓」，粒度到单页/单条由页面元数据与响应头
// 收口。本站**五处**对外开口都是这个形状，改之前先把对应的第二道闸找出来：
//
//   · `/api/images/`  → 逐张发 `X-Robots-Tag`（公开图 all、私有图 noindex），见
//                        api/images/[id]/raw/route.ts
//   · `/api/audio/`   → 同上，见 api/audio/[id]/raw/route.ts
//   · `/api/og/`      → 逐张发 `X-Robots-Tag`（public 档 all、link 档 noindex），
//                        见 api/og/blog/[id]/route.ts
//   · `/blog/`        → 逐页发 robots 元数据（public 档 index、link/private 档 noindex），
//                        见 blog/[id]/page.tsx 的 generateMetadata
//   · `/explore`      → 逐页发 robots 元数据（**结果集为空时**、以及带 `?search=` 时
//                        noindex，其余 index），见 explore/page.tsx 的 generateMetadata。
//                        ⚠️ 它**不需要**往下面的 allow 数组里加一项（本来就未被 disallow，
//                        被 `allow: '/'` 覆盖）—— 这里记的是那道「按页」的闸，不是路径规则。
//
// ── 2026-09 新增 `/blog/`，理由与代价 ────────────────────────────────────────
//
// 「文章可选对外公开」落地后，对外文章（link / public）的 URL 就是 `/blog/<id>` ——
// 用户转发时复制的是地址栏那条，所以它必须可抓。整段放开又不行（`/blog` 目录页
// 仍是 core+）。写法是用**最长匹配**表达「恰好这一条挡住、它下面放行」：
// RFC 9309 规定最长模式优先，`/blog`（5 字符）只命中 disallow，`/blog/<uuid>`
// 命中更长的 `allow: /blog/`（6 字符）→ 放行。
//
// 【代价，已接受】`/blog/upload` 与 `/blog/<id>/edit` 也变得可抓。它们对匿名一律
// 307/403，且**站外没有任何东西链接它们** —— 爬虫无从发现。真正的风险是「把一批
// core+ 页面的 URL 编成清单发出去」，那件事只有 sitemap 会做，而 sitemap 已按
// 可见性收紧（只列 public）。
//
// 【`disallow: /login` 是这次改动的直接后果，别删】`/blog/` 放行之后，private 文章的
// URL 会被抓到并跟随 307 跳到 `/login?next=%2Fblog%2F<uuid>` —— 那个 next 参数里
// **带着文章 UUID**。挡住 /login 就断了这条链（重定向目标被 disallow 时爬虫不会去取，
// 那个带 UUID 的 URL 就进不了索引）。这与「不把全站文章 id 编成一份公开清单喂给
// 搜索引擎」是同一件事的两半。
export default function robots(): MetadataRoute.Robots {
  const base = siteBaseUrl();
  return {
    rules: [
      {
        userAgent: '*',
        // 注：同一对象里不能写两个 allow —— 后者会覆盖前者，所以五个元素合进一个数组。
        // /api/audio/ 与 /api/images/ 同性质：是给站外读者消费的直链（音频贴在公开
        // 博客里时要能被抓取）。**开了这条路就要在 raw 路由里逐条发 X-Robots-Tag**
        // ——这里是按路径放行，粒度不到单个文件，私有档得自己挡。
        allow: ['/', '/api/images/', '/api/audio/', '/api/og/', '/blog/'],
        // /auth/ 是鉴权回跳路径，/admin 与 /chat 是登录后的内部工作台，一律不索引。
        disallow: ['/api/', '/auth/', '/admin/', '/chat', '/login', '/blog'],
      },
    ],
    sitemap: `${base}/sitemap.xml`,
    host: base,
  };
}
