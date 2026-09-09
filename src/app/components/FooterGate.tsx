'use client';

import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';

// FooterGate —— 按路由决定要不要渲染站点页脚。
//
// 【为什么需要它】`/chat` 是满屏工作台（.chat-page 高 calc(100vh - 62px) + overflow:
// hidden），而 layout 里的页脚是文档流的最后一块：body 是 flex column、main flex:1，
// 页脚一出，文档就比视口高出一截 —— 页面平白多出整条滚动条，滚一下连输入框都被顶出
// 视野。聊天页不需要页脚，去掉后 62px 顶栏 + 聊天区正好一屏。
//
// 【为什么是客户端门控而不是布局】根 layout 无条件渲染页脚，子路由的 layout 无法
// 「移除」父级的 UI；要让页脚只对部分路由消失，只能在渲染处判断路径。用 RSC 的
// 「服务端 children 传给客户端组件」写法：Footer 仍是服务端组件，这里只决定挂不挂。
// usePathname 在 SSR 阶段就有值（取自服务端路由状态），首屏 HTML 里就没有页脚，
// 不存在水合后再移除的闪烁。
//
// 【匹配】usePathname 不含 query（/chat?channel=xxx 同样命中）。/chat 目前没有子路由，
// 但按前缀写，将来加 /chat/xxx 也不会漏。

const HIDE_FOOTER_PREFIXES = ['/chat'];

export default function FooterGate({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const hidden = HIDE_FOOTER_PREFIXES.some(
    (p) => pathname === p || pathname.startsWith(`${p}/`)
  );
  return hidden ? null : <>{children}</>;
}
