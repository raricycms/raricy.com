import Link from 'next/link';
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


export default async function ClipDetailPage({ params }: { params: Promise<{ id: string }> }) {
  await requireCoreUser();
  const { id } = await params;
  const user = await getCurrentUser();
  // 站长能看任何人的私有剪贴板（对齐 Flask 的 `and not current_user.is_owner`）。
  // 漏掉这个例外时，站长访问会吃 403，连下面那个只对他显示的「删除」按钮都够不着。
  const result = await getClip(id, user?.id, isOwner(user));

  if (!result.ok) {
    // 对齐 Flask：私有且非作者/非站长 → abort(403)。
    // 用 forbidden() 而不是自己渲染一个 403 样子的页面 —— 后者 HTTP 状态是 200，
    // 爬虫和监控会把「禁止访问」当成正常内容收录/统计。forbidden() 会以真 403
    // 渲染 app/forbidden.tsx（同一个彩虹 403 页），顺带省掉这里重复的 90 行 CSS。
    if (result.reason === 'forbidden') forbidden();
    notFound();
  }

  const { clip } = result;
  const isAuthor = !!user && user.id === clip.authorId;
  const canDelete = isAuthor || isOwner(user);

  return (
    <div className="clipboard-page">
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
      </div>
      {/* 对齐 Flask detail.html 覆写 copyright：页脚显示按作者署名的版权行 */}
      <FooterCopyright
        text={`原作者：${clip.authorName ?? '未知作者'} | 版权归原作者所有`}
      />
    </div>
  );
}
