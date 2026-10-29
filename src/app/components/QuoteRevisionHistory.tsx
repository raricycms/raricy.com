import type { DailyQuoteRevision } from '@prisma/client';
import { QUOTE_STATUS_LABELS } from '@/lib/daily-quote';
import { ymdhms } from '@/lib/format';

type Revision = Pick<DailyQuoteRevision, 'revision' | 'status' | 'content' | 'category' | 'signature' |
  'sourceType' | 'sourceName' | 'reviewReason' | 'reviewedAt' | 'createdAt' | 'isBaseline'>;

/** 只由本人和管理员页面传入已授权的版本，不开设公开历史读口。 */
export default function QuoteRevisionHistory({ revisions }: { revisions: Revision[] }) {
  if (!revisions.length) return null;
  return <details className="daily-quote-card__hint">
    <summary>稿件与审核历史</summary>
    {revisions.map((revision) => <div key={revision.revision}>
      <p>版本 {revision.revision} · {revision.status === 'approved' ? '审核通过' : QUOTE_STATUS_LABELS[revision.status]}{revision.isBaseline ? ' · 迁移基线' : ''}</p>
      <p className="daily-quote-submission-text">{revision.content}</p>
      <p>{revision.category} · {revision.signature === 'anonymous' ? '匿名' : '昵称'} · {revision.sourceType === 'original' ? '原创' : `引用自：${revision.sourceName}`}</p>
      {revision.reviewReason && <p>审核说明：{revision.reviewReason}</p>}
      <p className="numeric">{ymdhms(revision.reviewedAt ?? revision.createdAt)}</p>
    </div>)}
  </details>;
}
