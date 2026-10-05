import Link from 'next/link';
import { requireCoreUser } from '@/lib/guard';
import { listPublicLogs, PUBLIC_RANGE_DAYS } from '@/lib/audit-service';
import { prisma } from '@/lib/db';
import { ymdhms } from '@/lib/format';
import { pageWindow } from '@/lib/page-window';
import {
  AUDIT_ACTION_LABEL,
  AUDIT_GROUP_LABEL,
  PUBLIC_AUDIT_ACTIONS,
  PUBLIC_AUDIT_OBJECT_TYPES,
  actionGroup,
  actionKind,
  actionLabel,
  formatActionDetail,
  objectTypeLabel,
  parseAction,
  type AuditActionGroup,
} from '@/lib/audit-actions';

// 管理员操作公示（core+ 可见）。
//
// 筛选走原生 GET 表单（全仓其它筛选页一致），不再用客户端组件 —— 那个组件只为
// 「动作下拉一改就自动提交」而存在，而筛选现在有六个字段。
//
// ⚠️ 两条被 e2e 钉住的东西别动：查询参数名 `?action=`（audit-detail.spec 靠它把
// 结果集缩小到种子那几条）与每行的 `/audit/<id>` 详情链接。
//
// ⚠️ 时间窗上限是 30 天（listPublicLogs 的硬策略）—— 这里只提供「更近」两档，
// 想翻更早的走 /admin/logs。

export const dynamic = 'force-dynamic';

interface SearchParams {
  page?: string;
  action?: string;
  q?: string;
  type?: string;
  target?: string;
  mine?: string;
  range?: string;
}

