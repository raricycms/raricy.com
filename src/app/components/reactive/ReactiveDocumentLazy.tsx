'use client';

// ReactiveDocument 的**按需加载**外壳。
//
// 目标入口（博客 / 剪贴板）默认都走统一管线；页面模块里若直接 import
// `ReactiveDocument`，`reactive-md` + 两份 CSS 会进每一条路由的首屏客户端包
// （约 250KB）。这个小外壳用 React.lazy：只有真正渲染 reactive 分支时，浏览器
// 才会去取那一块。两端使用同一棵组件树，避免 next/dynamic 的服务端预加载节点
// 改变 useId 路径，导致跳转链接与客户端查找的锚点 ID 不一致。
//
// ⚠️ **SSR 必须真的产出正文**：`fallback={null}` 在服务端只产出一层空壳时，
// 关 JS 的读者会看到空白。冷启动首请求 + 无 JS 的可见性由
// `tests/e2e/reactive-ssr-cold.spec.ts` 单独守（不能拿已预热页面的结果冒充）。
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
