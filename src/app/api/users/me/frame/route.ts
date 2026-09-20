import { getCurrentUser } from '@/lib/auth';
import { apiErr, apiOk } from '@/lib/format';
import { equipFrame, listMyFrames } from '@/lib/frame-service';

// GET  /api/users/me/frame — 我持有的头像框 + 当前装备（设置页的装备面板）
// PUT  /api/users/me/frame — 装备 / 换框 / 卸下（body: { frame_key: string | null }）
//
// 【为什么挂在 /api/users/me 下，而不是 /api/frames/equipped】
// `app/api/frames/[key]/` 是**动态段**（字节路由）。在同名前缀下再放一个静态段，
// 就引入了「谁赢」的隐式规则 —— 现在能跑，但下一个人改路由时未必知道。
// 挂在既有的 /api/users/me 命名空间下既无歧义，语义也更准（这是「我的」东西）。
//
// 【为什么不开在 /api/users/me 的 PATCH 里】
// 那个 handler 的 updateOwnProfile 是「按白名单逐字段打补丁」的敏感路径
//（bio / 通知偏好 / 隐私开关 / 专注模式）。加一个**要查另一张表才能判**的字段
// 会把那条简单逻辑复杂化，而档位与归属判定都该收在 frame-service 里。
// 读它也是一样：GET 走这里，不去撑大 /api/users/me 的 profile 对象。

/** 全部登录用户都可以看自己的框（没有任何档位门槛 —— 框是发下来的，不是买来的）。 */
export async function GET() {
  const user = await getCurrentUser();
  if (!user) return apiErr(401, '未登录');

  // ★ 下发的是**判定后的结果**：url / expired / equipped / active 全由服务端算好，
  //   客户端一次都不做时间比较（db-time-guard 扫整个 src/，含页面组件）。
  return apiOk(await listMyFrames(user.id));
}

export async function PUT(req: Request) {
  const user = await getCurrentUser();
  if (!user) return apiErr(401, '未登录');

  let body: { frame_key?: unknown };
  try {
    body = (await req.json()) as { frame_key?: unknown };
  } catch {
    return apiErr(400, '请求体格式错误');
  }

  // ★ 字段**必须显式出现**：`{}` 与 `{ frame_key: null }` 是两件事。
  //   用 `body.frame_key ?? null` 会把「忘了传」静默当成「卸下」——
  //   那是一个**丢失用户状态**的默认值，正好是本站最忌讳的那种默认。
  if (!('frame_key' in body)) return apiErr(400, '缺少 frame_key（卸下请显式传 null）');

  const raw = body.frame_key;
  if (raw !== null && typeof raw !== 'string') return apiErr(400, 'frame_key 必须是字符串或 null');

  // equipFrame 内部：key 为 null → 无条件卸下（不看当前 key 合不合法）；
  // 否则校验「白名单 + 未退役 + 有 alive 持有行 + 未过期」，失败一律不写库。
  const result = await equipFrame(user.id, raw);
  if (!result.ok) return apiErr(result.code, result.message);

  return apiOk({ frame_key: result.key, expires_at: result.expiresAt?.toISOString() ?? null });
}
