// ─────────────────────────────────────────────────────────────────────────────
// POST /api/chat/channels/:id/viewing — 报到「我正在看这个会话」
//
// 不落库、不进消息流：只在进程内记下「这个人在看这个会话」，供 @ 提及通知判断
// 「要不要打扰他」—— 正在看就不发（见 chat-presence.ts 与 chat-service.notifyChannelMentions）。
//
// 【为什么是独立端点，不从 /read 推断】/read 是「读到哪了」，机器人和客户端都在调，
// 而且只有新消息才发得出来 —— 人盯着一个安静的大区看时反而没有 /read。「在看」是
// 另一个事实，只能由客户端显式报（理由见 chat-presence.ts 文件头）。
//
// 【为什么一律 200】频道不存在 / 无权访问时也返回 ok：这不是用户能感知的动作，
// 报不上去只会让对方的通知照常发 —— 失败方向是安全的（多打扰一次，不静默丢）。
// 与 /read 的「没权限也是 200 + message_id 0」同一路数，别改成 404，那会平白多出
// 一个能探测频道是否存在/是否可见的接口。
//
// 【无配额】与 /typing、/read 同档：一次请求只写一个内存条目，没有库操作 ——
// 客户端每次切频道、回前台、以及 60s 续期各报一次（见 ChatApp.reportViewing）。
// ─────────────────────────────────────────────────────────────────────────────

import { canAccessChannel } from '@/lib/chat-service';
import { reportViewing } from '@/lib/chat-presence';
import { apiOk } from '@/lib/format';
import { requireChatUser } from '../../../_auth';

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await requireChatUser();
  if (user instanceof Response) return user;

  const { id } = await ctx.params;
  const access = await canAccessChannel(id, user.id, user.focusMode);
  if (access.allowed) reportViewing(user.id, id);

  return apiOk({});
}
