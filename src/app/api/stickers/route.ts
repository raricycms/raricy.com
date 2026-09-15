import { getCurrentUser } from '@/lib/auth';
import { apiErr, apiOk } from '@/lib/format';
import { hasNoStickers, listStickerCollections } from '@/lib/sticker-service';

// 扫盘要 fs
export const runtime = 'nodejs';

// GET /api/stickers — 表情面板的数据源（合集 → 表情）。
//
// 【为什么要登录】评论要登录、讨论要 core+，能打开面板的人必然是登录用户。
// 素材本身不是秘密（raw 路由对所有人开放，否则未登录读者看不到公开评论里的表情），
// 这里挡的是「游客拿这个接口当免费图床清单爬」。
export async function GET() {
  const user = await getCurrentUser();
  if (!user) return apiErr(401, '请先登录');

  return apiOk({
    collections: listStickerCollections(),
    // 站长还没往 instance/stickers 里放素材 —— 前端据此显示一句说明，
    // 而不是给一个永远空白的面板
    empty: hasNoStickers(),
  });
}
