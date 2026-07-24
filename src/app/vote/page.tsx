import Link from 'next/link';
import { requireCoreUser } from '@/lib/guard';
import { listVotes } from '@/lib/vote-service';
import { VoteRedirect, VoteCopyButton } from './VoteMenuClient';

export const dynamic = 'force-dynamic';

export default async function VoteListPage() {
  await requireCoreUser();
  const votes = await listVotes();

  return (
    <div className="vote-page">
      <h1 className="vote-title">投票箱</h1>

      <div className="vote-navigation">
        <VoteRedirect />
        <div className="vote-navigation__actions">
          <Link href="/vote/create" className="action-button primary">
            创建投票
          </Link>
        </div>
      </div>

      {votes.length > 0 ? (
        <div className="vote-list">
          {votes.map((v) => (
            <Link key={v.id} href={`/vote/${v.id}`} className="vote-item">
              <div className="vote-item__header">
                <span className="vote-item__header-title">{v.title}</span>
                <span className="vote-item__header-meta">
                  {v.optionCount} 个选项 · {v.totalVotes} 票
                  {v.isLocked && (
                    <span
                      className="vote-item__header-locked"
                      style={{ marginLeft: '0.5rem' }}
                    >
                      已锁定
                    </span>
                  )}
                </span>
              </div>
              <div className="vote-item__id">
                <code>{v.id}</code>
                <VoteCopyButton id={v.id} />
              </div>
            </Link>
          ))}
        </div>
      ) : (
        <div className="vote-list__empty">
          <div className="vote-list__empty-icon" aria-hidden="true">
            🗳️
          </div>
          <div className="vote-list__empty-text">还没有投票</div>
          <div className="vote-list__empty-subtext">点击上方按钮创建你的第一个投票。</div>
        </div>
      )}
    </div>
  );
}