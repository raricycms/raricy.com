import Link from 'next/link';
import { Scale, Search, ScrollText } from 'lucide-react';
import { requireCoreUser } from '@/lib/guard';
import { listPublicLogs, PUBLIC_RANGE_DAYS } from '@/lib/audit-service';
import { prisma } from '@/lib/db';
import { ymdhms } from '@/lib/format';
import ObjId from '@/app/components/ObjId';
import AdminPageHeader from '@/app/components/AdminPageHeader';
import AdminEmpty from '@/app/components/AdminEmpty';
import AdminPager from '@/app/components/AdminPager';
import ExpandSelect, { type ExpandSelectGroup } from '@/app/components/ExpandSelect';
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
// 筛选走原生 GET 表单：控件是客户端 ExpandSelect（展开动画与博客目录同节奏），
// 值经隐藏 input 随表单提交 —— 不引入「一改就自动提交」的客户端筛选状态。
//
// ⚠️ 两条被 e2e 钉住的东西别动：查询参数名 `?action=`（audit-detail.spec 靠它把
// 结果集缩小到种子那几条）与每行的 `/audit/<id>` 详情链接。
//
// ⚠️ 时间窗上限是 30 天（listPublicLogs 的硬策略）—— 这里只提供「更近」两档，
// 想翻更早的走 /admin/logs。
//
// 「只看我相关的」是**服务端表单里的原生 checkbox**：AdminPick 是客户端组件（要
// onChange），这里没有交互层可用；样式由 _audit-logs.scss 的 .admin-filter-check
// 用 appearance:none 画成圆形指示器，但仍随 GET 表单一起提交（name="mine"）。
//
// 窄屏时表格按 data-label 折成卡片；行内「已撤回」只由状态 chip 表达，行本身
// 用 .log-row--reverted 压暗文字（revertedSet 是服务端按 accepted 申诉算出来的）。

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

// 与 /admin/logs 同一个形状：动作按 group 分块，其余为普通列表。
const ACTION_GROUPS: ExpandSelectGroup[] = [
  { options: [{ value: '', label: '全部动作' }] },
  ...GROUPS.map((group) => ({
    label: AUDIT_GROUP_LABEL[group],
    options: PUBLIC_AUDIT_ACTIONS.filter((action) => actionGroup(action) === group).map(
      (action) => ({ value: action, label: AUDIT_ACTION_LABEL[action] })
    ),
  })),
];

const TYPE_GROUPS: ExpandSelectGroup[] = [
  {
    options: [
      { value: '', label: '全部对象' },
      ...PUBLIC_AUDIT_OBJECT_TYPES.map((type) => ({
        value: type,
        label: objectTypeLabel(type) ?? type,
      })),
    ],
  },
];

const RANGE_GROUPS: ExpandSelectGroup[] = [
  {
    options: PUBLIC_RANGE_DAYS.map((days) => ({
      value: String(days),
      label: `近 ${days} 天`,
    })),
  },
];

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
      <AdminPageHeader
        eyebrow={
          <>
            <Scale aria-hidden="true" />
            管理 · 公示
          </>
        }
        title="管理员操作公示"
        subtitle="站内管理动作的公开记录（近 30 天）· 被处置者可在此申诉"
      />

      <div className="admin-container">
        <form method="GET" className="admin-filter-bar audit-filter-bar">
          <div className="admin-filter__primary">
            <label className="admin-search">
              <span className="admin-search__icon" aria-hidden="true">
                <Search />
              </span>
              <input
                type="search"
                name="q"
                className="admin-search__input"
                placeholder="搜索原因 / 对象 ID…"
                aria-label="按原因或对象 ID 搜索"
                defaultValue={sp.q ?? ''}
              />
            </label>

            <label className="admin-filter-check">
              <input type="checkbox" name="mine" value="1" defaultChecked={Boolean(sp.mine)} />
              只看我相关的
            </label>

            <button type="submit" className="btn btn-primary">
              筛选
            </button>
            {hasFilter && (
              <Link href="/audit" className="btn btn-secondary">
                清除
              </Link>
            )}

            <span className="admin-filter__total">
              <span className="numeric">{result.total}</span> 条
            </span>
          </div>

          <div className="admin-filter__grid">
            <div className="admin-field">
              <label className="admin-field__label" htmlFor="audit-action">
                动作
              </label>
              <ExpandSelect
                id="audit-action"
                name="action"
                className="admin-field__control"
                defaultValue={sp.action ?? ''}
                groups={ACTION_GROUPS}
              />
            </div>

            <div className="admin-field">
              <label className="admin-field__label" htmlFor="audit-type">
                对象类型
              </label>
              <ExpandSelect
                id="audit-type"
                name="type"
                className="admin-field__control"
                defaultValue={sp.type ?? ''}
                groups={TYPE_GROUPS}
              />
            </div>

            <div className="admin-field">
              <label className="admin-field__label" htmlFor="audit-target">
                当事人
              </label>
              <input
                id="audit-target"
                type="search"
                name="target"
                className="form-control admin-field__control"
                placeholder="当事人用户名…"
                defaultValue={sp.target ?? ''}
              />
            </div>

            <div className="admin-field">
              <label className="admin-field__label" htmlFor="audit-range">
                时间范围
              </label>
              <ExpandSelect
                id="audit-range"
                name="range"
                className="admin-field__control numeric"
                defaultValue={String(rangeDays)}
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
            {/* data-label 是窄屏折卡的唯一依据（见 _common.scss 的 .admin-table 规则）。 */}
            <div className="admin-table-scroll">
              <table className="admin-table admin-log-table">
                <thead>
                  <tr>
                    <th scope="col">时间</th>
                    <th scope="col">类型</th>
                    <th scope="col">管理员</th>
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
                    const reverted = revertedSet.has(log.id);
                    const detail = formatActionDetail(log.action, log.extra);
                    return (
                      <tr key={log.id} className={reverted ? 'log-row--reverted' : undefined}>
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
                            {detail ? <span className="admin-log-table__detail">{detail}</span> : null}
                          </span>
                        </td>
                        <td data-label="管理员">
                          <span className="admin-log-table__cell">
                            {log.admin.username ?? log.admin.id}
                          </span>
                        </td>
                        <td data-label="对象">
                          <span className="admin-log-table__cell">
                            {objType === 'blog' ? (
                              <>
                                <span>文章</span>
                                <ObjId oid={oid} />
                              </>
                            ) : objType === 'comment' ? (
                              <>
                                <span>评论</span>
                                <ObjId oid={oid} />
                                {log.targetHidden ? (
                                  <span className="admin-log-table__detail">（匿名评论，作者不公开）</span>
                                ) : null}
                              </>
                            ) : objType === 'user' ? (
                              <span>用户 {log.targetUser?.username ?? log.targetUser?.id ?? '—'}</span>
                            ) : objType || oid ? (
                              <>
                                <span>{objectTypeLabel(objType ?? '') ?? objType}</span>
                                <ObjId oid={oid} />
                              </>
                            ) : (
                              <span>—</span>
                            )}
                          </span>
                        </td>
                        <td data-label="原因">
                          <span className="admin-log-table__cell admin-log-table__reason">
                            {log.reason ?? ''}
                          </span>
                        </td>
                        <td data-label="状态">
                          <span className="admin-log-table__cell">
                            {reverted ? (
                              <span className="admin-chip admin-chip--success">已撤回</span>
                            ) : log.hasPendingAppeal ? (
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
