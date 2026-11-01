'use client';

// ReactiveDocument 的阅读入口。
//
// ⚠️ **这里刻意是静态 import，不是 React.lazy / next/dynamic**。
// 实测（冷启动 + 新 next start + 关闭 JS）：
//   · `React.lazy` + `Suspense fallback={null}` 服务端只输出空壳；
//   · `next/dynamic({ ssr: true })` 在客户端组件里同样没有产出正文。
// 结果是 `#userContentContainer` 存在、正文为空 —— 关 JS 的读者看到空白
// （`tests/e2e/reactive-ssr-cold.spec.ts` 正是在冷启动首请求上抓这个）。
//
// 代价是 `reactive-md` + 两份 CSS 进入博客 / 剪贴板路由的客户端包（约 250KB）；
// 换来的是真正的 SSR 首屏与无 JS 可读。若将来要重新做代码分割，必须先在
// 真实构建上证明冷启动无 JS 的正文仍可见，再改这里。
import type { ComponentProps } from 'react';
import ReactiveDocument from './ReactiveDocument';

export default function ReactiveDocumentLazy(
  props: ComponentProps<typeof ReactiveDocument>
) {
  return <ReactiveDocument {...props} />;
}
