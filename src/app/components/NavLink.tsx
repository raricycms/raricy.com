'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';

// 顶栏的切页链接：落在当前栏目时挂 `.is-active`。
//
// 【为什么单开一个叶子组件】Navbar 是服务端组件（在 layout.tsx 里直接渲染、
// 接收 SafeUser），而 usePathname() 只能在客户端调用。把「读路径」这一件事关进
// 这个叶子，Navbar 就不必整体转成客户端组件 —— 那会把它的整棵子树（含
// LogoutLink、头像、下拉菜单）一起拖进 bundle。
//
// 【匹配规则】全等，或落在该栏目**子路径**下：/blog/123 时「博客」仍然高亮。
// 比对用 `${href}/` 前缀而不是裸 startsWith —— 否则 /story 会把 /storyx 也吃了。
// 首页（href="/"）只认全等，不然它会匹配一切。
//
// 【样式归属】`.is-active` 的观感定义在「切页档」里，见
// `src/styles-scss/abstracts/_mixins.scss` 的 @mixin btn-tab。
export default function NavLink({
  href,
  className,
  children,
}: {
  href: string;
  className?: string;
  children: ReactNode;
}) {
  const pathname = usePathname();
  const active = href === '/' ? pathname === '/' : pathname === href || pathname.startsWith(`${href}/`);

  return (
    <Link
      href={href}
      className={className ? `${className}${active ? ' is-active' : ''}` : undefined}
      // 供读屏软件播报「当前页面」；视觉上的 .is-active 只是它的表现形式。
      aria-current={active ? 'page' : undefined}
    >
      {children}
    </Link>
  );
}
