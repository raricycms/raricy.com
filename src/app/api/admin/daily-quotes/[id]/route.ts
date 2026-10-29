import { QuoteError, reviewQuote } from '@/lib/daily-quote-service';
import { apiOk } from '@/lib/format';
import { quoteBody, quoteRequest } from '../../../daily-quotes/_http';

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return quoteRequest(async (user) => {
    const body = await quoteBody(request);
    if (typeof body.version !== 'string' || !body.version) throw new QuoteError(400, '请刷新后重新审核');
    await reviewQuote((await params).id, user.id, body.action, body.reason, body.version);
    return apiOk({ message: '审核结果已保存' });
  }, { write: true, admin: true });
}
