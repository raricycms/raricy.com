import Link from 'next/link';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { pageWindow } from '@/lib/page-window';
import SitePageJump from './SitePageJump';

/**
 * 站内分页 —— 博客 / 通知 / 对外目录 / 小鱼干流水 / 图床与音频床管理共用这一份。
 *
 * 【为什么收成一个组件】这段标记原先在六个页面各抄了一遍（其中三份还各自拖着一个
 * 跳页输入框），于是同一个设计在站内漂成了四种样子：
 *
 *   - `/blog`、`/notifications`：箭头 + 窗口页码 + 跳页胶囊（**本组件的样板**）
 *   - `/explore`：同款，但没有跳页框
 *   - `/fish/transactions`：同款窗口，但前后页写成 `«` / `»` 文本
 *   - `/image/admin`、`/audio/admin`：`Array.from({ length: pages })` —— **全部页码平铺**
 *
 * 最后那种是这里最要命的：页数一多，一排方块挤满整行、窄屏还得横向滚。样式口径见
 * `docs/frontend-styles.md` §5.4（当前页品牌淡底、前后页站内箭头、跳页字段单行胶囊），
 * 而「窗口 + 折叠」的算术住 `src/lib/page-window.ts` 一处。
 *
 * 【别改回去】
 * - 页码只渲染 `pageWindow` 给出的窗口（首尾 + 当前页 ±3，其余折成 …），
 *   别再 `Array.from({ length: pages })` 把全部页码铺出来；
 * - 前后页用 `ChevronLeft`/`ChevronRight`（站内箭头图标），别退回 `‹`/`«` 文本；
 * - 当前页仍渲染成 `<Link>`：站内 e2e（`tests/e2e/notifications.spec.ts`）按
 *   `nav.pagination a.page-link` 的文本（`/^2$/`）点页码，换成不可点的 `<span>`
 *   会让那几条用例当场找不到元素；
 * - 调用方只给「第 n 页的地址」，筛选 / 搜索 / 排序参数由各自 `href(n)` 负责带上，
 *   别在这里统一拼 `?page=` —— 那会把筛选吃掉。
 */
export default function SitePager({
  page,
  pages,
  href,
  jump = true,
}: {
  page: number;
  /** 总页数；<= 1 时整块不渲染（分页只在真的有多页时出现）。 */
  pages: number;
  /** 第 n 页的地址（相对或绝对都行，`Link` 都认）。 */
  href: (page: number) => string;
  /** 是否带「跳页」输入框（默认带，与博客 / 通知一致）。 */
  jump?: boolean;
}) {
  if (pages <= 1) return null;

  return (
    <nav className="pagination" aria-label="分页">
      {page > 1 && (
        <Link href={href(page - 1)} className="page-link" aria-label="上一页">
          <ChevronLeft aria-hidden="true" size={16} />
        </Link>
      )}
      {pageWindow(page, pages).map((p, i) =>
        p === null ? (
          <span key={`gap-${i}`} className="page-ellipsis" aria-hidden="true">
            …
          </span>
        ) : (
          <Link
            key={p}
            href={href(p)}
            className={`numeric page-link${p === page ? ' active' : ''}`}
            aria-current={p === page ? 'page' : undefined}
          >
            {p}
          </Link>
        )
      )}
      {page < pages && (
        <Link href={href(page + 1)} className="page-link" aria-label="下一页">
          <ChevronRight aria-hidden="true" size={16} />
        </Link>
      )}
      {jump && <SitePageJump totalPages={pages} current={page} />}
    </nav>
  );
}
