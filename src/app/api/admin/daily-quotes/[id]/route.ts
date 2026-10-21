import { reviewQuote } from '@/lib/daily-quote-service';
import { apiOk } from '@/lib/format';
import { quoteBody, quoteRequest } from '../../../daily-quotes/_http';

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return quoteRequest(async (user) => {
    const body = await quoteBody(request);
    await reviewQuote((await params).id, user.id, body.action, body.reason);
    return apiOk({ message: '审核结果已保存' });
  }, { write: true, admin: true });
}
