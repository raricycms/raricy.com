import { listCategoryOptions } from '@/lib/blog-service';
import { apiOk, apiErr } from '@/lib/format';
import { getCurrentUser, isCoreUser } from '@/lib/auth';

// GET /api/categories — 栏目清单（发布文章要填的 category_id 从这里取）
//
// 【为什么要有这一条】`POST /api/blogs` 一直收 `category_id`，但此前全站只有
// `/api/admin/categories` 能列栏目 —— 机器人**没有任何途径**知道有哪些栏目、
// ID 各是多少，于是反馈回来的是「发文接口不支持选栏目」。
// 本站的机器人模型是「一个 core+ 账号走和对人一样的接口」（见 `docs/bot/comment-bot.md` §0），
// 所以这里补的就是那条缺掉的读口，对外契约见 `docs/bot/blog-bot.md`。
//
// 【档位】core+，与 `/blog/upload` 页（`requireCoreUser`）**同档** —— 见
// `docs/architecture.md` §8。栏目清单本身不含任何用户数据，但本站读口一律 core+，
// 不为它单独开口子（这是刻意的，不是漏判）。
export async function GET() {
  const user = await getCurrentUser();
  if (!user) return apiErr(401, '请先登录');
  if (!isCoreUser(user)) return apiErr(403, '需要核心用户权限');

  return apiOk({ categories: await listCategoryOptions() });
}
