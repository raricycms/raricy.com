// 聊天接口统一鉴权：仅 core+（页面层 requireCoreUser 之外，接口必须自检）。
import { getCurrentUser, isCoreUser, isCurrentlyBanned, type SafeUser } from '@/lib/auth';
import { apiErr } from '@/lib/format';

export type ChatUserResult = SafeUser | Response;

export async function requireChatUser(): Promise<ChatUserResult> {
  const user = await getCurrentUser();
  if (!user) return apiErr(401, '请先登录');
  if (!isCoreUser(user)) return apiErr(403, '需要核心用户权限');
  if (isCurrentlyBanned(user)) return apiErr(403, '你已被禁言，暂时无法聊天');
  return user;
}

/** 由 params 解析出正整数，非法返回 null。 */
export function parsePosInt(raw: unknown): number | null {
  if (typeof raw !== 'string') return null;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}
