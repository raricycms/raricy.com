import Link from 'next/link';
import { Vote } from 'lucide-react';
import { requireCoreUser } from '@/lib/guard';
import { listVotes } from '@/lib/vote-service';
import { VoteRedirect, VoteCopyButton } from './VoteMenuClient';
import PageHeader from '@/app/components/PageHeader';

export const dynamic = 'force-dynamic';

export default async function VoteListPage() {
  const user = await requireCoreUser();
  const votes = await listVotes(user.id);

  return (
    <div className="container vote-list-page">
      <PageHeader
        title="投票箱"
        actions={
          <>
            <Link href="/vote/guide" className="page-header__action">使用指南</Link>
            <Link href="/vote/create" className="button button-primary">创建投票</Link>
          </>
        }
      />

      <div className="vote-access">
        <span className="vote-access__label">按 ID 打开投票</span>
        <VoteRedirect />
      </div>

      {votes.length > 0 ? (
        <div className="vote-list">
          {votes.map((v) => (
            <Link key={v.id} href={`/vote/${v.id}`} className="vote-item">
              <div className="vote-item__header">
                <span className="vote-item__header-title">{v.title}</span>
                <span className="vote-item__header-meta">
                  <span className="numeric">{v.optionCount}</span> 个选项 · <span className="numeric">{v.totalVotes}</span> 票
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
            <Vote />
          </div>
          <div className="vote-list__empty-text">还没有投票</div>
          <div className="vote-list__empty-subtext">点击「创建投票」开始。</div>
        </div>
      )}
    </div>
  );
}
