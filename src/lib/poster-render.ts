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
import { buildCollectPosterSvg, buildProfilePosterSvg } from '@/lib/poster';

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
