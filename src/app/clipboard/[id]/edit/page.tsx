import type { Metadata } from 'next';
import { forbidden, notFound } from 'next/navigation';
import { requireCoreUser } from '@/lib/guard';
import { getCurrentUser, isCoreUser, isOwner } from '@/lib/auth';
import { getClip } from '@/lib/clipboard-service';
import UploadForm from '../../upload/UploadForm';

export const dynamic = 'force-dynamic';

// ⚠️ metadata 与页面是**两个独立的渲染步**：下面那道 `requireCoreUser()` 拦不住这里。
// 这里此前只问了 `getClip`（它判的是「公开性 + 归属」，与档位是两回事），于是非 core
// 的登录用户能从这个被 403 的页面里读到公开剪贴板的标题。
// 档位先判，判不过**连查都不查**；判得过之后再把 viewer 传给 getClip —— 那一层管的是
// 「这条剪贴板公不公开」，与「你有没有资格用剪贴板」正交，两层都要过。
export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const user = await getCurrentUser();
  if (!isCoreUser(user)) return { title: '文章编辑 - Raricy.com' };

  const { id } = await params;
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