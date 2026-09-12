import type { Metadata } from 'next';
import { forbidden, notFound } from 'next/navigation';
import { requireCoreUser } from '@/lib/guard';
import { getCurrentUser, isOwner } from '@/lib/auth';
import { getClip } from '@/lib/clipboard-service';
import UploadForm from '../../upload/UploadForm';

export const dynamic = 'force-dynamic';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  const user = await getCurrentUser();
  const result = await getClip(id, user?.id, isOwner(user));
  const title = result.ok
    ? `${result.clip.title} 文章编辑 - Raricy.com`
    : '文章编辑 - Raricy.com';
  return { title };
}

// 编辑云剪贴板
export default async function ClipEditPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requireCoreUser();
  const { id } = await params;
  const user = await getCurrentUser();
  const result = await getClip(id, user?.id, isOwner(user));

  if (!result.ok) {
    if (result.reason === 'forbidden') forbidden();
    notFound();
  }

  const { clip } = result;

  if (!user || user.id !== clip.authorId) forbidden();

  return (
    <div className="clipboard-page">
      <UploadForm
        clip={{
          id: clip.id,
          title: clip.title,
          content: clip.content ?? '',
          publicity: clip.publicity,
        }}
      />
    </div>
  );
}