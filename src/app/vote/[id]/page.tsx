import { notFound } from 'next/navigation';
import { requireCoreUser } from '@/lib/guard';
import { getVoteDetail } from '@/lib/vote-service';
import { getCurrentUser } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { ymd } from '@/lib/format';
import VoteEmbed, { VoteIdCopy, VoteDetailControls } from '@/app/components/VoteEmbed';

export const dynamic = 'force-dynamic';

export default async function VoteDetailPage({ params }: { params: Promise<{ id: string }> }) {
  await requireCoreUser();
  const { id } = await params;
  const user = await getCurrentUser();
  const vote = await getVoteDetail(id, user?.id ?? null);
  if (!vote) notFound();

  // 创建者才拉取每个选项的投票者名单（voters 只对创建者下发）
  let voterGroups: { label: string; count: number; voters: string[] }[] = [];
  if (vote.isCreator) {
    const records = await prisma.voteRecord.findMany({
      where: { voteId: id },
      orderBy: { createdAt: 'asc' },
      select: { optionId: true, user: { select: { username: true } } },
    });
    const byOption = new Map<number, string[]>();
    for (const r of records) {
      if (!r.user?.username) continue;
      const list = byOption.get(r.optionId) ?? [];
      list.push(r.user.username);
      byOption.set(r.optionId, list);
    }
    voterGroups = vote.options.map((o) => ({
      label: o.label,
      count: o.count,
      voters: byOption.get(o.id) ?? [],
    }));
  }

  // ── 创建者管理动作（锁定 / 解锁 / 删除）──
  // 这三件事**不在这里实现**：它们走 `/api/votes/:id` 的 PATCH / DELETE，由下面的
  // VoteDetailControls 直接 fetch。此前它们是本页的三个 server action，而 server action
  // 站外调不动 —— 结果是机器人建得了投票、却锁不了也删不掉（改由接口承载后这条缺口才平）。
  // 逻辑在 `src/lib/vote-service.ts` 的 setVoteLocked / softDeleteVote，页面不再自己摸
  // 写路径。（上面那三个 server action 删掉了，`revalidatePath` / `redirect` 也随之不再需要。）

  return (
    <div className="vote-page">
      <h1 className="vote-title">{vote.title}</h1>

      <VoteIdCopy voteId={vote.id} />

      <div
        style={{ whiteSpace: 'normal', marginTop: '0.75rem', display: 'flex', flexWrap: 'wrap', gap: '0.75rem', alignItems: 'center' }}
      >
        <span style={{ color: 'var(--color-text-secondary)' }}>
          发起者：{vote.authorName}
        </span>
        <span style={{ color: 'var(--color-text-secondary)' }}>
          {ymd(vote.createdAt)}
        </span>
        {vote.isLocked && (
          <span className="vote-embed-badge badge-locked">已锁定</span>
        )}
        {vote.userVoted !== null && (
          <span className="vote-embed-badge" style={{ background: 'var(--color-success-secondary)', color: 'var(--color-success-primary)' }}>已投票</span>
        )}
      </div>

      <VoteEmbed
        voteId={vote.id}
        isLocked={vote.isLocked}
        loggedIn={!!user}
        initialUserVoted={vote.userVoted}
        initialTotal={vote.totalVotes}
        initialOptions={vote.options}
      />

      <VoteDetailControls
        voteId={vote.id}
        isCreator={vote.isCreator}
        isLocked={vote.isLocked}
        voterGroups={voterGroups}
      />
    </div>
  );
}
