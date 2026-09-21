import { getPublicProfile, resolveProfileHandle } from '@/lib/user-service';
import { getCurrentUser, isCoreUser } from '@/lib/auth';
import { apiErr } from '@/lib/format';

// GET /api/users/<id 或用户名> — 公开资料（绝不含 email）。
//
// 【鉴权】**id 那条路刻意不设档**：`/u/:id` 是匿名可达的公开主页（主页画报的二维码
// 要把站外人引到这里），接口与页面必须同档，不能一个能进一个进不去。
// 但「能读」不等于「什么都能读」—— 内容按查看者收敛在 getPublicProfile 里判：role 徽章
// 与最近文章/评论只给本人或 core+，游客只拿 username / 头像 / 简介。所以这里必须把
// 登录态**显式解析出来传进去**，漏传即越权（见该函数注释）。
//
// 【为什么还认用户名】用户名片 `[@用户/张三]` 只带用户名（可读、能手打，且用户名在
// 本站不可改），渲染时按名字取一次资料 —— 见 src/lib/user-refs.ts。
//
// 【为什么按名字查要 core+】id 是 UUID，只能从页面链接里捡；**用户名到处都是、可以
// 拿来枚举**。本站对「可猜的句柄」一律收档（6 位收藏夹、8 位剪贴板同理），而名片本来
// 就只有 core+ 发得出来（评论与讨论都是 core+ 档），所以这条限制在功能上一点不亏。
//
// ⚠️ **查不到的一律 404，不按查看者分档** —— 这是对外的既有契约
//（`docs/bot/account-bot.md` §6：不存在 → 404 用户不存在），别为了「藏住存在性」改成
// 对不够档的人报 404、对够档的人报 403：那会让同一次请求的语义随查看者变，而存在性
// 本来也藏不住（注册接口会明说「用户名已存在」）。
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: handle } = await params;
  const viewer = await getCurrentUser();

  const found = await resolveProfileHandle(handle);
  if (!found) return apiErr(404, '用户不存在');
  if (found.viaName && !isCoreUser(viewer)) return apiErr(403, '需要核心用户权限');

  const profile = await getPublicProfile(
    found.id,
    viewer ? { id: viewer.id, isCore: isCoreUser(viewer) } : null
  );
  if (!profile) return apiErr(404, '用户不存在');
  return Response.json({ code: 200, message: 'ok', user: profile });
}
