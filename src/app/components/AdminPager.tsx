import Link from 'next/link';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { pageWindow } from '@/lib/page-window';

// 管理端分页 —— 一个组件，四五个页面共用；别再各页抄一份 <ul class="pagination">。
// 视觉是切页档的胶囊（.admin-pager__link → btn-tab），当前页常驻品牌淡底。
export default function AdminPager({
  page,
  pages,
  href,
}: {
  page: number;
  /** 总页数；<=1 时整块不渲染。 */
  pages: number;
  /** 第 n 页的地址（query 由调用方按各自参数拼）。 */
  href: (page: number) => string;
}) {
  if (pages <= 1) return null;

  return (
    <nav className="admin-pager" aria-label="分页">
      {page > 1 && (
        <Link className="admin-pager__link" href={href(page - 1)} aria-label="上一页">
          <ChevronLeft aria-hidden="true" />
        </Link>
      )}
      {pageWindow(page, pages).map((p, i) =>
        p === null ? (
          <span key={`gap-${i}`} className="admin-pager__gap" aria-hidden="true">
            …
          </span>
        ) : p === page ? (
          <span key={p} className="admin-pager__link is-active numeric" aria-current="page">
            {p}
          </span>
        ) : (
          <Link key={p} className="admin-pager__link numeric" href={href(p)}>
            {p}
          </Link>
        )
      )}
      {page < pages && (
        <Link className="admin-pager__link" href={href(page + 1)} aria-label="下一页">
          <ChevronRight aria-hidden="true" />
        </Link>
      )}
    </nav>
  );
}
