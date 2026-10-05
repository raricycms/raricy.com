import Link from 'next/link';
import { requireAdmin } from '@/lib/guard';
import { listAdminLogs } from '@/lib/audit-service';
import { nowForDb } from '@/lib/db-time';
import { ymdhms } from '@/lib/format';
import { pageWindow } from '@/lib/page-window';
import ObjId from '@/app/components/ObjId';
import {
  AUDIT_ACTIONS,
  AUDIT_ACTION_LABEL,
  AUDIT_GROUP_LABEL,
  AUDIT_OBJECT_TYPES,
  AUDIT_OBJECT_TYPE_LABEL,
  actionGroup,
  actionKind,
  actionLabel,
  formatActionDetail,
  objectTypeLabel,
  parseAction,
  type AuditActionGroup,
} from '@/lib/audit-actions';

// 管理端审计检索（admin+）。
//
// 与公开的 `/audit` 是**两件事**，别合并：
//   · /audit       = 公示。core+ 都能看，只列近 30 天、只列 visibility='public' 的日志。
//   · /admin/logs  = 运维检索。看得到**内部日志**（CLI 写下的那批，visibility='internal'），
//                    也**不设时间窗** —— 排查陈年问题要能翻到任意久之前。
//
// ⚠️ 【刻意不抹当事人】本页**不**套 /audit 那套 hideTarget 脱敏：匿名评论的处置日志
// 在这里照常显示真实当事人。这正是本页要 admin 档的原因（见 docs/architecture.md §6.16
// 与 audit-service.ts 头部：CLI/运维看真身，公示面不看）。别「为了统一」把脱敏搬过来。
//
// 档位：父 /admin 母版只把 core 门，这一页自己 requireAdmin()（admin + owner）。
// 数据源是 listAdminLogs —— 它已默认 visibility='all' 且不设时间窗，不需要另写查询。

export const dynamic = 'force-dynamic';

const GROUPS: AuditActionGroup[] = ['user', 'content', 'system'];
/** 时间窗档位（天）。空 = 不限。 */
const RANGES = [1, 7, 30, 90, 365] as const;
const VISIBILITIES = ['all', 'public', 'internal'] as const;
type Visibility = (typeof VISIBILITIES)[number];

interface SearchParams {
  page?: string;
  action?: string;
  admin?: string;
  target?: string;
  type?: string;
  objectId?: string;
  visibility?: string;
  range?: string;
}

