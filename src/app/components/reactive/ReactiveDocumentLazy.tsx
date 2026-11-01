'use client';

// ReactiveDocument 的**按需加载**外壳。
//
// 目标入口（博客 / 剪贴板）默认都走统一管线；页面模块里若直接 import
// `ReactiveDocument`，`reactive-md` + 两份 CSS 会进每一条路由的首屏客户端包
// （约 250KB）。这里用 `next/dynamic` 保持客户端代码分割。
//
// ⚠️ **SSR 必须真的产出正文**：`React.lazy` + `Suspense fallback={null}` 在服务端
// 只产出一层空壳（实测冷启动首请求 + 无 JS 时 `#userContentContainer` 完全为空），
// 关 JS 的读者看到的是空白。`next/dynamic` 的 `ssr: true`（默认）会在服务端把
// 模块解析完再渲染，首屏正文与客户端水合的是同一棵树；客户端仍然按 chunk 懒加载。
//
// 冷启动首请求 + 无 JS 的可见性由 `tests/e2e/reactive-ssr-cold.spec.ts` 单独守
// （不能拿已预热页面的结果冒充）。
import dynamic from 'next/dynamic';
import type { ComponentProps } from 'react';
import type ReactiveDocumentType from './ReactiveDocument';

const ReactiveDocument = dynamic(() => import('./ReactiveDocument'), {
  ssr: true,
  loading: () => null,
});

export default function ReactiveDocumentLazy(
  props: ComponentProps<typeof ReactiveDocumentType>
) {
  return <ReactiveDocument {...props} />;
}
