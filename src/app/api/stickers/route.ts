import { getCurrentUser, isCoreUser } from '@/lib/auth';
import { apiErr, apiOk } from '@/lib/format';
import { hasNoStickers, listStickerCollections } from '@/lib/sticker-service';

// 扫盘要 fs
export const runtime = 'nodejs';

// GET /api/stickers — 表情面板的数据源（合集 → 表情）。
//
// 【鉴权】需 core+ 登录：面板只挂在两个地方 —— 评论区与讨论的编辑器，两处都是 core+ 档。
//
// ⚠️ 别拿它跟**字节**路由（`/api/stickers/:collection/:name`）比：那条**有意匿名**，
// 理由是素材本身不属于任何账号、对所有人的答案都一样（台账见
// `tests/unit/anonymous-read-guard.test.ts`）。这条不一样 —— 它吐的是**全站合集的清单**，
// 是枚举面（游客能拿它当免费图床清单爬），所以收在档位里面。两者一收一放是刻意的。
export async function GET() {
  const user = await getCurrentUser();
  if (!user) return apiErr(401, '请先登录');
  if (!isCoreUser(user)) return apiErr(403, '需要核心用户权限');

  return apiOk({
    collections: listStickerCollections(),
    // 站长还没往 instance/stickers 里放素材 —— 前端据此显示一句说明，
    // 而不是给一个永远空白的面板
    empty: hasNoStickers(),
  });
}
