import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireCoreUser } from '@/lib/guard';
import { getLogDetail } from '@/lib/audit-service';
import { isOwner } from '@/lib/auth';
import { ymdhms } from '@/lib/format';
import AppealForm from './AppealForm';

// 操作详情页（对齐 Flask audit.log_detail / admin_action_log_detail.html）。
//
// 这个页面此前**不存在**：/audit 列表里每行的「详情」链接都指向它，全部 404；
// 更要紧的是提交申诉的 API（/api/audit/[id]/appeal）因此成了孤儿 —— 用户根本
// 没有入口申诉，而 Flask 里是可以的。
//
// 与 Flask 的一处差异：「通过/驳回」按钮不在这里重复实现。Next 侧已有专门的
// /admin/appeals 审批页（含批量、筛选），这里只给入口，避免同一操作两处维护。
// 该入口仅对站长显示 —— 审批是站长专属（对齐 Flask decide_appeal 的
// @owner_required），给管理员看这条提示只会把他们送去一个 403 页面。

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

  return (
    <div className="container">
      <div className="d-flex justify-content-between align-items-center mb-3">
        <h2 className="mb-0">操作详情</h2>
        <Link href="/audit" className="btn btn-outline-secondary btn-sm">
          返回日志
        </Link>
      </div>

      <div className="card p-3 mb-3">
        <div>
          类型：<span className="log-row__type">{log.action}</span>
        </div>
        <div>时间：{ymdhms(log.createdAt) ?? '—'}</div>
        <div>管理员：{log.adminName ?? log.adminId ?? '—'}</div>
        <div>
          对象：{log.objectType ?? '—'}{' '}
          {log.objectId ? <code>{log.objectId}</code> : null}
        </div>
        <div>目标用户：{log.targetUserName ?? log.targetUserId ?? '—'}</div>
        <div>原因：{log.reason || '—'}</div>
      </div>

      <h4 className="mb-2">相关申诉</h4>
      <ul className="list-group mb-3">
        {log.appeals.length === 0 ? (
          <li className="list-group-item">暂无申诉</li>
        ) : (
          log.appeals.map((a) => (
            <li className="list-group-item" key={a.id}>
              <div className="d-flex justify-content-between align-items-center">
                <strong>{a.appellantName ?? a.appellantId}</strong>
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
              <div className="mt-1" style={{ whiteSpace: 'pre-wrap' }}>
                {a.content}
              </div>
              {a.status !== 'pending' && a.decision ? (
                <div className="mt-1 text-muted">处理说明：{a.decision}</div>
              ) : null}
              <small className="text-muted">{ymdhms(a.createdAt) ?? ''}</small>
            </li>
          ))
        )}
      </ul>

      {/* 审批仅站长 —— 给管理员看这条提示会把他们送去一个 403 的页面 */}
      {owner && log.appeals.some((a) => a.status === 'pending') ? (
        <div className="alert alert-info mb-3">
          有待处理的申诉 —— 去 <Link href="/admin/appeals">申诉管理</Link> 审批。
        </div>
      ) : null}

      <AppealForm logId={log.id} />
    </div>
  );
}
