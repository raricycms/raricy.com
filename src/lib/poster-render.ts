// ─────────────────────────────────────────────────────────────────────────────
// poster-render.ts — 取数据 → 拼 SVG → sharp 光栅化成 PNG
//
// 与 poster.ts 的分工：那边是**纯**的 SVG 构造（可单测、不连库），这边负责把
// 库里的数据、头像字节与站点地址喂给它，再交给 sharp。
//
// 【为什么要 density=144】SVG 按 750×1240 的逻辑坐标写，density 翻倍光栅化 →
// 1500×2480 的真实像素。文字与二维码都是矢量，放大不会糊。
//
// 【中文字体】sharp 走 librsvg + fontconfig，**服务器上必须装中文字体**，
// 否则整张画报的文字会变豆腐块（二维码不受影响 —— 它是矢量矩形）。
// 见 docs/deploy.md 与 `npm run diagnose` 的探针。
// ─────────────────────────────────────────────────────────────────────────────

import sharp from 'sharp';
import { prisma } from '@/lib/db';
import { resolveAvatar } from '@/lib/avatar';
import { ymd } from '@/lib/format';
import { absoluteUrl } from '@/lib/site-url';
import {
  buildBlogOgSvg,
  buildCollectPosterSvg,
  buildFavoritePosterSvg,
  buildProfilePosterSvg,
} from '@/lib/poster';

/** 逻辑坐标 → 实际像素的倍率（2× 高清）。 */
const POSTER_DENSITY = 144;

/** 与 /u/[id] 页面上的角色徽章同一套文案。 */
const ROLE_LABEL: Record<string, string> = {
  user: '用户',
  core: '核心用户',
  admin: '管理员',
  owner: '站长',
};

/**
 * 头像转成可内嵌的 data URI。
 *
 * identicon 是 SVG：先光栅化成 PNG 再内嵌 —— librsvg 内嵌 SVG 的兼容性不值得赌，
 * 而且统一成 PNG 之后，SVG 与「站长手工放的 PNG 头像」走同一条路。
 */
async function avatarDataUri(userId: string): Promise<string> {
  const { buffer, contentType } = await resolveAvatar(userId);
  const png = contentType.startsWith('image/png')
    ? buffer
    : await sharp(buffer, { density: 288 }).resize(360, 360).png().toBuffer();
  return `data:image/png;base64,${png.toString('base64')}`;
}

/** SVG 字符串 → PNG 字节。 */
function rasterize(svg: string): Promise<Buffer> {
  return sharp(Buffer.from(svg, 'utf8'), { density: POSTER_DENSITY }).png().toBuffer();
}

/**
 * 个人主页画报。用户不存在 → null（路由据此 404）。
 * 统计口径与 /u/[id] 页面上的三格完全一致（同样是 ignore=false + 未删评论）。
 */
export async function renderProfilePoster(userId: string): Promise<Buffer | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, username: true, role: true, bio: true, createdAt: true },
  });
  if (!user) return null;

  const [blogs, comments, likesAgg] = await Promise.all([
    prisma.blog.count({ where: { authorId: userId, ignore: false } }),
    prisma.blogComment.count({
      where: { authorId: userId, isDeleted: false, blog: { ignore: false } },
    }),
    prisma.blog.aggregate({
      where: { authorId: userId, ignore: false },
      _sum: { likesCount: true },
    }),
  ]);

  const svg = buildProfilePosterSvg({
    username: user.username,
    roleLabel: ROLE_LABEL[user.role] ?? '',
    bio: user.bio ?? '',
    joinedYear: ymd(user.createdAt)?.slice(0, 4) ?? '',
    blogs,
    comments,
    likes: likesAgg._sum.likesCount ?? 0,
    qrText: absoluteUrl(`/u/${user.id}`),
    avatarDataUri: await avatarDataUri(user.id),
  });

  return rasterize(svg);
}

/**
 * 鱼干收款码。二维码指向 `/fish/collect?to=<用户名>` —— 静态码，金额由付款方输入。
 * 收款人就是调用者本人（路由已挡掉「给别人生成收款码」）。
 */
export async function renderCollectPoster(user: {
  id: string;
  username: string;
}): Promise<Buffer> {
  const svg = buildCollectPosterSvg({
    username: user.username,
    qrText: absoluteUrl(`/fish/collect?to=${encodeURIComponent(user.username)}`),
    avatarDataUri: await avatarDataUri(user.id),
  });
  return rasterize(svg);
}

/**
 * 收藏夹分享二维码。
 *
 * 二维码指向 `/favorite/<6 位 ID>` —— 该地址只解析**公开且未软删**的收藏夹
 * （服务层的 getPublicFavorite 过 PUBLIC_FAVORITE_WHERE）。所以这个函数拿到的
 * 一定是公开收藏夹：调用方（路由）必须先做过那道判定，这里不做第二道防线。
 *
 * 与收款码共用 THEMES.collect（奶油金浅底）—— 黄色五角星本来就是同色系。
 */
export async function renderFavoritePoster(data: {
  title: string;
  publicId: string;
  count: number;
}): Promise<Buffer> {
  const svg = buildFavoritePosterSvg({
    title: data.title,
    publicId: data.publicId,
    count: data.count,
    qrText: absoluteUrl(`/favorite/${data.publicId}`),
  });
  return rasterize(svg);
}

/**
 * 文章分享卡片（OG 图）。**注意与上面三张的分工差别**：
 *
 *   · 那三张的产物尺寸 = 750 × n 的逻辑坐标 × 2；这张是固定 1200×630 × 2 = **2400×1260**，
 *     比例 1.91:1（平台通用）。`generateMetadata` 里声明的 width/height
 *     **必须与这里的实际字节一致** —— 声明 1200 却给 2400 的字节是那种静默不一致。
 *   · 那三张的响应头是 `private, no-store` + `X-Robots-Tag: noindex`；这张恰恰相反
 *     （要 CDN 可缓存、要能被 social 爬虫取）。见 `api/og/blog/[id]/route.ts`。
 *
 * **可见性判定不在这里** —— 调用方（OG 路由）必须先过 `getExternallyVisibleBlog`，
 * 这里不做第二道防线（同 renderFavoritePoster 的纪律）。日期走 `ymd()`，与站内口径一致。
 */
export async function renderBlogOg(blog: {
  id: string;
  title: string;
  description: string;
  author: string;
  createdAt: Date | null;
  authorId: string;
}): Promise<Buffer> {
  const svg = buildBlogOgSvg({
    title: blog.title,
    description: blog.description,
    author: blog.author,
    // ymd() 收 null/undefined 并回 null；卡片那边把空串当「不画日期」
    date: ymd(blog.createdAt) ?? '',
    // 头像内嵌成 data URI：OG 图是**自包含**的一张贴图，抓取器不会再去请求我们的接口。
    // 取不到头像（无头像 → identicon）也永远拿得到一张图，所以这里不需要 try/catch。
    avatarDataUri: await avatarDataUri(blog.authorId),
  });
  return rasterize(svg);
}
