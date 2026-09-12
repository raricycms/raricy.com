import { requireCoreUser } from '@/lib/guard';
import { forbidden, notFound } from 'next/navigation';
import { getCurrentUser, isOwner } from '@/lib/auth';
import { getClip } from '@/lib/clipboard-service';
import {
  ClipIdCopyButton,
  ClipActions,
  ClipContent,
  FooterCopyright,
} from './ClipDetailClient';

export const dynamic = 'force-dynamic';

// 云剪贴板详情页
export default async function ClipDetailPage({ params }: { params: Promise<{ id: string }> }) {
  await requireCoreUser();
  const { id } = await params;
  const user = await getCurrentUser();
  const result = await getClip(id, user?.id, isOwner(user));

  if (!result.ok) {
    if (result.reason === 'forbidden') forbidden();
    notFound();
  }

  const { clip } = result;
  const isAuthor = !!user && user.id === clip.authorId;
  const canDelete = isAuthor || isOwner(user);

  return (
    <div className="clipboard-detail">
      <div className="clipboard-detail__header">
        <h1 className="clipboard-detail__header-title">{clip.title}</h1>
        <div className="clipboard-detail__header-meta">
          <span>作者：{clip.authorName ?? '未知作者'}</span>
          <span className="clipboard-detail__header-meta-id">
            ID：<code>{clip.id}</code>
            <ClipIdCopyButton text={clip.id} />
          </span>
        </div>
      </div>

      <div className="clipboard-detail__content">
        <ClipContent content={clip.content ?? ''} />
      </div>

      <ClipActions
        clipId={clip.id}
        content={clip.content ?? ''}
        isAuthor={isAuthor}
        canDelete={canDelete}
      />

      <FooterCopyright
        text={`原作者：${clip.authorName ?? '未知作者'} | 版权归原作者所有`}
      />
    </div>
  );
}