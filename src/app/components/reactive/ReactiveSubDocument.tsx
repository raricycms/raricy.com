'use client';

// ─────────────────────────────────────────────────────────────────────────────
// ReactiveSubDocument.tsx — 内联子文档的**静态**渲染表面
//
// 只服务一件事：`site-embed` 的 Markdown 剪贴板内联。子文档由服务端（或编辑器
// 预览的客户端编译）按同一套 compat / 编译选项生成，随 hostData 下发；这里用
// `LocalDocumentView mode="static"` 渲染它，**不挂交互控件、不发业务写请求**。
//
// 为什么不是直接复用 `ReactiveDocument`：
//   · `ReactiveDocument` 的 hostRenderer 固定是 `SiteEmbedView`，而 `SiteEmbedView`
//     又要经由静态渲染器回到这里 —— 两模块会成环；
//   · 子文档只允许静态形态，不需要 `staticFirst` / 预览上下文。
//   hostRenderer 因此由调用方传入（`site-embed-static.tsx` 传 `renderSiteEmbedStatic`），
//   子文档里的音频 / 图片仍走同一份只读渲染器，不另开一条管线。
//
// runtime 的生命周期与 `ReactiveDocument.tsx` 相同（StrictMode 的 setup→cleanup→setup
// 不能把第二次挂载用的 runtime 提前 dispose）；改动这里时两处一起看。
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { createLocalRuntime, type LocalDocument, type LocalRuntime } from 'reactive-md';
import {
  LocalDocumentView,
  type LocalHostData,
  type LocalHostRenderer,
  type LocalLocale,
} from 'reactive-md/react/unstyled';
import { isAllowedReactiveUrl } from '@/lib/reactive/url-policy';

export interface ReactiveSubDocumentProps {
  document: LocalDocument;
  hostData?: LocalHostData;
  /** 子文档里的宿主组件渲染器；由调用方传入，避免与 SiteEmbedView 成环。 */
  hostRenderer: LocalHostRenderer;
  locale?: LocalLocale;
}

export default function ReactiveSubDocument({
  document,
  hostData,
  hostRenderer,
  locale = 'zh',
}: ReactiveSubDocumentProps): ReactNode {
  const [state, setState] = useState<{ document: LocalDocument; runtime: LocalRuntime }>(
    () => ({ document, runtime: createLocalRuntime(document) })
  );
  let runtime = state.runtime;
  if (state.document !== document) {
    runtime = createLocalRuntime(document);
    setState({ document, runtime });
  }

  const disposals = useRef(new Map<LocalRuntime, { held: number }>());
  useEffect(() => {
    let token = disposals.current.get(runtime);
    if (!token) {
      token = { held: 0 };
      disposals.current.set(runtime, token);
    }
    token.held += 1;
    const entry = token;
    return () => {
      entry.held -= 1;
      setTimeout(() => {
        if (entry.held > 0) return;
        if (disposals.current.get(runtime) !== entry) return;
        disposals.current.delete(runtime);
        runtime.dispose();
      }, 0);
    };
  }, [runtime]);

  const urlPolicy = useCallback(
    (url: string, kind: 'image' | 'link') => isAllowedReactiveUrl(url, kind),
    []
  );

  return (
    <div className="reactive-document site-embed-clipboard-inline" data-content-renderer="clipboard-inline">
      <LocalDocumentView
        document={document}
        runtime={runtime}
        locale={locale}
        mode="static"
        hostData={hostData}
        hostRenderer={hostRenderer}
        urlPolicy={urlPolicy}
      />
    </div>
  );
}
