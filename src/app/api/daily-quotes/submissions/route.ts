import { listSubmissions, submitQuote } from '@/lib/daily-quote-service';
import { apiOk } from '@/lib/format';
import { quoteBody, quoteRequest } from '../_http';

export async function GET() {
  return quoteRequest(async (user) => apiOk({ submissions: (await listSubmissions(user.id)).map((item) => ({
    id: item.id, content: item.content, category: item.category, signature: item.signature,
    source_type: item.sourceType, source_name: item.sourceName, status: item.status,
    review_reason: item.reviewReason, created_at: item.createdAt.toISOString(),
    version: item.version, display_status: item.display_status, first_selected_day: item.firstSelectedDay,
    history: item.revisions.map((revision) => ({ version: revision.revision, content: revision.content,
      category: revision.category, signature: revision.signature, source_type: revision.sourceType, source_name: revision.sourceName,
      status: revision.status, review_reason: revision.reviewReason, reviewed_at: revision.reviewedAt?.toISOString() ?? null,
      created_at: revision.createdAt.toISOString(), is_baseline: revision.isBaseline })),
  })) }));
}

export async function POST(request: Request) {
  return quoteRequest(async (user) => apiOk({
    submission: await submitQuote(user.id, await quoteBody(request)), message: '投稿已提交，等待管理员审核',
  }), { write: true });
}
