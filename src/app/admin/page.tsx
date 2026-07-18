import { prisma } from '@/lib/db';
import AdminStatNumber from '@/app/components/AdminStatNumber';

export const dynamic = 'force-dynamic'; // 依赖实时计数

// 管理概览：逐字对齐 Flask blog/admin_dashboard.html —— 5 张统计卡 + 数字入场动画。
export default async function AdminDashboardPage() {
  const [totalBlogs, likesAgg, totalComments, totalUsers, uncategorizedBlogs] = await Promise.all([
    prisma.blog.count({ where: { ignore: false } }),
    prisma.blog.aggregate({ where: { ignore: false }, _sum: { likesCount: true } }),
    prisma.blogComment.count({ where: { isDeleted: false } }),
    prisma.user.count(),
    prisma.blog.count({ where: { ignore: false, categoryId: null } }),
  ]);

  const cards: Array<{ icon: string; number: number; label: string }> = [
    { icon: 'icon-journal-text', number: totalBlogs, label: '总文章数' },
    { icon: 'icon-heart-fill', number: likesAgg._sum.likesCount ?? 0, label: '总点赞数' },
    { icon: 'icon-chat-dots_new', number: totalComments, label: '总评论数' },
    { icon: 'icon-people', number: totalUsers, label: '总用户数' },
    { icon: 'icon-grid', number: uncategorizedBlogs, label: '未分类文章' },
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
            <div key={c.label} className="admin-stat-card">
              <span className="admin-stat-card__icon">
                <span className={`icon ${c.icon}`}></span>
              </span>
              <div className="admin-stat-card__body">
                <div className="admin-stat-card__number">
                  <AdminStatNumber value={c.number} />
                </div>
                <div className="admin-stat-card__label">{c.label}</div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
