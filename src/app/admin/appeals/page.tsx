import type { CSSProperties } from 'react';
import Link from 'next/link';
import { Check, Clock, Scale, X, type LucideIcon } from 'lucide-react';
import { listAppeals } from '@/lib/admin-appeal-service';
import { actionLabel } from '@/lib/audit-actions';
import AdminAppealActions from '@/app/components/AdminAppealActions';
import AdminEmpty from '@/app/components/AdminEmpty';
import AdminPageHeader from '@/app/components/AdminPageHeader';
import AdminPager from '@/app/components/AdminPager';

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

// 状态徽标：语义色只借「等待 / 成功」两档，驳回不额外上色（它不该比待处理更抢眼）。
// 三档都走 .admin-chip 的共享底色，颜色随 [data-theme] 切换。
const STATUS_CHIP: Record<string, { cls: string; icon: LucideIcon }> = {
  pending: { cls: 'admin-chip--amber', icon: Clock },
  accepted: { cls: 'admin-chip--success', icon: Check },
  rejected: { cls: '', icon: X },
};

// 状态筛选：'': 全部。顺序固定，与徽标的语义顺序一致。
const STATUS_FILTERS: Array<{ value: string; label: string }> = [
  { value: '', label: '全部' },
  { value: 'pending', label: '待处理' },
  { value: 'accepted', label: '已通过' },
  { value: 'rejected', label: '已驳回' },
];

function fmt(iso: string | null): string {
  if (!iso) return '';
  return iso.slice(0, 19).replace('T', ' ');
}

// 申诉管理
//
// 只读列表 + 逐条裁决（裁决动作在 AdminAppealActions 里，通过 / 驳回各走 POST）。
// 页面本身不判门禁：/admin/appeals 有独立的 layout.tsx，那里是 requireOwner()。
//
// 版式沿用管理面板新语言：抬头 AdminPageHeader、状态筛选是 .admin-seg 切页档胶囊、
// 每条申诉是一张 .admin-appeal 卡（正文再压深一档成内容底色，圆角 16），
// 分页走共用的 AdminPager。原先前端渲染「全部页码」的内联分页一并换掉。
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

  const current = sp.status ?? '';

  return (
    <>
      <AdminPageHeader
        eyebrow={
          <>
            <Scale aria-hidden="true" />
            审核
          </>
        }
        title="操作申诉"
        subtitle={
          <>
            共 <span className="numeric">{result.total}</span> 条申诉 ·
            通过申诉时会尝试自动撤回原动作（禁言可自动解除）
          </>
        }
      />

      <div className="admin-container">
        {/* 状态筛选：N 选 1 的切页档。窄屏允许横向滚动（滚动条隐藏），
            各档按钮本身也能换行，不会把页面撑宽。 */}
        <div className="admin-appeal-filters">
          <div className="admin-seg" role="group" aria-label="按申诉状态筛选">
            {STATUS_FILTERS.map((f) => {
              const active = current === f.value;
              return (
                <Link
                  key={f.value || 'all'}
                  href={qs(1, f.value)}
                  className={`admin-seg__btn${active ? ' is-active' : ''}`}
                  aria-current={active ? 'page' : undefined}
                >
                  {f.label}
                </Link>
              );
            })}
          </div>
        </div>

        {result.items.length === 0 ? (
          <AdminEmpty
            icon={Scale}
            title="暂无申诉"
            description={current ? '当前状态下没有申诉记录，可以切到「全部」。' : undefined}
          />
        ) : (
          result.items.map((a, i) => {
            const chip = STATUS_CHIP[a.status];
            const StatusIcon = chip?.icon ?? Scale;
            return (
              <article
                key={a.id}
                className="admin-appeal"
                style={{ '--i': i } as CSSProperties}
              >
                <div className="admin-appeal__head">
                  <div className="admin-appeal__chips">
                    <span className={`admin-chip ${chip?.cls ?? ''}`.trim()}>
                      <StatusIcon aria-hidden="true" />
                      {STATUS_LABELS[a.status] ?? a.status}
                    </span>
                  </div>

                  <div className="admin-appeal__meta">
                    <span>申诉人：{a.appellant.username ?? a.appellant.id}</span>
                    <span>
                      针对：
                      {a.log
                        ? `${actionLabel(a.log.action) ?? a.log.action}` +
                          (a.log.targetUser
                            ? ` → ${a.log.targetUser.username ?? a.log.targetUser.id}`
                            : '')
                        : '（日志已不存在）'}
                    </span>
                    <span className="numeric">{fmt(a.createdAt)}</span>
                  </div>
                </div>

                <p className="admin-appeal__content">{a.content}</p>

                {a.log?.reason && (
                  <p className="admin-appeal__note">原操作理由：{a.log.reason}</p>
                )}

                {a.status === 'pending' ? (
                  <div className="admin-appeal__actions">
                    <AdminAppealActions appealId={a.id} />
                  </div>
                ) : (
                  <p className="admin-appeal__decision">
                    裁决：{a.decision || '（无批注）'}
                    {a.decider ? ` · 由 ${a.decider.username ?? a.decider.id}` : ''}
                    <span className="numeric">
                      {a.decidedAt ? ` · ${fmt(a.decidedAt)}` : ''}
                    </span>
                  </p>
                )}
              </article>
            );
          })
        )}

        <AdminPager page={result.page} pages={result.pages} href={qs} />
      </div>
    </>
  );
}