const GROUPS: AuditActionGroup[] = ['user', 'content', 'system'];

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
  const me = await requireCoreUser();
  const sp = await searchParams;

  // 非法窗值（含空串 / NaN）一律回落 30 天上限 —— 别让一个 query 参数把公示窗口撑开。
  const rangeDays = (PUBLIC_RANGE_DAYS as readonly number[]).includes(Number(sp.range))
    ? Number(sp.range)
    : 30;

  const result = await listPublicLogs({
    page: parseInt(sp.page || '1', 10),
    action: parseAction(sp.action), // 非法动作码 → null（不筛），不是 400
    q: sp.q ?? null,
    objectType: sp.type ?? null,
    targetUsername: sp.target ?? null,
    mine: sp.mine ? me.id : null,
    rangeDays,
  });

  const logIds = result.items.map((log) => log.id);
  const acceptedRows = logIds.length
    ? await prisma.adminActionAppeal.findMany({
        where: { logId: { in: logIds }, status: 'accepted' },
        select: { logId: true },
      })
    : [];
  const revertedSet = new Set(acceptedRows.map((r) => r.logId));

  const hasFilter = Boolean(
    sp.action || sp.q || sp.type || sp.target || sp.mine || (sp.range && rangeDays !== 30)
  );

  // 翻页链接必须重发全部生效参数，否则翻到第 2 页筛选就丢了。
  const qs = (page: number) => {
    const p = new URLSearchParams();
    p.set('page', String(page));
    if (sp.action) p.set('action', sp.action);
    if (sp.q) p.set('q', sp.q);
    if (sp.type) p.set('type', sp.type);
    if (sp.target) p.set('target', sp.target);
    if (sp.mine) p.set('mine', '1');
    if (sp.range && rangeDays !== 30) p.set('range', String(rangeDays));
    return `?${p.toString()}`;
  };

  return (
    <>
      <section className="admin-hero">
        <h1>管理员操作公示</h1>
        <p>站内管理动作的公开记录（近 30 天）· 被处置者可在此申诉</p>
      </section>

      <div className="admin-container">
        <div className="management-card">
          <form method="GET" className="admin-filter-bar audit-filter-bar">
            <select
              name="action"
              className="form-select"
              aria-label="按动作筛选"
              defaultValue={sp.action ?? ''}
            >
              <option value="">全部动作</option>
              {GROUPS.map((g) => (
                <optgroup key={g} label={AUDIT_GROUP_LABEL[g]}>
                  {PUBLIC_AUDIT_ACTIONS.filter((a) => actionGroup(a) === g).map((a) => (
                    <option key={a} value={a}>
                      {AUDIT_ACTION_LABEL[a]}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>

            <input
              type="search"
              name="q"
              className="form-control"
              aria-label="按原因或对象 ID 搜索"
              placeholder="搜索原因 / 对象 ID…"
              defaultValue={sp.q ?? ''}
            />

            <select
              name="type"
              className="form-select"
              aria-label="按对象类型筛选"
              defaultValue={sp.type ?? ''}
            >
              <option value="">全部对象</option>
              {PUBLIC_AUDIT_OBJECT_TYPES.map((t) => (
                <option key={t} value={t}>
                  {objectTypeLabel(t) ?? t}
                </option>
              ))}
            </select>

            <input
              type="search"
              name="target"
              className="form-control"
              aria-label="按当事人用户名搜索"
              placeholder="当事人用户名…"
              defaultValue={sp.target ?? ''}
            />

            <label className="audit-filter-check">
              <input type="checkbox" name="mine" value="1" defaultChecked={Boolean(sp.mine)} />
              只看我相关的
            </label>

            <select
              name="range"
              className="form-select"
              aria-label="时间范围"
              defaultValue={String(rangeDays)}
            >
              {PUBLIC_RANGE_DAYS.map((d) => (
                <option key={d} value={d}>
                  近 {d} 天
                </option>
              ))}
            </select>

            <button type="submit" className="btn btn-primary">
              筛选
            </button>
            {hasFilter && (
              <Link href="/audit" className="btn btn-secondary">
                清除
              </Link>
            )}

            <span className="audit-total">共 {result.total} 条</span>
          </form>

          <div className="table-responsive">
            <table className="table">
              <thead>
                <tr>
                  <th>时间</th>
                  <th>类型</th>
                  <th>管理员</th>
                  <th>对象</th>
                  <th>原因</th>
                  <th>状态</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {result.items.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="audit-table__empty">
                      没有符合条件的记录
                    </td>
                  </tr>
                ) : (
                  result.items.map((log) => {
                    const objType = log.object?.type ?? null;
                    const oid = log.object?.id;
                    const reverted = revertedSet.has(log.id);
                    const detail = formatActionDetail(log.action, log.extra);
                    return (
                      <tr key={log.id} className={reverted ? 'log-row--reverted' : undefined}>
                        <td>
                          <span className="audit-cell__time">
                            {ymdhms(log.createdAt) ?? '—'}
                          </span>
                        </td>
                        <td className="log-row__type">
                          <span className={`audit-chip audit-chip--${actionKind(log.action)}`}>
                            {actionLabel(log.action) ?? log.action}
                          </span>
                          {detail ? <span className="audit-cell__detail">{detail}</span> : null}
                        </td>
                        <td>{log.admin.username ?? log.admin.id}</td>
                        <td>
                          {objType === 'blog' ? (
                            <>
                              文章
                              <ObjId oid={oid} />
                            </>
                          ) : objType === 'comment' ? (
                            <>
                              评论
                              <ObjId oid={oid} />
                              {log.targetHidden ? (
                                <span className="audit-cell__detail">（匿名评论，作者不公开）</span>
                              ) : null}
                            </>
                          ) : objType === 'user' ? (
                            <>用户 {log.targetUser?.username ?? log.targetUser?.id ?? '—'}</>
                          ) : objType || oid ? (
                            <>
                              {objectTypeLabel(objType ?? '') ?? objType}
                              <ObjId oid={oid} />
                            </>
                          ) : (
                            '—'
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
                        <td>
                          <Link href={`/audit/${log.id}`}>详情</Link>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>

          {result.pages > 1 && (
            <div className="admin-pagination">
              <nav>
                <ul className="pagination">
                  {result.hasPrev && (
                    <li className="page-item">
                      <Link className="page-link" href={qs(result.page - 1)}>
                        &laquo;
                      </Link>
                    </li>
                  )}
                  {pageWindow(result.page, result.pages).map((p, i) =>
                    p === null ? (
                      <li key={`gap-${i}`} className="page-item disabled">
                        <span className="page-link">…</span>
                      </li>
                    ) : (
                      <li key={p} className={`page-item ${p === result.page ? 'active' : ''}`}>
                        {p === result.page ? (
                          <span className="page-link">{p}</span>
                        ) : (
                          <Link className="page-link" href={qs(p)}>
                            {p}
                          </Link>
                        )}
                      </li>
                    )
                  )}
                  {result.hasNext && (
                    <li className="page-item">
                      <Link className="page-link" href={qs(result.page + 1)}>
                        &raquo;
                      </Link>
                    </li>
                  )}
                </ul>
              </nav>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
