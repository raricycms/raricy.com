'use client';

// ReactiveDocument 的**按需加载**外壳。
//
// 阅读页在 flag=off（默认）时永远走 legacy，但页面模块里若直接 import
// `ReactiveDocument`，`reactive-md` + 两份 CSS 会进每一条博客 / 剪贴板路由的首屏
// 客户端包（约 250KB）。这个小外壳用 React.lazy：只有真正渲染
// reactive 分支时，浏览器才会去取那一块。保留 Suspense SSR，静态首屏
// 不靠客户端 JS。两端使用同一棵组件树，避免 next/dynamic 的服务端预加载节点
// 改变 useId 路径，导致跳转链接与客户端查找的锚点 ID 不一致。
import { lazy, Suspense, type ComponentProps } from 'react';
import type ReactiveDocumentType from './ReactiveDocument';

const ReactiveDocument = lazy(() => import('./ReactiveDocument'));

export default function ReactiveDocumentLazy(
  props: ComponentProps<typeof ReactiveDocumentType>
) {
  return (
    <Suspense fallback={null}>
      <ReactiveDocument {...props} />
    </Suspense>
  );
}
