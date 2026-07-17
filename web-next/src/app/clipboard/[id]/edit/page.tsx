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

export default async function ClipEditPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requireCoreUser();
  const { id } = await params;
  const user = await getCurrentUser();
  // 传 isOwner 只是为了跳过 getClip 的公开性闸门 —— 对齐 Flask：edit_page 取内容用的是
  // get_clipboard_with_content()，它不看 publicity，权限完全由下面那道作者判定来把。
  // 所以站长在这里能取到内容、但依然会被作者判定挡下（Flask 同样如此）。
  const result = await getClip(id, user?.id, isOwner(user));

  // 对齐 Flask edit_page：不存在 → 404。
  if (!result.ok) {
    // 私有 + 非作者非站长 —— Flask 这种情况先 404（取不到内容）还是 403（非作者）？
    // 它的 get_clipboard_with_content 不过滤 publicity，所以取得到 → 走 403。这里对齐。
    if (result.reason === 'forbidden') forbidden();
    notFound();
  }

  const { clip } = result;

  // 对齐 Flask edit_page：非作者 → abort(403)。
  // 用 forbidden() 而不是渲染一个「无权编辑」的页面：后者 HTTP 200，
  // 监控和爬虫会把拒绝当成正常页面。
  if (!user || user.id !== clip.authorId) forbidden();

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
