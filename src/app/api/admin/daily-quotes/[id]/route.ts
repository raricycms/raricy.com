import { QuoteError, deleteRejectedQuote, reviewQuote } from '@/lib/daily-quote-service';
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

/** 删除「审核未通过」的投稿（软删，管理端「已删除」列表可恢复）。 */
export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  return quoteRequest(async (user) => {
    await deleteRejectedQuote((await params).id, user.id);
    return apiOk({ message: '已删除' });
  }, { write: true, admin: true });
}
