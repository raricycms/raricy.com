// 讨论接口统一鉴权：仅 core+（页面层 requireCoreUser 之外，接口必须自检）。
import { getCurrentUser, isCoreUser, isCurrentlyBanned, type SafeUser } from '@/lib/auth';
import { apiErr } from '@/lib/format';

export type ChatUserResult = SafeUser | Response;

export async function requireChatUser(): Promise<ChatUserResult> {
  const user = await getCurrentUser();
  if (!user) return apiErr(401, '请先登录');
  if (!isCoreUser(user)) return apiErr(403, '需要核心用户权限');
  if (isCurrentlyBanned(user)) return apiErr(403, '你已被禁言，暂时无法讨论');
  return user;
}

/**
 * 由 params / query 解析出正整数，非法返回 null。
 *
 * **必须是严格十进制**：`Number()` 会把 `1e3`（→1000）、`0x10`（→16）、`' 12 '`
 * （→12）、`'+5'` 全部放行，于是路径里的字面 id 与真正操作的对象可以不是同一个
 * （R3-262）。这里只认 `[1-9][0-9]*` 且落在安全整数范围内；前导零也拒绝 ——
 * `007` 与 `7` 是两种写法，放行会让「同一个 id 多种表示」重新出现。
 */
export function parsePosInt(raw: unknown): number | null {
  if (typeof raw !== 'string' || !/^[1-9][0-9]*$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : null;
}
