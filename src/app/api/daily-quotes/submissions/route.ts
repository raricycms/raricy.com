import { listSubmissions, submitQuote } from '@/lib/daily-quote-service';
import { apiOk } from '@/lib/format';
import { quoteBody, quoteRequest } from '../_http';

export async function GET() {
  return quoteRequest(async (user) => apiOk({ submissions: (await listSubmissions(user.id)).map((item) => ({
    id: item.id, content: item.content, category: item.category, signature: item.signature,
    source_type: item.sourceType, source_name: item.sourceName, status: item.status,
    review_reason: item.reviewReason, created_at: item.createdAt.toISOString(),
  })) }));
}

export async function POST(request: Request) {
  return quoteRequest(async (user) => apiOk({
    submission: await submitQuote(user.id, await quoteBody(request)), message: '投稿已提交，等待管理员审核',
  }), { write: true });
}
