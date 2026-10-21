import { resonateQuote } from '@/lib/daily-quote-service';
import { apiOk } from '@/lib/format';
import { quoteRequest } from '../../_http';

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  return quoteRequest(async (user) => apiOk(await resonateQuote((await params).id, user.id)), { write: true });
}
