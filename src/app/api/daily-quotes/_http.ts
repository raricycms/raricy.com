import { getCurrentUser, hasAdminRights, isCoreUser, isCurrentlyBanned, type SafeUser } from '@/lib/auth';
import { apiErr } from '@/lib/format';
import { QuoteError } from '@/lib/daily-quote-service';

export async function quoteRequest(
  action: (user: SafeUser) => Promise<Response>,
  options: { write?: boolean; admin?: boolean } = {},
) {
  try {
    const user = await getCurrentUser();
    if (!user) return apiErr(401, '请先登录');
    if (!isCoreUser(user)) return apiErr(403, '需要核心用户权限');
    if (options.admin && !hasAdminRights(user)) return apiErr(403, '需要管理员权限');
    if (options.write && isCurrentlyBanned(user)) return apiErr(403, '禁言期间暂时无法操作');
    const response = await action(user);
    response.headers.set('Cache-Control', 'private, no-store');
    return response;
  } catch (error) {
    if (error instanceof QuoteError) return apiErr(error.status, error.message);
    console.error('[daily-quotes] 操作失败:', error);
    return apiErr(500, '操作失败，请稍后重试');
  }
}

export async function quoteBody(request: Request): Promise<Record<string, unknown>> {
  try {
    const data = await request.json();
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('object required');
    return data;
  } catch { throw new QuoteError(400, '请求内容格式无效'); }
}
