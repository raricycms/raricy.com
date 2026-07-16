import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireCoreUser } from '@/lib/guard';
import { getCurrentUser } from '@/lib/auth';
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
  const result = await getClip(id, user?.id);
  const title = result.ok
    ? `${result.clip.title} 文章编辑 - Raricy.com`
    : '文章编辑 - Raricy.com';
  return { title };
}

export default async function ClipEditPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requireCoreUser();
  const { id } = await params;
  const user = await getCurrentUser();
  const result = await getClip(id, user?.id);

  // 对齐 Flask edit_page：不存在 → 404。
  if (!result.ok) notFound();

  const { clip } = result;

  // 对齐 Flask edit_page：非作者 → 拒绝编辑。
  if (!user || user.id !== clip.authorId) {
    return (
      <div className="clipboard-page">
        <h1 className="clipboard-title">无权编辑</h1>
        <div className="empty-state">
          <h3>无权编辑</h3>
          <p>您不是该文章作者，无法编辑！</p>
          <p>
            <Link href={`/clipboard/${clip.id}`}>← 返回</Link>
          </p>
        </div>
      </div>
    );
  }

  return (
    <UploadForm
      clip={{
        id: clip.id,
        title: clip.title,
        content: clip.content ?? '',
        publicity: clip.publicity,
      }}
    />
  );
}
