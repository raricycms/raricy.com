import Link from 'next/link';
import { ChevronRight } from 'lucide-react';
import type { ReactNode } from 'react';

// 账户域的入口行：图标 + 名称 + 一句功能说明。链接的可访问名称只取名称一格
// （aria-labelledby），说明走 aria-describedby —— 否则按名称定位链接的用例与读屏都会读到整串。
export default function FishEntry({
  slug,
  href,
  icon,
  name,
  desc,
}: {
  slug: string;
  href: string;
  icon: ReactNode;
  name: string;
  desc: string;
}) {
  const nameId = `fish-entry-${slug}-name`;
  const descId = `fish-entry-${slug}-desc`;
  return (
    <Link href={href} className="fish-entry" aria-labelledby={nameId} aria-describedby={descId}>
      <span className="fish-entry__icon" aria-hidden="true">{icon}</span>
      <span className="fish-entry__text">
        <span className="fish-entry__name" id={nameId}>{name}</span>
        <span className="fish-entry__desc" id={descId}>{desc}</span>
      </span>
      <ChevronRight className="fish-entry__chevron" aria-hidden="true" />
    </Link>
  );
}
