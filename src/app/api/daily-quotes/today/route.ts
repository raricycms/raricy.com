import { getTodayQuote } from '@/lib/daily-quote-service';
import { apiOk } from '@/lib/format';
import { quoteRequest } from '../_http';

export async function GET() {
  return quoteRequest(async (user) => apiOk(await getTodayQuote(user.id)));
}
