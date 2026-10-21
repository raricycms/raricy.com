import { saveQuote } from '@/lib/daily-quote-service';
import { apiOk } from '@/lib/format';
import { quoteRequest } from '../../_http';

type Context = { params: Promise<{ id: string }> };
export async function POST(_request: Request, { params }: Context) {
  return quoteRequest(async (user) => {
    await saveQuote((await params).id, user.id, true);
    return apiOk({ favorited: true, message: '已收藏到一言集' });
  }, { write: true });
}
export async function DELETE(_request: Request, { params }: Context) {
  return quoteRequest(async (user) => {
    await saveQuote((await params).id, user.id, false);
    return apiOk({ favorited: false, message: '已移出一言集' });
  }, { write: true });
}
