// GET /api/spider/favorites/:id — 按 6 位 ID 读一个**公开**收藏夹（无认证）
//
// 这是全站唯一免认证的收藏夹读路径，也是站外机器人 / 爬虫唯一的入口
// （「机器人 = 一个 core+ 账号 + raricyCookie」那套对本接口不适用 —— 读公开合辑
//  不该先要求有账号）。对外的唯一口径写在 `docs/bot/favorite-bot.md`。
//
// ⚠️ 三条硬约束，改动前先看清楚：
//   1. **只返回公开且未软删的**（服务层的 getPublicFavorite 过 PUBLIC_FAVORITE_WHERE）。
//      私密收藏夹没有 6 位句柄，所以这里连「猜」的余地都没有；软删的公开收藏夹必须
//      404，否则「永不物理删」等于删掉的合辑永远可读。
//   2. **私密与不存在同为 404**，不区分 —— 回 403 等于确认「这个 id 存在，只是你看不了」。
//   3. **必须有限频**（spiderFavoritePerIp）。spider 命名空间现有三条路由都没有限频
//      （它们只按 id 查单篇内容，滥用成本低），这条会一次带出整个列表，是新加的唯一
//      一个有闸的 —— 别因为「邻居都没有」而删掉它。
//
// 响应形状照 spider 命名空间的既有口径：**裸 JSON**（没有 { code, message } 信封）。
// 但**加了** Cache-Control: no-store —— spider 现有几条没写这个头，是历史遗留，
// 新接口不沿袭。

import { apiErr } from '@/lib/format';
import { getPublicFavorite } from '@/lib/favorite-service';
import { clientIp } from '@/lib/request-ip';
import { rateLimit, RULES } from '@/lib/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  // 取不到 IP 时跳过该维度（不传占位串 —— 否则所有无 IP 的请求会共用一个桶）
  const ip = clientIp(req);
  if (ip) {
    const gate = rateLimit(`spider:fav:ip:${ip}`, RULES.spiderFavoritePerIp);
    if (!gate.allowed) return apiErr(429, '请求过于频繁，请稍后再试');
  }

  const { id } = await ctx.params;
  const res = await getPublicFavorite(id);
  // 私密 / 不存在 / 已软删 —— 同一个 404，同一个文案
  if (!res.ok) return apiErr(404, '收藏夹不存在');

  return Response.json(
    {
      id: res.favorite.publicId,
      title: res.favorite.title,
      author: res.favorite.authorName,
      count: res.favorite.items.length,
      blogs: res.favorite.items.map((i) => ({ id: i.blogId, title: i.title })),
    },
    { headers: { 'Cache-Control': 'no-store' } }
  );
}