export default async function AdminLogsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  await requireAdmin();
  const sp = await searchParams;

  const days = (RANGES as readonly number[]).includes(Number(sp.range)) ? Number(sp.range) : null;
  // 起点与写入 createdAt 同口径（nowForDb，UTC+8 墙上时间贴 Z）—— 用真实 Date.now()
  // 会把窗口平移 8 小时。同 audit-service 的窗口注释。
  const since = days ? new Date(nowForDb().getTime() - days * 86_400_000) : null;
  const visibility: Visibility = (VISIBILITIES as readonly string[]).includes(sp.visibility ?? '')
    ? (sp.visibility as Visibility)
    : 'all';

  const result = await listAdminLogs({
    page: parseInt(sp.page || '1', 10),
    perPage: 40,
    action: parseAction(sp.action),
    adminUsername: sp.admin ?? null,
    // 不套 hideTarget：管理员看真身（见文件头）。listAdminLogs 也不做脱敏。
    targetUsername: sp.target ?? null,
    objectType: sp.type ?? null,
    objectId: sp.objectId ?? null,
    visibility,
    since,
  });

  const hasFilter = Boolean(
    sp.action || sp.admin || sp.target || sp.type || sp.objectId || (sp.visibility && visibility !== 'all') || days
  );

  const qs = (page: number) => {
    const p = new URLSearchParams();
    p.set('page', String(page));
    if (sp.action) p.set('action', sp.action);
    if (sp.admin) p.set('admin', sp.admin);
    if (sp.target) p.set('target', sp.target);
    if (sp.type) p.set('type', sp.type);
    if (sp.objectId) p.set('objectId', sp.objectId);
    if (sp.visibility && visibility !== 'all') p.set('visibility', visibility);
    if (days) p.set('range', String(days));
    return `?${p.toString()}`;
  };

  return (
    <>
      <section className="admin-hero">
        <h1>日志检索</h1>
        <p>全部管理动作（含内部日志）· 不设时间窗 · 管理员可见</p>
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
                  {AUDIT_ACTIONS.filter((a) => actionGroup(a) === g).map((a) => (
                    <option key={a} value={a}>
                      {AUDIT_ACTION_LABEL[a]}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>

            <input
              type="search"
              name="admin"
              className="form-control"
              aria-label="按执行者用户名搜索"
              placeholder="执行者用户名…"
              defaultValue={sp.admin ?? ''}
            />

            <input
              type="search"
              name="target"
              className="form-control"
              aria-label="按当事人用户名搜索"
              placeholder="当事人用户名…"
              defaultValue={sp.target ?? ''}
            />

            <select
              name="type"
              className="form-select"
              aria-label="按对象类型筛选"
              defaultValue={sp.type ?? ''}
            >
              <option value="">全部对象</option>
              {AUDIT_OBJECT_TYPES.map((t) => (
                <option key={t} value={t}>
                  {AUDIT_OBJECT_TYPE_LABEL[t]}
                </option>
              ))}
            </select>

            <input
              type="search"
              name="objectId"
              className="form-control"
              aria-label="按对象 ID 搜索"
              placeholder="对象 ID…"
              defaultValue={sp.objectId ?? ''}
            />

            <select
              name="visibility"
              className="form-select"
              aria-label="按可见性筛选"
              defaultValue={visibility}
            >
              <option value="all">全部来源</option>
              <option value="public">仅公示日志</option>
              <option value="internal">仅内部日志</option>
            </select>

            <select
              name="range"
              className="form-select"
              aria-label="时间范围"
              defaultValue={days ? String(days) : ''}
            >
              <option value="">不限时间</option>
              {RANGES.map((d) => (
                <option key={d} value={d}>
                  近 {d} 天
                </option>
              ))}
            </select>

            <button type="submit" className="btn btn-primary">
              检索
            </button>
            {hasFilter && (
              <Link href="/admin/logs" className="btn btn-secondary">
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
                  <th>当事人</th>
                  <th>对象</th>
                  <th>原因</th>
                  <th>状态</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {result.items.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="audit-table__empty">
                      没有符合条件的记录
                    </td>
                  </tr>
                ) : (
                  result.items.map((log) => {
                    const objType = log.object?.type ?? null;
                    const oid = log.object?.id;
                    const detail = formatActionDetail(log.action, log.extra);
                    return (
                      <tr key={log.id}>
                        <td>
                          <span className="audit-cell__time">
                            {ymdhms(log.createdAt) ?? '—'}
                          </span>
                        </td>
                        <td>
                          <span className={`audit-chip audit-chip--${actionKind(log.action)}`}>
                            {actionLabel(log.action) ?? log.action}
                          </span>
                          {log.visibility !== 'public' ? (
                            <span className="status-badge status-badge--internal">内部</span>
                          ) : null}
                          {detail ? <span className="audit-cell__detail">{detail}</span> : null}
                        </td>
                        <td>{log.admin.username ?? log.admin.id}</td>
                        <td>{log.targetUser?.username ?? log.targetUser?.id ?? '—'}</td>
                        <td>
                          {objType ? (
                            <>
                              {objectTypeLabel(objType) ?? objType}
                              <ObjId oid={oid} />
                            </>
                          ) : (
                            <ObjId oid={oid} />
                          )}
                        </td>
                        <td>{log.reason ?? ''}</td>
                        <td>
                          {log.hasPendingAppeal ? (
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
