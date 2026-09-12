// 五子棋联机接口的公共管道：鉴权与错误码 → HTTP 映射。
// （Next App Router 把 `_` 开头的文件当非路由，不会被当成 API 端点。）

import { getCurrentUser, isCoreUser, type SafeUser } from '@/lib/auth';
import { apiErr } from '@/lib/format';
import { FOCUS_MODE_BLOCKED_TITLE } from '@/lib/focus-mode';
import type { RoomError } from '@/lib/gomoku-room';

export type GameUserResult = SafeUser | Response;

/**
 * 联机接口的统一闸门：登录 → core+ → 非专注模式。
 *
 * 【为什么比单机严】单机 /game/* 匿名可玩、专注模式也能直达。联机是**社交行为**
 * （对面坐着真人），与聊天大区同等对待：这里是服务端硬闸门，不只是 UI 隐藏。
 * 对齐 api/chat/_auth.ts。
 *
 * 【为什么要求 core+】站内既有门槛：发评论、聊天、投票、剪贴板都是 core+。
 * 「把房号发给朋友」的前提是朋友进得来 —— core+ 靠邀请码升级，这一步是有意的。
 *
 * 【不加禁言判定】站内封禁的语义是「不能说话」，而下棋不是发言。
 */
export async function requireGameUser(): Promise<GameUserResult> {
  const user = await getCurrentUser();
  if (!user) return apiErr(401, '请先登录');
  if (!isCoreUser(user)) return apiErr(403, '需要核心用户权限');
  if (user.focusMode) return apiErr(403, FOCUS_MODE_BLOCKED_TITLE);
  return user;
}

/** 房间错误 → HTTP。集中一处，免得七条路由各写一份不一致的映射。 */
export function roomErrorResponse(error: RoomError): Response {
  switch (error) {
    case 'notFound':
      return apiErr(404, '房间不存在或已过期');
    case 'notASeat':
      return apiErr(403, '你不在这一局里');
    case 'notPlaying':
      return apiErr(409, '对局尚未开始或已结束');
    case 'notYourTurn':
      return apiErr(409, '还没轮到你');
    case 'illegalMove':
      return apiErr(400, '落子位置不合法');
    case 'tooManyRooms':
      return apiErr(503, '房间太多了，请稍后再试');
    case 'tooManySpectators':
      return apiErr(409, '观战人数已满');
    case 'opponentPresent':
      return apiErr(409, '对手还在线');
    case 'notDisconnectedLongEnough':
      return apiErr(409, '对手刚掉线，请稍候再试');
    case 'nothingToRematch':
      return apiErr(409, '对局尚未结束');
  }
}
