import type { Metadata } from 'next';
import { requireCoreUser } from '@/lib/guard';
import { isCurrentlyBanned } from '@/lib/auth';
import { getCategoryHierarchy } from '@/lib/blog-service';
import { ymdhms } from '@/lib/format';
import { hoursUntil } from '@/lib/db-time';
import BlogForm, { type BlogFormBanInfo } from '@/app/components/BlogForm';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Raricy.com - 发布文章',
};

// 发布文章 — Flask BEM
export default async function UploadBlogPage() {
  const user = await requireCoreUser();

  let banInfo: BlogFormBanInfo | null = null;
  if (isCurrentlyBanned(user)) {
    // banUntilText 走 ymdhms、remainingHours 走 hoursUntil —— 两者都是「UTC+8 墙上时间」
    // 口径（见 db-time.ts）；用本地 getter / Date.now() 会按服务器时区或真实 UTC 平移。
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
        <h1>发布新文章</h1>
        <p>使用 Markdown 编辑器撰写并发布你的内容。</p>
      </header>
      <BlogForm categories={categories} banInfo={banInfo} />
    </>
  );
}