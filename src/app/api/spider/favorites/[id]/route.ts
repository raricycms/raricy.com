// GET /api/spider/favorites/:id — 按 6 位 ID 读一个**公开**收藏夹
//
// 【鉴权】需 core+ 登录。本站的机器人模型一直是「一个 core+ 账号 + 会话 cookie」
// （提权步骤见 docs/bot/chat-bot.md §2），本命名空间与之一致。
// 对外的唯一口径写在 `docs/bot/favorite-bot.md`。
//
// ⚠️ 三条硬约束，改动前先看清楚：
//   1. **只返回公开且未软删的**（服务层的 getPublicFavorite 过 PUBLIC_FAVORITE_WHERE）。
//      私密收藏夹没有 6 位句柄，所以这里连「猜」的余地都没有；软删的公开收藏夹必须
//      404，否则「永不物理删」等于删掉的合辑永远可读。
//   2. **私密与不存在同为 404**，不区分 —— 回 403 等于确认「这个 id 存在，只是你看不了」。
//      这条 404 与上面的 401/403 是**不同档位**：档位不足在进业务逻辑之前就挡掉了，
//      能走到这里说明身份已经合格，此时再区分「存在但你看不了」才是越权信息。
//   3. **必须有限频**（spiderFavoritePerIp）。鉴权**不替代**限频：这条一次带出整个
//      列表，比同命名空间那几条「按 id 查单篇」重得多 —— 别因为邻居都没有就删掉它。
//
// 响应形状照 spider 命名空间的既有口径：**成功路径是裸 JSON**（没有 { code, message }
// 信封）；错误走 apiErr 的信封。但**加了** Cache-Control: no-store —— spider 现有几条
// 没写这个头，是历史遗留，新接口不沿袭。

import { apiErr } from '@/lib/format';
import { getCurrentUser, isCoreUser } from '@/lib/auth';
import { getPublicFavorite } from '@/lib/favorite-service';
import { clientIp } from '@/lib/request-ip';
import { rateLimit, RULES } from '@/lib/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return apiErr(401, '请先登录');
  if (!isCoreUser(user)) return apiErr(403, '需要核心用户权限');

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
