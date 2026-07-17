import Link from 'next/link';
import { requireCoreUser } from '@/lib/guard';
import { listPublicLogs } from '@/lib/audit-service';
import { prisma } from '@/lib/db';
import ActionFilter from './ActionFilter';

export const dynamic = 'force-dynamic'; // 依赖查询参数，禁用静态化

interface SearchParams {
  page?: string;
  action?: string;
}

function shortOid(oid: string | null | undefined): string {
  if (!oid) return '';
  return oid.length > 16 ? `${oid.slice(0, 8)}…${oid.slice(-4)}` : oid;
}

function ObjId({ oid }: { oid: string | null | undefined }) {
  if (!oid) return null;
  return (
    <span className="obj-id">
      <details>
        <summary>{shortOid(oid)}</summary>
        <code>{oid}</code>
      </details>
    </span>
  );
}

export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  // layout 已鉴权；这里再判一次做纵深防御（页面若被单独复用/直连也拦得住）。
  await requireCoreUser();
  const sp = await searchParams;
  const result = await listPublicLogs({
    page: parseInt(sp.page || '1', 10),
    action: sp.action ?? null,
  });

  // 已撤回标记：对齐 Flask log.appeals.filter_by(status='accepted').first()。
  // 有任一 accepted 申诉即视为「已撤回」，行加 log-row--reverted、状态列显示撤回徽章。
  const logIds = result.items.map((log) => log.id);
  const acceptedRows = logIds.length
    ? await prisma.adminActionAppeal.findMany({
        where: { logId: { in: logIds }, status: 'accepted' },
        select: { logId: true },
      })
    : [];
  const revertedSet = new Set(acceptedRows.map((r) => r.logId));

  const qs = (page: number) => {
    const p = new URLSearchParams();
    p.set('page', String(page));
    if (sp.action) p.set('action', sp.action);
    return `?${p.toString()}`;
  };

  return (
    <div className="container">
      <h2 className="mb-3">管理员操作公示</h2>

      <ActionFilter action={sp.action ?? ''} />

      <div className="table-responsive">
        <table className="table">
          <thead>
            <tr>
              <th>类型</th>
              <th>管理员</th>
              <th>对象</th>
              <th>原因</th>
              <th>状态</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {result.items.map((log) => {
              const objType = log.object?.type;
              const oid = log.object?.id;
              const reverted = revertedSet.has(log.id);
              return (
                <tr key={log.id} className={reverted ? 'log-row--reverted' : ''}>
                  <td className="log-row__type">{log.action}</td>
                  <td>{log.admin.username ?? log.admin.id}</td>
                  <td>
                    {objType === 'blog' ? (
                      <>
                        文章 {String(log.extra?.blog_title ?? '')}
                        <ObjId oid={oid} />
                      </>
                    ) : objType === 'comment' ? (
                      <>
                        评论
                        <ObjId oid={oid} />
                      </>
                    ) : objType === 'user' ? (
                      <>用户 {log.targetUser?.username ?? log.targetUser?.id}</>
                    ) : (
                      <>
                        {objType ?? ''}
                        <ObjId oid={oid} />
                      </>
                    )}
                  </td>
                  <td>{log.reason ?? ''}</td>
                  <td>
                    {reverted ? (
                      <span className="status-badge status-badge--reverted">已撤回</span>
                    ) : log.hasPendingAppeal ? (
                      <span className="status-badge status-badge--pending">申诉中</span>
                    ) : (
                      <span className="status-badge">—</span>
                    )}
                  </td>
                  <td><Link href={`/audit/${log.id}`}>详情</Link></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {result.pages > 1 && (
        <nav>
          <ul className="pagination">
            {result.hasPrev && (
              <li className="page-item">
                <Link className="page-link" href={qs(result.page - 1)}>上一页</Link>
              </li>
            )}
            <li className="page-item disabled">
              <span className="page-link">{result.page}/{result.pages}</span>
            </li>
            {result.hasNext && (
              <li className="page-item">
                <Link className="page-link" href={qs(result.page + 1)}>下一页</Link>
              </li>
            )}
          </ul>
        </nav>
      )}
    </div>
  );
}
