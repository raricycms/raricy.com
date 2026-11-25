import { restoreDeletedQuote } from '@/lib/daily-quote-service';
import { apiOk } from '@/lib/format';
import { quoteRequest } from '../../../../daily-quotes/_http';

/** 恢复一条被软删的「未通过」投稿（管理端「已删除」列表）。 */
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  return quoteRequest(async (user) => {
    await restoreDeletedQuote((await params).id, user.id);
    return apiOk({ message: '已恢复' });
  }, { write: true, admin: true });
}
