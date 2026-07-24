import type { Metadata } from 'next';
import { requireCoreUser } from '@/lib/guard';
import { isCurrentlyBanned } from '@/lib/auth';
import { getCategoryHierarchy } from '@/lib/blog-service';
import BlogForm, { type BlogFormBanInfo } from '@/app/components/BlogForm';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Raricy.com - 发布文章',
};

// 对齐 Flask datetime_format 默认格式
function fmtDateTime(d: Date | null): string | null {
  if (!d) return null;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// 发布文章 — Flask BEM
export default async function UploadBlogPage() {
  const user = await requireCoreUser();

  let banInfo: BlogFormBanInfo | null = null;
  if (isCurrentlyBanned(user)) {
    banInfo = {
      reason: user.banReason ?? '',
      banUntilText: fmtDateTime(user.banUntil),
      remainingHours: user.banUntil
        ? (user.banUntil.getTime() - Date.now()) / 3600000
        : null,
    };
  }

  const categories = await getCategoryHierarchy();

  return (
    <>
      <header className="upload-hero">
        <h1>发布新文章</h1>
        <p>使用 Markdown 编辑器撰写并发布你的内容。</p>
      </header>
      <BlogForm categories={categories} banInfo={banInfo} />
    </>
  );
}