import { notFound, redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
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

  // 创建者才拉取每个选项的投票者名单（对齐 Flask get_vote 中 is_creator 分支的 opt.voters）
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

  // ── 创建者管理动作（server action，替代 Flask 的 fetch /vote/<id>/lock|unlock + DELETE）──
  async function lockVoteAction() {
    'use server';
    const me = await requireCoreUser();
    const v = await prisma.vote.findFirst({
      where: { id, ignore: false },
      select: { authorId: true },
    });
    if (!v || v.authorId !== me.id) return;
    await prisma.vote.update({ where: { id }, data: { isLocked: true } });
    revalidatePath(`/vote/${id}`);
  }

  async function unlockVoteAction() {
    'use server';
    const me = await requireCoreUser();
    const v = await prisma.vote.findFirst({
      where: { id, ignore: false },
      select: { authorId: true },
    });
    if (!v || v.authorId !== me.id) return;
    await prisma.vote.update({ where: { id }, data: { isLocked: false } });
    revalidatePath(`/vote/${id}`);
  }

  async function deleteVoteAction(): Promise<string | void> {
    'use server';
    const me = await requireCoreUser();
    const v = await prisma.vote.findFirst({
      where: { id, ignore: false },
      select: { authorId: true },
    });
    // 失败时返回错误信息，交由客户端以 alert('删除失败：…') 呈现（对齐 Flask deleteVote）
    if (!v || v.authorId !== me.id) return '未知错误';
    await prisma.vote.update({ where: { id }, data: { ignore: true } });
    redirect('/vote');
  }

  return (
    <main className="pwrap pwrap--narrow">
      <h1 className="ptitle">{vote.title}</h1>

      <VoteIdCopy voteId={vote.id} />

      <div
        className="vote-item__meta"
        style={{
          display: 'flex',
          gap: '1rem',
          flexWrap: 'wrap',
          alignItems: 'center',
          whiteSpace: 'normal',
          marginTop: 8,
        }}
      >
        <span>发起者：{vote.authorName}</span>
        <span>{ymd(vote.createdAt)}</span>
        {vote.isLocked && <span className="badge-danger">已锁定</span>}
        {vote.userVoted !== null && <span className="badge-success">已投票</span>}
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
        isCreator={vote.isCreator}
        isLocked={vote.isLocked}
        voterGroups={voterGroups}
        lockAction={lockVoteAction}
        unlockAction={unlockVoteAction}
        deleteAction={deleteVoteAction}
      />
    </main>
  );
}
