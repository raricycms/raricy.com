import { editQuoteSubmission } from '@/lib/daily-quote-service';
import { apiOk } from '@/lib/format';
import { quoteBody, quoteRequest } from '../../_http';

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return quoteRequest(async (user) => apiOk({
    submission: await editQuoteSubmission((await params).id, user.id, await quoteBody(request)),
    message: '投稿已保存，等待管理员审核',
  }), { write: true });
}
