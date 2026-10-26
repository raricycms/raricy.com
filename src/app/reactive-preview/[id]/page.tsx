import { notFound } from 'next/navigation';
import { requireAdmin } from '@/lib/guard';
import { getBlogDetail } from '@/lib/blog-service';
import { compileReactiveSource } from '@/lib/reactive/compile';
import { parseContentFormat } from '@/lib/content-format';
import { shouldFallbackToLegacy } from '@/lib/reactive/diagnostics';
import ReactiveDocument from '@/app/components/reactive/ReactiveDocumentLazy';
import FooterCopyOverride from '@/app/components/FooterCopyOverride';

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Reactive 预览',
  robots: { index: false, follow: false },
};

/**
 * 仅管理员可见的 ReactiveMD 隔离预览（计划 M2 退出条件）。
 *
 * 它绕开 `REACTIVE_MD_MODE` 与逐篇 override，**强制**用新渲染器渲染任意存量文章，
 * 用来做语料验收与手工截图。正因如此它必须只对管理员开放：
 * 这条路由的输入是作者原文，输出是尚未灰度的渲染路径。
 */
export default async function ReactivePreviewPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireAdmin();
  const { id } = await params;

  const blog = await getBlogDetail(id, { id: user.id, isCore: true });
  if (!blog) notFound();

  const source = blog.content?.content ?? '';
  const format = parseContentFormat(blog.content?.format) ?? 'markdown';
  const bundle = await compileReactiveSource({
    source,
    // 预览存量文章时按 markdown 编译（软换行与旧渲染器一致）；reactive 文档按自身格式。
    format,
    mode: 'expand',
    viewer: user,
  });

  const fallback = shouldFallbackToLegacy(bundle.result);
  const codes = bundle.result.diagnostics.map((d) => d.code);

  return (
    <div className="blog-detail reactive-preview">
      <div className="blog-content-container-container">
        <div className="read-card">
          <header className="read-hero">
            <h1>{blog.title}</h1>
            <p className="reactive-preview__meta">
              预览模式 · 渲染器 reactive · 缓存 {bundle.cacheHit ? '命中' : '未命中'} ·{' '}
              {bundle.compileMs} ms
              {fallback ? ' · 正式灰度会回退旧渲染器' : ''}
            </p>
          </header>

          {bundle.result.ok ? (
            <div
              className="blog-content-container"
              id="userContentContainer"
              data-content-renderer="reactive-preview"
            >
              <ReactiveDocument
                document={bundle.result.document}
                hostData={bundle.hostData}
                staticFirst
                role="read"
              />
            </div>
          ) : (
            <div className="blog-content-container" id="userContentContainer">
              <p>这篇文档无法用 ReactiveMD 解释，正式路径会回退旧渲染器。</p>
            </div>
          )}

          {codes.length > 0 && (
            <details className="reactive-preview__diagnostics">
              <summary>诊断（{codes.length}）</summary>
              <ul>
                {codes.map((code, index) => (
                  <li key={`${code}-${index}`}>
                    <code>{code}</code>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      </div>
      <FooterCopyOverride text={`作者：${blog.author?.username ?? ''} | 版权归原作者所有`} />
    </div>
  );
}
