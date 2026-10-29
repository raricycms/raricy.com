import { getCurrentUser, type SafeUser } from '@/lib/auth';
import { apiErr } from '@/lib/format';
import { QuoteError, requireQuoteParticipant } from '@/lib/daily-quote-service';

export async function quoteRequest(
  action: (user: SafeUser) => Promise<Response>,
  options: { write?: boolean; admin?: boolean } = {},
) {
  try {
    const user = await getCurrentUser();
    if (!user) return apiErr(401, '请先登录');
    await requireQuoteParticipant(user.id, options);
    const response = await action(user);
    response.headers.set('Cache-Control', 'private, no-store');
    return response;
  } catch (error) {
    if (error instanceof QuoteError) return apiErr(error.status, error.message, { reason: error.reason, ...error.extra });
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
