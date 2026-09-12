'use client';

// ─────────────────────────────────────────────────────────────────────────────
// VoteEmbed — 投票交互组件（对齐 Flask app/templates/vote/detail.html）
//   • 未投票且未锁定：展示可选项，点击选择 → 提交
//   • 已投票 / 已锁定：展示结果（顶部"共 X 票" + 计数/百分比条），高亮已投项
//
// 同文件另导出两个客户端小组件（复制 ID、创建者管理控制），供 vote/[id]/page.tsx
// 组装成与 Flask 逐项对齐的详情页交互。
// ─────────────────────────────────────────────────────────────────────────────

import { useState } from 'react';
import { useRouter } from 'next/navigation';

interface OptionData {
  id: number;
  label: string;
  count: number;
  percentage: number;
}

interface Props {
  voteId: string;
  isLocked: boolean;
  loggedIn: boolean;
  initialUserVoted: number | null;
  initialTotal: number;
  initialOptions: OptionData[];
}

export default function VoteEmbed({
  voteId,
  isLocked,
  initialUserVoted,
  initialTotal,
  initialOptions,
}: Props) {
  const router = useRouter();
  const [options, setOptions] = useState<OptionData[]>(initialOptions);
  const [total, setTotal] = useState(initialTotal);
  const [userVoted, setUserVoted] = useState<number | null>(initialUserVoted);
  const [selected, setSelected] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);

  const showResults = userVoted !== null || isLocked;

  async function submit() {
    if (selected == null) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/votes/${voteId}/vote`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ optionId: selected }),
      });
      const data = await res.json();
      if (data.code === 200) {
        // 乐观更新本地结果并切到结果视图（Flask 原站是 location.reload()，此处等价切换）
        const nextOptions = options.map((o) =>
          o.id === selected ? { ...o, count: o.count + 1 } : o
        );
        const nextTotal = total + 1;
        setOptions(
          nextOptions.map((o) => ({
            ...o,
            percentage: nextTotal > 0 ? Math.round((o.count / nextTotal) * 1000) / 10 : 0,
          }))
        );
        setTotal(nextTotal);
        setUserVoted(selected);
        // 刷新服务端组件，让顶部 meta"已投票"绿色徽章出现（对齐 Flask location.reload()）
        router.refresh();
      } else {
        alert('投票失败：' + (data.message || '未知错误'));
      }
    } catch (err) {
      console.error(err);
      alert('出错了，请稍后再试');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="vote-embed-widget">
      {isLocked && <span className="vote-embed-badge badge-locked">已锁定</span>}
      {showResults && <p className="vote-embed-total">共 {total} 票</p>}

      {options.map((o) => {
        const isMine = userVoted === o.id;
        const isChosen = selected === o.id;

        if (showResults) {
          return (
            <div
              key={o.id}
              className={`vote-embed-option vote-embed-option--result${
                isMine ? ' vote-embed-option--voted' : ''
              }`}
            >
              <div className="vote-embed-bar" style={{ width: `${o.percentage}%` }} />
              <div className="vote-embed-option-content">
                <span className="vote-embed-option-label">{o.label}</span>
                <span className="vote-embed-option-stats">
                  {o.count} 票 · {o.percentage}%
                </span>
              </div>
            </div>
          );
        }

        return (
          <button
            key={o.id}
            type="button"
            onClick={() => setSelected(o.id)}
            className={`vote-embed-option${isChosen ? ' vote-embed-option--selected' : ''}`}
          >
            <div className="vote-embed-option-content">
              <span className="vote-embed-option-label">{o.label}</span>
            </div>
          </button>
        );
      })}

      {!showResults && (
        <button
          type="button"
          onClick={submit}
          disabled={loading || selected == null}
          className="vote-embed-submit"
        >
          {loading ? '投票中……' : '投票'}
        </button>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// VoteIdCopy — ID 行 + 复制按钮（对齐 Flask copyVoteId：写剪贴板 →"已复制" 1.5s 回退）
// ─────────────────────────────────────────────────────────────────────────────
export function VoteIdCopy({ voteId }: { voteId: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(voteId);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      } else {
        alert('投票ID：' + voteId);
      }
    } catch {
      alert('复制失败，请手动复制：' + voteId);
    }
  }

  return (
    <div className="vote-item__id" style={{ marginTop: 12 }}>
      <span>ID：</span>
      <code>{voteId}</code>
      <button type="button" className="vote-item__copy-btn" onClick={copy}>
        {copied ? '已复制' : '复制'}
      </button>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// VoteDetailControls — 底部操作区（对齐 Flask vote-detail__actions / voters）
//   • 所有人：返回上页
//   • 创建者：锁定/解锁、删除，以及"查看详细投票情况"折叠
// 管理动作通过传入的 server action 执行（锁定/解锁/删除），成功后刷新或跳转。
// ─────────────────────────────────────────────────────────────────────────────
interface VoterGroup {
  label: string;
  count: number;
  voters: string[];
}

interface ControlsProps {
  isCreator: boolean;
  isLocked: boolean;
  voterGroups: VoterGroup[];
  lockAction: () => Promise<void>;
  unlockAction: () => Promise<void>;
  deleteAction: () => Promise<string | void>;
}

export function VoteDetailControls({
  isCreator,
  isLocked,
  voterGroups,
  lockAction,
  unlockAction,
  deleteAction,
}: ControlsProps) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [showVoters, setShowVoters] = useState(false);

  async function run(
    fn: () => Promise<string | void>,
    confirmMsg: string,
    errPrefix?: string
  ) {
    if (!confirm(confirmMsg)) return;
    setBusy(true);
    try {
      const err = await fn();
      // 失败时（server action 返回错误信息）以原生 alert 呈现，对齐 Flask deleteVote
      if (err && errPrefix) {
        alert(errPrefix + err);
        return;
      }
      router.refresh();
    } catch {
      // server action 内的 redirect 会以异常形式向上冒泡完成跳转，这里无需处理
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="btn-row">
        <button
          type="button"
          className="btn btn--ghost"
          onClick={() => history.back()}
          disabled={busy}
        >
          返回上页
        </button>

        {isCreator &&
          (isLocked ? (
            <button
              type="button"
              className="btn btn--ghost"
              disabled={busy}
              onClick={() => run(unlockAction, '确定要解锁此投票吗？')}
            >
              解锁投票
            </button>
          ) : (
            <button
              type="button"
              className="btn btn--ghost"
              disabled={busy}
              onClick={() =>
                run(lockAction, '确定要锁定此投票吗？锁定后所有人都不能投票，但可以看到结果。')
              }
            >
              锁定投票
            </button>
          ))}

        {isCreator && (
          <button
            type="button"
            className="btn btn--danger-soft"
            disabled={busy}
            onClick={() => run(deleteAction, '确定要删除此投票吗？此操作不可恢复。', '删除失败：')}
          >
            删除投票
          </button>
        )}
      </div>

      {isCreator && (
        <div style={{ marginTop: '1rem' }}>
          <button
            type="button"
            className="btn btn--quiet"
            onClick={() => setShowVoters((v) => !v)}
          >
            {showVoters ? '收起详细投票情况' : '查看详细投票情况'}
          </button>
          {showVoters && (
            <div
              style={{ marginTop: '0.75rem', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}
            >
              {voterGroups.map((g, i) => (
                <div key={i} style={{ fontSize: '0.875rem', color: 'var(--color-text-secondary)' }}>
                  <strong style={{ color: 'var(--color-text-primary)' }}>{g.label}</strong>（{g.count} 票）：
                  {g.voters.length > 0 ? g.voters.join('、') : '暂无投票'}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </>
  );
}