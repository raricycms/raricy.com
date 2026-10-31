import Link from 'next/link';
import { ChevronLeft } from 'lucide-react';
import type { ReactNode } from 'react';

// 功能页通用抬头：返回关系（可选）+ 唯一的 h1 + 一句必要说明（可选）+ 主操作位（可选）。
// h1 保留 `page-title` 类 —— 多条 e2e 按 `.page-title` 取标题；左对齐由 .page-header 作用域覆盖。
// 一页只渲染一个 PageHeader（它就是那页唯一的 h1）。
export default function PageHeader({
  title,
  titleId,
  back,
  description,
  actions,
}: {
  title: ReactNode;
  /** 给 h1 的锚点 id（如商城的 #shop）。 */
  titleId?: string;
  back?: { href: string; label: string };
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className={'page-header' + (description ? ' page-header--with-desc' : '')}>
      <div className="page-header__main">
        {back ? (
          <Link href={back.href} className="page-header__back">
            <ChevronLeft aria-hidden="true" />
            {back.label}
          </Link>
        ) : null}
        <h1 className="page-title page-header__title" id={titleId}>{title}</h1>
        {description ? <p className="page-header__desc">{description}</p> : null}
      </div>
      {actions ? <div className="page-header__actions">{actions}</div> : null}
    </header>
  );
}
