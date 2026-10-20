import type { CSSProperties } from 'react';
import Link from 'next/link';
import { prisma } from '@/lib/db';
import { requireAdmin } from '@/lib/guard';
import { isOwner } from '@/lib/auth';
import AdminPageHeader from '@/app/components/AdminPageHeader';
import AdminStatNumber from '@/app/components/AdminStatNumber';
import {
  ClipboardList,
  FilePen,
  FileText,
  Heart,
  Megaphone,
  MessageCircle,
  Scale,
  ShieldCheck,
  Users,
  type LucideIcon,
} from 'lucide-react';

export const dynamic = 'force-dynamic';

// 管理概览
//
// 站点统计属于管理信息，core 用户看不了 —— 父 layout 已放宽到 core+（用户管理要用），
// 这一档由页面自己把住。
export default async function AdminDashboardPage() {
  const me = await requireAdmin();
  const owner = isOwner(me);

  const [totalBlogs, likesAgg, totalComments, totalUsers, uncategorizedBlogs] = await Promise.all([
    prisma.blog.count({ where: { ignore: false } }),
    prisma.blog.aggregate({ where: { ignore: false }, _sum: { likesCount: true } }),
    prisma.blogComment.count({ where: { isDeleted: false } }),
    prisma.user.count(),
    prisma.blog.count({ where: { ignore: false, categoryId: null } }),
  ]);

  // tone 借用分类强调色（不是语义色）：五张卡彼此区分用。红心那张刻意**不**用
  // --color-warning-*（那是「危险 / 删除」的语义色，docs/frontend-styles §2.6），
  // 也不借收藏夹专用的 --color-star-*。
  const cards: Array<{
    number: number;
    label: string;
    icon: LucideIcon;
    tone: 'blue' | 'amber' | 'cyan' | 'violet' | 'success';
    href?: string;
  }> = [
    {
      number: totalBlogs,
      label: '总文章数',
      icon: FileText,
      tone: 'blue',
      href: '/admin/blogs',
    },
    { number: likesAgg._sum.likesCount ?? 0, label: '总点赞数', icon: Heart, tone: 'violet' },
    { number: totalComments, label: '总评论数', icon: MessageCircle, tone: 'cyan' },
    { number: totalUsers, label: '总用户数', icon: Users, tone: 'success', href: '/admin/users' },
    {
      number: uncategorizedBlogs,
      label: '未分类文章',
      icon: ClipboardList,
      tone: 'amber',
      href: '/admin/blogs?category=-1',
    },
  ];

  const quickLinks = [
    { href: '/admin/blogs', label: '文章管理', icon: FilePen },
    { href: '/admin/users', label: '用户管理', icon: Users },
    { href: '/admin/logs', label: '日志检索', icon: ClipboardList },
    { href: '/audit', label: '操作日志', icon: Scale },
    ...(owner
      ? [
          { href: '/admin/broadcast', label: '通知发送', icon: Megaphone },
          { href: '/admin/categories', label: '栏目管理', icon: FileText },
          { href: '/admin/appeals', label: '申诉管理', icon: Scale },
        ]
      : []),
  ];

  return (
    <>
      <AdminPageHeader
        eyebrow={
          <>
            <ShieldCheck aria-hidden="true" />
            管理面板
          </>
        }
        title="管理概览"
        subtitle="站点数据一览与常用管理入口"
      />

      <div className="admin-container">
        <section aria-label="站点统计">
          <div className="admin-kpi-grid">
            {cards.map((c, i) => {
              const body = (
                <>
                  <span className="admin-kpi__icon" aria-hidden="true">
                    <c.icon />
                  </span>
                  <span className="admin-kpi__number">
                    <AdminStatNumber value={c.number} />
                  </span>
                  <span className="admin-kpi__label">{c.label}</span>
                </>
              );
              return c.href ? (
                <Link
                  key={c.label}
                  href={c.href}
                  className={`admin-kpi admin-kpi--${c.tone}`}
                  style={{ '--i': i } as CSSProperties}
                >
                  {body}
                </Link>
              ) : (
                <div
                  key={c.label}
                  className={`admin-kpi admin-kpi--${c.tone}`}
                  style={{ '--i': i } as CSSProperties}
                >
                  {body}
                </div>
              );
            })}
          </div>
        </section>

        <section className="admin-panel admin-quick-panel" aria-label="快捷入口">
          <div className="admin-section-head">
            <h2 className="admin-section-title">快捷入口</h2>
          </div>
          <div className="admin-quick-grid">
            {quickLinks.map((q) => (
              <Link key={q.href} href={q.href} className="admin-quick">
                <q.icon aria-hidden="true" />
                <span>{q.label}</span>
              </Link>
            ))}
          </div>
        </section>
      </div>
    </>
  );
}
