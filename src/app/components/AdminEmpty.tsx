import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';

// 管理端空态。各页原先各写一段 text-center py-5，字号/颜色/留白都不一。
export default function AdminEmpty({
  icon: Icon,
  title,
  description,
  children,
}: {
  icon?: LucideIcon;
  title: string;
  description?: string;
  children?: ReactNode;
}) {
  return (
    <div className="admin-empty">
      {Icon ? (
        <span className="admin-empty__icon" aria-hidden="true">
          <Icon />
        </span>
      ) : null}
      <p className="admin-empty__title">{title}</p>
      {description ? <p className="admin-empty__desc">{description}</p> : null}
      {children}
    </div>
  );
}
