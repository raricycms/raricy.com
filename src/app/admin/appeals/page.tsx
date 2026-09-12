import Link from 'next/link';
import { listAppeals } from '@/lib/admin-appeal-service';
import AdminAppealActions from '@/app/components/AdminAppealActions';

export const dynamic = 'force-dynamic';

interface SearchParams {
  page?: string;
  status?: string;
}

const STATUS_LABELS: Record<string, string> = {
  pending: '待处理',
  accepted: '已通过',
  rejected: '已驳回',
};

const STATUS_BADGE: Record<string, string> = {
  pending: 'status-badge status-badge--pending',
  accepted: 'status-badge status-badge--reverted',
  rejected: 'status-badge',
};

const ACTION_LABELS: Record<string, string> = {
  ban_user: '禁言用户',
  unban_user: '解除禁言',
  delete_blog: '删除文章',
  delete_comment: '删除评论',
  change_role: '角色变更',
};

function fmt(iso: string | null): string {
  if (!iso) return '';
  return iso.slice(0, 19).replace('T', ' ');
}

// 申诉管理 — Fluent Design
export default async function AdminAppealsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const sp = await searchParams;
  const result = await listAppeals({
    page: parseInt(sp.page || '1', 10),
    status: sp.status ?? null,
  });

  const qs = (page: number, status?: string) => {
    const p = new URLSearchParams();
    const s = status ?? sp.status;
    if (s) p.set('status', s);
    p.set('page', String(page));
    return `?${p.toString()}`;
  };

  return (
    <>
      <section className="admin-hero">
        <h1>操作申诉</h1>
        <p>
          共 {result.total} 条申诉 · 通过申诉时会尝试自动撤回原动作（禁言可自动解除）
        </p>
      </section>

      <div className="admin-container">
        <div className="d-flex mb-3" style={{ gap: 8, flexWrap: 'wrap' }}>
          {['', 'pending', 'accepted', 'rejected'].map((s) => (
            <Link
              key={s || 'all'}
              href={qs(1, s)}
              className={`btn btn-sm ${
                (sp.status ?? '') === s ? 'btn-primary' : 'btn-outline-secondary'
              }`}
            >
              {s ? STATUS_LABELS[s] : '全部'}
            </Link>
          ))}
        </div>

        {result.items.length === 0 && (
          <div className="text-center text-muted py-5">
            <h5 className="mt-3">暂无申诉</h5>
          </div>
        )}

        {result.items.map((a) => (
          <article key={a.id} className="article-card">
            <div className="article-card__info">
              <div className="d-flex align-items-center mb-2" style={{ gap: 8, flexWrap: 'wrap' }}>
                <span className={STATUS_BADGE[a.status] ?? 'status-badge'}>
                  {STATUS_LABELS[a.status] ?? a.status}
                </span>
                <strong>{a.appellant.username ?? a.appellant.id}</strong>
                <span className="text-muted" style={{ fontSize: '0.9rem' }}>
                  针对：
                  {a.log
                    ? `${ACTION_LABELS[a.log.action] ?? a.log.action}` +
                      (a.log.targetUser
                        ? ` → ${a.log.targetUser.username ?? a.log.targetUser.id}`
                        : '')
                    : '（日志已不存在）'}
                </span>
                <span
                  className="text-muted"
                  style={{ marginLeft: 'auto', fontSize: '0.8rem' }}
                >
                  {fmt(a.createdAt)}
                </span>
              </div>

              <p style={{ whiteSpace: 'pre-wrap', margin: '8px 0' }}>{a.content}</p>

              {a.log?.reason && (
                <p className="text-muted" style={{ margin: '4px 0 0', fontSize: '0.9rem' }}>
                  原操作理由：{a.log.reason}
                </p>
              )}

              {a.status === 'pending' ? (
                <AdminAppealActions appealId={a.id} />
              ) : (
                <p className="text-muted" style={{ marginTop: 8, fontSize: '0.9rem' }}>
                  裁决：{a.decision || '（无批注）'}
                  {a.decider ? ` · 由 ${a.decider.username ?? a.decider.id}` : ''}
                  {a.decidedAt ? ` · ${fmt(a.decidedAt)}` : ''}
                </p>
              )}
            </div>
          </article>
        ))}

        {result.pages > 1 && (
          <div className="admin-pagination">
            <nav>
              <ul className="pagination">
                {result.hasPrev && (
                  <li className="page-item">
                    <Link className="page-link" href={qs(result.page - 1)}>
                      ‹
                    </Link>
                  </li>
                )}
                {Array.from({ length: result.pages }, (_, i) => i + 1).map((p) => (
                  <li key={p} className={`page-item ${p === result.page ? 'active' : ''}`}>
                    {p === result.page ? (
                      <span className="page-link">{p}</span>
                    ) : (
                      <Link className="page-link" href={qs(p)}>
                        {p}
                      </Link>
                    )}
                  </li>
                ))}
                {result.hasNext && (
                  <li className="page-item">
                    <Link className="page-link" href={qs(result.page + 1)}>
                      ›
                    </Link>
                  </li>
                )}
              </ul>
            </nav>
          </div>
        )}
      </div>
    </>
  );
}
