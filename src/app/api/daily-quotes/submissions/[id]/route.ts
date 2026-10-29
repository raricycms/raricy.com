import { editQuoteSubmission, QuoteError } from '@/lib/daily-quote-service';
import { apiOk } from '@/lib/format';
import { quoteBody, quoteRequest } from '../../_http';

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return quoteRequest(async (user) => {
    const input = await quoteBody(request);
    if (!Number.isSafeInteger(input.version) || (input.version as number) < 1) throw new QuoteError(400, '请刷新后重新编辑', 'VERSION_REQUIRED');
    return apiOk({
      submission: await editQuoteSubmission((await params).id, user.id, input),
      message: '投稿已保存，等待管理员审核',
    });
  }, { write: true });
}
