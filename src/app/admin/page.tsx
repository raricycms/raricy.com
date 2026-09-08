import { prisma } from '@/lib/db';
import AdminStatNumber from '@/app/components/AdminStatNumber';
import {
  ClipboardList,
  FileText,
  Heart,
  MessageCircle,
  Users,
  type LucideIcon,
} from 'lucide-react';

export const dynamic = 'force-dynamic';

// 管理概览 — 对齐 Flask blog/admin_dashboard.html
export default async function AdminDashboardPage() {
  const [totalBlogs, likesAgg, totalComments, totalUsers, uncategorizedBlogs] = await Promise.all([
    prisma.blog.count({ where: { ignore: false } }),
    prisma.blog.aggregate({ where: { ignore: false }, _sum: { likesCount: true } }),
    prisma.blogComment.count({ where: { isDeleted: false } }),
    prisma.user.count(),
    prisma.blog.count({ where: { ignore: false, categoryId: null } }),
  ]);

  const cards: Array<{
    number: number;
    label: string;
    variant: string;
    icon: LucideIcon;
  }> = [
    { number: totalBlogs, label: '总文章数', variant: 'admin-stat-card--blue', icon: FileText },
    {
      number: likesAgg._sum.likesCount ?? 0,
      label: '总点赞数',
      variant: 'admin-stat-card--red',
      icon: Heart,
    },
    { number: totalComments, label: '总评论数', variant: 'admin-stat-card--green', icon: MessageCircle },
    { number: totalUsers, label: '总用户数', variant: 'admin-stat-card--purple', icon: Users },
    {
      number: uncategorizedBlogs,
      label: '未分类文章',
      variant: 'admin-stat-card--amber',
      icon: ClipboardList,
    },
  ];

  return (
    <>
      <section className="admin-hero">
        <h1>管理概览</h1>
        <p>博客数据一览</p>
      </section>

      <div className="admin-container">
        <div className="admin-stats">
          {cards.map((c) => (
            <div key={c.label} className={`admin-stat-card ${c.variant}`}>
              <div className="admin-stat-card__number">
                <AdminStatNumber value={c.number} />
              </div>
              <div className="admin-stat-card__label">
                <c.icon aria-hidden="true" />
                <span>{c.label}</span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
