import { resonateQuote } from '@/lib/daily-quote-service';
import { apiOk } from '@/lib/format';
import { quoteBody, quoteRequest } from '../../_http';

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return quoteRequest(async (user) => apiOk(await resonateQuote((await params).id, user.id, (await quoteBody(request)).max_fish)), { write: true });
}
