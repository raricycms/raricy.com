import type { Metadata } from 'next';
import { notFound, forbidden } from 'next/navigation';
import { requireCoreUser } from '@/lib/guard';
import { hasAdminRights, isCurrentlyBanned } from '@/lib/auth';
import { getBlogForEdit, getCategoryHierarchy } from '@/lib/blog-service';
import BlogForm, { type BlogFormBanInfo } from '@/app/components/BlogForm';

export const dynamic = 'force-dynamic';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  const blog = await getBlogForEdit(id);
  return { title: blog ? `编辑文章 - ${blog.title}` : '编辑文章 - Raricy.com' };
}

// 对齐 Flask datetime_format 默认格式 '%Y-%m-%d %H:%M:%S'
function fmtDateTime(d: Date | null): string | null {
  if (!d) return null;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(
    d.getMinutes()
  )}:${p(d.getSeconds())}`;
}

export default async function EditBlogPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireCoreUser();
  const { id } = await params;

  // 对齐 Flask edit_blog：文章不存在或已软删除 → 404
  const blog = await getBlogForEdit(id);
  if (!blog) notFound();

  // 权限：仅作者本人（对齐 Flask，非作者 403）
  if (blog.authorId !== user.id) forbidden();

  // 禁言检查（管理员除外，对齐 check_user_ban_status_for_admin）
  let banInfo: BlogFormBanInfo | null = null;
  if (!hasAdminRights(user) && isCurrentlyBanned(user)) {
    banInfo = {
      reason: user.banReason ?? '',
      banUntilText: fmtDateTime(user.banUntil),
      remainingHours: user.banUntil ? (user.banUntil.getTime() - Date.now()) / 3600000 : null,
    };
  }

  const categories = await getCategoryHierarchy();

  return (
    <BlogForm
      categories={categories}
      blog={{
        id: blog.id,
        title: blog.title,
        description: blog.description,
        categoryId: blog.categoryId,
        contentMarkdown: blog.contentMarkdown,
      }}
      banInfo={banInfo}
    />
  );
}
