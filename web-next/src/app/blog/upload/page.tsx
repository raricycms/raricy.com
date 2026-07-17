import type { Metadata } from 'next';
import { requireCoreUser } from '@/lib/guard';
import { isCurrentlyBanned } from '@/lib/auth';
import { getCategoryHierarchy } from '@/lib/blog-service';
import BlogForm, { type BlogFormBanInfo } from '@/app/components/BlogForm';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Raricy.com - 文章上传',
};

// 对齐 Flask datetime_format 默认格式 '%Y-%m-%d %H:%M:%S'
function fmtDateTime(d: Date | null): string | null {
  if (!d) return null;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(
    d.getMinutes()
  )}:${p(d.getSeconds())}`;
}

export default async function UploadBlogPage() {
  // 对齐 Flask blog.upload GET：@login_required + 仅核心用户（否则 abort(403)）
  const user = await requireCoreUser();

  // 禁言检查（upload 对所有用户生效）
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

  return <BlogForm categories={categories} banInfo={banInfo} />;
}
