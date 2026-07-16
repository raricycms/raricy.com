import Link from 'next/link';
import { requireCoreUser } from '@/lib/guard';
import { listVotes } from '@/lib/vote-service';
import { VoteRedirect, VoteCopyButton } from './VoteMenuClient';

export const dynamic = 'force-dynamic'; // 列表随投票状态变化，禁用静态化

export default async function VoteListPage() {
  await requireCoreUser();
  const votes = await listVotes();

  return (
    <div className="pwrap">
      <h1 className="ptitle" style={{ margin: 0 }}>
        投票箱
      </h1>

      <div className="item-toolbar">
        <VoteRedirect />
        <Link href="/vote/create" className="upload-button">
          <span className="icon icon-add"></span>创建投票
        </Link>
      </div>

      {votes.length > 0 ? (
        <div className="vote-list">
          {votes.map((v) => (
            <Link key={v.id} href={`/vote/${v.id}`} className="card card--link vote-item">
              <div className="vote-item__header">
                <span className="vote-item__title">{v.title}</span>
                <span className="vote-item__meta">
                  {v.optionCount} 个选项 · {v.totalVotes} 票
                  {v.isLocked && <span className="vote-locked">已锁定</span>}
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
        <div className="empty-state">
          <div className="empty-state-icon">
            <span
              className="icon icon-grid"
              style={{ width: '2.4rem', height: '2.4rem', display: 'inline-block' }}
            ></span>
          </div>
          <h3>还没有投票</h3>
          <p>点击上方按钮创建你的第一个投票。</p>
        </div>
      )}
    </div>
  );
}
