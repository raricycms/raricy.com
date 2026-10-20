import Link from 'next/link';
import { ScrollText, Search } from 'lucide-react';
import { requireAdmin } from '@/lib/guard';
import { listAdminLogs } from '@/lib/audit-service';
import { nowForDb } from '@/lib/db-time';
import { ymdhms } from '@/lib/format';
import ObjId from '@/app/components/ObjId';
import AdminPageHeader from '@/app/components/AdminPageHeader';
import AdminEmpty from '@/app/components/AdminEmpty';
import AdminPager from '@/app/components/AdminPager';
import ExpandSelect, { type ExpandSelectGroup } from '@/app/components/ExpandSelect';
import {
  WEB_AUDIT_ACTIONS,
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
//
// 版面：抬头 / 面板 / 表格 / 空态 / 分页全部复用 pages/admin/_common.scss 的原语
// （AdminPageHeader / .admin-filter-bar / .admin-table / AdminEmpty / AdminPager），
// 日志表自己的列宽与窄屏折卡细节在 pages/admin/_logs.scss。
//
// ⚠️ 三条被 e2e 钉住、别动：
//   · 表单容器类 `admin-filter-bar audit-filter-bar`
//     （tests/e2e/admin-logs.spec.ts 用 `form.audit-filter-bar` 定位）；
//   · 六个筛选控件首屏就要可见（没有「展开筛选」这种折叠层）——
//     动作下拉 / 执行者输入 / 当事人输入 / 时间范围下拉都在那条用例里；
//   · 抬头 h1 的文案是「日志检索」。

export const dynamic = 'force-dynamic';

const GROUPS: AuditActionGroup[] = ['user', 'content', 'system'];
/** 时间窗档位（天）。空 = 不限。 */
const RANGES = [1, 7, 30, 90, 365] as const;
const VISIBILITIES = ['all', 'public', 'internal'] as const;
type Visibility = (typeof VISIBILITIES)[number];

// 筛选项的形状与原生 <option>/<optgroup> 一一对应，只是换成会展开动画的
// ExpandSelect（组件头有「为什么不用原生 select」）。动作仍按 group 分块。
const ACTION_GROUPS: ExpandSelectGroup[] = [
  { options: [{ value: '', label: '全部动作' }] },
  ...GROUPS.map((group) => ({
    label: AUDIT_GROUP_LABEL[group],
    options: WEB_AUDIT_ACTIONS.filter((action) => actionGroup(action) === group).map(
      (action) => ({ value: action, label: AUDIT_ACTION_LABEL[action] })
    ),
  })),
];

const TYPE_GROUPS: ExpandSelectGroup[] = [
  {
    options: [
      { value: '', label: '全部对象' },
      ...AUDIT_OBJECT_TYPES.map((type) => ({
        value: type,
        label: AUDIT_OBJECT_TYPE_LABEL[type],
      })),
    ],
  },
];

const VISIBILITY_GROUPS: ExpandSelectGroup[] = [
  {
    options: [
      { value: 'all', label: '全部来源' },
      { value: 'public', label: '仅公示日志' },
      { value: 'internal', label: '仅内部日志' },
    ],
  },
];

const RANGE_GROUPS: ExpandSelectGroup[] = [
  {
    options: [
      { value: '', label: '不限时间' },
      ...RANGES.map((days) => ({ value: String(days), label: `近 ${days} 天` })),
    ],
  },
];

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

  // 翻页链接必须重发全部生效参数，否则翻到第 2 页筛选就丢了。
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
      <AdminPageHeader
        eyebrow={
          <>
            <ScrollText aria-hidden="true" />
            系统 · 审计
          </>
        }
        title="日志检索"
        subtitle="全部管理动作（含内部日志）· 不设时间窗 · 管理员可见"
      />

      <div className="admin-container">
        {/* 字段多，所以不用吸顶的胶囊工具栏：主行只放搜索与操作，其余字段各带标签
            排进网格。六个控件全部首屏可见 —— 折叠起来会藏掉「时间范围」这类常调项。 */}
        <form method="GET" className="admin-filter-bar audit-filter-bar">
          <div className="admin-filter__primary">
            <label className="admin-search">
              <span className="admin-search__icon" aria-hidden="true">
                <Search />
              </span>
              <input
                type="search"
                name="admin"
                className="admin-search__input"
                placeholder="按执行者用户名搜索…"
                aria-label="按执行者用户名搜索"
                defaultValue={sp.admin ?? ''}
              />
            </label>

            <button type="submit" className="btn btn-primary">
              检索
            </button>
            {hasFilter && (
              <Link href="/admin/logs" className="btn btn-secondary">
                清除
              </Link>
            )}

            <span className="admin-filter__total">
              <span className="numeric">{result.total}</span> 条
            </span>
          </div>

          <div className="admin-filter__grid">
            <div className="admin-field">
              <label className="admin-field__label" htmlFor="log-action">
                动作
              </label>
              <ExpandSelect
                id="log-action"
                name="action"
                className="admin-field__control"
                defaultValue={sp.action ?? ''}
                groups={ACTION_GROUPS}
              />
            </div>

            <div className="admin-field">
              <label className="admin-field__label" htmlFor="log-type">
                对象类型
              </label>
              <ExpandSelect
                id="log-type"
                name="type"
                className="admin-field__control"
                defaultValue={sp.type ?? ''}
                groups={TYPE_GROUPS}
              />
            </div>

            <div className="admin-field">
              <label className="admin-field__label" htmlFor="log-target">
                当事人
              </label>
              <input
                id="log-target"
                type="search"
                name="target"
                className="form-control admin-field__control"
                placeholder="当事人用户名…"
                defaultValue={sp.target ?? ''}
              />
            </div>

            <div className="admin-field">
              <label className="admin-field__label" htmlFor="log-object-id">
                对象 ID
              </label>
              <input
                id="log-object-id"
                type="search"
                name="objectId"
                className="form-control admin-field__control"
                placeholder="对象 ID…"
                defaultValue={sp.objectId ?? ''}
              />
            </div>

            <div className="admin-field">
              <label className="admin-field__label" htmlFor="log-visibility">
                来源
              </label>
              <ExpandSelect
                id="log-visibility"
                name="visibility"
                className="admin-field__control"
                defaultValue={visibility}
                groups={VISIBILITY_GROUPS}
              />
            </div>

            <div className="admin-field">
              <label className="admin-field__label" htmlFor="log-range">
                时间范围
              </label>
              <ExpandSelect
                id="log-range"
                name="range"
                className="admin-field__control numeric"
                defaultValue={days ? String(days) : ''}
                groups={RANGE_GROUPS}
              />
            </div>
          </div>
        </form>

        {result.items.length === 0 ? (
          <AdminEmpty
            icon={ScrollText}
            title="没有符合条件的记录"
            description="调整筛选条件后再试。"
          />
        ) : (
          <div className="admin-panel admin-log-panel">
            {/* data-label 是窄屏折卡的唯一依据（见 _common.scss 的 .admin-table 规则）：
                每一格都要写，空的「详情」格写成 data-label="" 才会隐藏标签。 */}
            <div className="admin-table-scroll">
              <table className="admin-table admin-log-table">
                <thead>
                  <tr>
                    <th scope="col">时间</th>
                    <th scope="col">类型</th>
                    <th scope="col">管理员</th>
                    <th scope="col">当事人</th>
                    <th scope="col">对象</th>
                    <th scope="col">原因</th>
                    <th scope="col">状态</th>
                    <th scope="col">
                      <span className="visually-hidden">详情</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {result.items.map((log) => {
                    const objType = log.object?.type ?? null;
                    const oid = log.object?.id;
                    const detail = formatActionDetail(log.action, log.extra);
                    return (
                      <tr key={log.id}>
                        <td data-label="时间">
                          <span className="admin-log-table__cell">
                            <span className="admin-log-table__time numeric">
                              {ymdhms(log.createdAt) ?? '—'}
                            </span>
                          </span>
                        </td>
                        <td data-label="类型">
                          <span className="admin-log-table__cell">
                            <span className={`audit-chip audit-chip--${actionKind(log.action)}`}>
                              {actionLabel(log.action) ?? log.action}
                            </span>
                            {log.visibility !== 'public' ? (
                              <span className="admin-chip admin-chip--amber">内部</span>
                            ) : null}
                            {detail ? <span className="admin-log-table__detail">{detail}</span> : null}
                          </span>
                        </td>
                        <td data-label="管理员">
                          <span className="admin-log-table__cell">
                            {log.admin.username ?? log.admin.id}
                          </span>
                        </td>
                        <td data-label="当事人">
                          <span className="admin-log-table__cell">
                            {log.targetUser?.username ?? log.targetUser?.id ?? '—'}
                          </span>
                        </td>
                        <td data-label="对象">
                          <span className="admin-log-table__cell">
                            {objType ? <span>{objectTypeLabel(objType) ?? objType}</span> : null}
                            <ObjId oid={oid} />
                            {!objType && !oid ? <span>—</span> : null}
                          </span>
                        </td>
                        <td data-label="原因">
                          <span className="admin-log-table__cell admin-log-table__reason">
                            {log.reason ?? ''}
                          </span>
                        </td>
                        <td data-label="状态">
                          <span className="admin-log-table__cell">
                            {log.hasPendingAppeal ? (
                              <span className="admin-chip admin-chip--warning">申诉中</span>
                            ) : (
                              <span className="admin-chip admin-chip--muted">—</span>
                            )}
                          </span>
                        </td>
                        <td data-label="">
                          <Link className="admin-log-table__detail-link" href={`/audit/${log.id}`}>
                            详情
                          </Link>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}

        <AdminPager page={result.page} pages={result.pages} href={qs} />
      </div>
    </>
  );
}
