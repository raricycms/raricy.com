import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Scale } from 'lucide-react';
import { requireCoreUser } from '@/lib/guard';
import { getLogDetail } from '@/lib/audit-service';
import { actionKind, actionLabel } from '@/lib/audit-actions';
import { isOwner } from '@/lib/auth';
import { ymdhms } from '@/lib/format';
import AdminPageHeader from '@/app/components/AdminPageHeader';
import AppealForm from './AppealForm';

// 操作详情页。
//
// 这个页面此前**不存在**：/audit 列表里每行的「详情」链接都指向它，全部 404；
// 更要紧的是提交申诉的 API（/api/audit/[id]/appeal）因此成了孤儿 —— 用户根本
// 没有入口申诉。
//
// 「通过/驳回」按钮不在这里重复实现：/admin/appeals 已有专门的审批页
// （含批量、筛选），这里只给入口，避免同一操作两处维护。
// 该入口仅对站长显示 —— 审批是站长专属，给管理员看这条提示只会把他们送去一个 403 页面。
//
// 版面与 /audit 列表同源：抬头 -> .admin-container -> .admin-panel。⚠️ 这里**不再**用
// 通用 .container：它自带 16px 内距，与本页外壳的 20px 檐沟叠加后，抬头会比列表页
// 向右多缩 16px、内容列也更窄（两页之间来回跳会明显错位）。
//
// ⚠️ 三条被 e2e 钉住、别动（tests/e2e/audit-detail.spec.ts 与 dark-theme.spec.ts）：
//   · 页面上**恰好一个** h2，文案是「操作详情」；
//   · 第一块 `.card` 里要能看到动作码（机器码 `delete_comment` 这类）与原因；
//   · `.list-group-item` 在无申诉时整条文案就是「暂无申诉」（深色主题用例按它断言
//     底色与文字色）。
// 机器码也保留显示：读日志的人要按码搜，e2e 也靠它断言。

export const dynamic = 'force-dynamic';

const STATUS_LABEL: Record<string, string> = {
  pending: '待处理',
  accepted: '已通过',
  rejected: '已驳回',
};

export default async function AuditLogDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  // layout 已鉴权；这里再判一次做纵深防御（对齐列表页的做法）
  const user = await requireCoreUser();
  const { id } = await params;

  const logId = Number.parseInt(id, 10);
  if (!Number.isInteger(logId) || logId <= 0) notFound();

  const log = await getLogDetail(logId);
  if (!log) notFound();

  const owner = isOwner(user);
  const hasPendingAppeal = log.appeals.some((a) => a.status === 'pending');

  return (
    <>
      <AdminPageHeader
        eyebrow={
          <>
            <Scale aria-hidden="true" />
            管理 · 公示
          </>
        }
        title="操作记录"
        subtitle="管理动作的公示详情 · 被处置者可在此提交申诉"
        actions={
          <Link href="/audit" className="btn btn-secondary">
            返回日志
          </Link>
        }
      />

      <div className="admin-container">
        <section className="admin-panel" aria-label="操作详情">
          <div className="admin-section-head">
            {/* h2 是 e2e 的锚点（文案固定「操作详情」），别换层级。 */}
            <h2 className="admin-section-title">操作详情</h2>
            <span className={`audit-chip audit-chip--${actionKind(log.action)}`}>
              {actionLabel(log.action) ?? log.action}
            </span>
          </div>

          <div className="card audit-detail-card">
            <dl className="audit-detail-list">
              <div className="audit-detail-item">
                <dt>类型</dt>
                <dd>
                  {/* 原始机器码一起显示：读日志的人要按码搜，e2e 也靠它断言。 */}
                  <code>{log.action}</code>
                </dd>
              </div>
              <div className="audit-detail-item">
                <dt>时间</dt>
                <dd className="numeric">{ymdhms(log.createdAt) ?? '—'}</dd>
              </div>
              <div className="audit-detail-item">
                <dt>管理员</dt>
                <dd>{log.adminName ?? log.adminId ?? '—'}</dd>
              </div>
              <div className="audit-detail-item">
                <dt>对象</dt>
                <dd>
                  {log.objectType ?? '—'}
                  {log.objectId ? (
                    <>
                      {' '}
                      <code>{log.objectId}</code>
                    </>
                  ) : null}
                </dd>
              </div>
              <div className="audit-detail-item">
                <dt>目标用户</dt>
                <dd>
                  {log.targetHidden
                    ? '（匿名评论，作者不公开）'
                    : (log.targetUserName ?? log.targetUserId ?? '—')}
                </dd>
              </div>
              <div className="audit-detail-item">
                <dt>原因</dt>
                <dd>{log.reason || '—'}</dd>
              </div>
            </dl>
          </div>
        </section>

        <section className="admin-panel" aria-label="相关申诉">
          <div className="admin-section-head">
            <h3 className="admin-section-title">相关申诉</h3>
            <span className="admin-section-count">
              <span className="numeric">{log.appeals.length}</span> 条
            </span>
          </div>

          <ul className="list-group audit-appeal-list">
            {log.appeals.length === 0 ? (
              /* ⚠️ 整条文案必须**恰好**是「暂无申诉」：dark-theme.spec 用
                 toHaveText 断言它的底色与文字色。 */
              <li className="list-group-item">暂无申诉</li>
            ) : (
              log.appeals.map((a) => (
                <li className="list-group-item" key={a.id}>
                  <div className="audit-appeal__head">
                    {/* 隐藏日志（匿名评论）上申诉人就是当事人 —— 服务端已把 id 与名字抹成 null
                        （见 audit-service.getLogDetail 的 ★），这里顺势不点真名。
                        判据用 log.targetHidden：申诉只能由当事人本人提起（createAppeal 强制），
                        所以「有隐藏日志 ⇒ 申诉人 === 当事人」。 */}
                    <strong>
                      {log.targetHidden
                        ? '当事人（匿名评论，身份不公开）'
                        : (a.appellantName ?? a.appellantId)}
                    </strong>
                    <span
                      className={
                        a.status === 'pending'
                          ? 'status-badge status-badge--pending'
                          : a.status === 'accepted'
                            ? 'status-badge status-badge--reverted'
                            : 'status-badge'
                      }
                    >
                      {STATUS_LABEL[a.status] ?? a.status}
                    </span>
                  </div>
                  <div className="audit-appeal__content">{a.content}</div>
                  {a.status !== 'pending' && a.decision ? (
                    <div className="audit-appeal__note">处理说明：{a.decision}</div>
                  ) : null}
                  <small className="audit-appeal__time numeric">
                    {ymdhms(a.createdAt) ?? ''}
                  </small>
                </li>
              ))
            )}
          </ul>
        </section>

        {/* 审批仅站长 —— 给管理员看这条提示会把他们送去一个 403 的页面 */}
        {owner && hasPendingAppeal ? (
          <div className="alert alert-info audit-owner-hint">
            有待处理的申诉 —— 去 <Link href="/admin/appeals">申诉管理</Link> 审批。
          </div>
        ) : null}

        <section className="admin-panel" aria-label="提交申诉">
          <AppealForm logId={log.id} />
        </section>
      </div>
    </>
  );
}
