import type { Metadata } from 'next';
import { notFound, forbidden } from 'next/navigation';
import { requireCoreUser } from '@/lib/guard';
import { getCurrentUser, isCoreUser, hasAdminRights, isCurrentlyBanned } from '@/lib/auth';
import { getBlogForEdit, getCategoryHierarchy } from '@/lib/blog-service';
import { ymdhms } from '@/lib/format';
import { hoursUntil } from '@/lib/db-time';
import BlogForm, { type BlogFormBanInfo } from '@/app/components/BlogForm';

export const dynamic = 'force-dynamic';

// ⚠️ metadata 与页面是**两个独立的渲染步**：下面那道 `requireCoreUser()` 拦不住这里。
// 这里曾经裸调 `getBlogForEdit(id)` 取标题，结果非 core 用户拿到 403 页、`<title>` 里
// 却**照样带着文章标题** —— `forbidden()` 不会清掉已经生成的 `<head>`（实测确认，由
// tests/e2e/access-control.spec.ts 的 `/blog/<id>/edit` 那条钉住）。
// 所以这里必须自己判档位，而且判不过就**连查都不查**（不取进内存就不存在漏出去的活口）。
// 档位定在 core+：core+ 本来就能读全站标题（`/api/blogs`），对他们不算新信息；
// 低于 core 的人则一个标题都不该拿到。
export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const user = await getCurrentUser();
  if (!isCoreUser(user)) return { title: '编辑文章 - Raricy.com' };

  const { id } = await params;
  const blog = await getBlogForEdit(id);
  return { title: blog ? `编辑文章 - ${blog.title}` : '编辑文章 - Raricy.com' };
}

// 编辑文章 — 与发布页共用 BlogForm 与 upload-hero 页头
export default async function EditBlogPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireCoreUser();
  const { id } = await params;

  const blog = await getBlogForEdit(id);
  if (!blog) notFound();

  if (blog.authorId !== user.id) forbidden();

  let banInfo: BlogFormBanInfo | null = null;
  if (!hasAdminRights(user) && isCurrentlyBanned(user)) {
    banInfo = {
      reason: user.banReason ?? '',
      banUntilText: ymdhms(user.banUntil),
      remainingHours: hoursUntil(user.banUntil),
    };
  }

  const categories = await getCategoryHierarchy();

  return (
    <>
      <header className="upload-hero">
        <h1>编辑文章</h1>
        <p>ID: {blog.id}</p>
      </header>
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
    </>
  );
}