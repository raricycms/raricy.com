'use client';

// ReactiveDocument 的**按需加载**外壳。
//
// 阅读页在 flag=off（默认）时永远走 legacy，但页面模块里若直接 import
// `ReactiveDocument`，`reactive-md` + 两份 CSS 会进每一条博客 / 剪贴板路由的首屏
// 客户端包（约 250KB）。这个小外壳本身只依赖 `next/dynamic`：只有真正渲染
// reactive 分支时，浏览器才会去取那一块。SSR 仍然可用（`ssr: true`，静态首屏
// 不靠客户端 JS）。
import dynamic from 'next/dynamic';
import type { ComponentProps } from 'react';
import type ReactiveDocumentType from './ReactiveDocument';

const ReactiveDocument = dynamic(() => import('./ReactiveDocument'), {
  ssr: true,
});

export default function ReactiveDocumentLazy(
  props: ComponentProps<typeof ReactiveDocumentType>
) {
  return <ReactiveDocument {...props} />;
}
