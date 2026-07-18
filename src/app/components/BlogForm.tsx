'use client';

// ─────────────────────────────────────────────────────────────────────────────
// BlogForm — 发布/编辑文章表单（逐字对齐 Flask 模板 blog/edit_blog.html）。
//
// - 编辑器：优先 Vditor（'ir' 模式，CDN 加载），失败回落到基础 textarea（对齐原模板 fallback）。
// - 提交：新建 → POST /api/blogs；编辑 → PUT /api/blogs/:id。请求体 { title, description, content, category_id }。
// - 前端软校验（30/100/250000）与文案、成功提示/跳转均对齐原模板。
// - 禁言时展示横幅并禁用表单（opacity .5 + pointer-events:none）。
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useRef } from 'react';
import type { CategoryHierarchy } from '@/lib/blog-service';

const VDITOR_VERSION = '3.10.7';
const VDITOR_CDN = `https://cdn.jsdelivr.net/npm/vditor@${VDITOR_VERSION}`;

function toast(msg: string, type: string) {
  if (typeof window === 'undefined') return;
  const w = window as unknown as { showToast?: (m: string, t: string) => void };
  if (w.showToast) w.showToast(msg, type);
}

export interface BlogFormBlog {
  id: string;
  title: string;
  description: string;
  categoryId: number | null;
  contentMarkdown: string;
}

export interface BlogFormBanInfo {
  reason: string;
  banUntilText: string | null;
  remainingHours: number | null;
}

export interface BlogFormProps {
  categories: CategoryHierarchy;
  blog?: BlogFormBlog | null;
  banInfo?: BlogFormBanInfo | null;
}

export default function BlogForm({ categories, blog = null, banInfo = null }: BlogFormProps) {
  const isEdit = !!blog;
  const initialMarkdown = blog?.contentMarkdown ?? '';

  const vditorRef = useRef<unknown>(null);
  const vditorLoadedRef = useRef(false);
  const editorDivRef = useRef<HTMLDivElement>(null);
  const fallbackMsgRef = useRef<HTMLParagraphElement>(null);
  const fallbackRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    // 禁言态不初始化编辑器（表单已禁用）
    if (banInfo) return;
    let cancelled = false;

    function showFallback() {
      if (editorDivRef.current) editorDivRef.current.style.display = 'none';
      if (fallbackMsgRef.current) fallbackMsgRef.current.style.display = 'block';
      const fb = fallbackRef.current;
      if (fb) {
        fb.style.display = 'block';
        if (!fb.value && initialMarkdown) fb.value = initialMarkdown;
      }
      vditorLoadedRef.current = false;
    }

    function initVditor() {
      const w = window as unknown as { Vditor?: new (el: string, opts: object) => unknown };
      if (typeof w.Vditor === 'undefined') {
        showFallback();
        return;
      }
      try {
        const config = {
          minHeight: 500,
          mode: 'ir',
          cdn: VDITOR_CDN,
          toolbar: [
            'emoji', 'headings', 'bold', 'italic', 'strike', 'link', '|',
            'list', 'ordered-list', 'check', 'outdent', 'indent', '|',
            'quote', 'line', 'code', 'inline-code', 'upload', 'table', '|',
            'undo', 'redo', 'preview', 'export',
          ],
          counter: { enable: true, type: 'text' },
          upload: { url: '/api/images', accept: 'image/*', max: 10 * 1024 * 1024 },
          cache: isEdit ? { enable: false } : { enable: true, id: 'blog-upload-editor' },
          value: initialMarkdown,
        };
        vditorRef.current = new w.Vditor('editor', config);
        vditorLoadedRef.current = true;
      } catch {
        showFallback();
      }
    }

    // 注入 Vditor 样式与脚本（对齐模板的 CDN 引用），失败时回落 textarea
    if (!document.getElementById('vditor-css')) {
      const link = document.createElement('link');
      link.id = 'vditor-css';
      link.rel = 'stylesheet';
      link.href = `${VDITOR_CDN}/dist/index.css`;
      document.head.appendChild(link);
    }

    const w = window as unknown as { Vditor?: unknown };
    if (typeof w.Vditor !== 'undefined') {
      initVditor();
    } else {
      const existing = document.getElementById('vditor-js') as HTMLScriptElement | null;
      const onLoad = () => {
        if (!cancelled) initVditor();
      };
      const onError = () => {
        if (!cancelled) showFallback();
      };
      if (existing) {
        existing.addEventListener('load', onLoad);
        existing.addEventListener('error', onError);
      } else {
        const script = document.createElement('script');
        script.id = 'vditor-js';
        script.src = `${VDITOR_CDN}/dist/index.min.js`;
        script.addEventListener('load', onLoad);
        script.addEventListener('error', onError);
        document.body.appendChild(script);
      }
    }

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function getContent(): string {
    if (vditorLoadedRef.current && vditorRef.current) {
      const v = vditorRef.current as { getValue: () => string };
      return v.getValue();
    }
    return fallbackRef.current?.value ?? '';
  }

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const title = (form.elements.namedItem('title') as HTMLInputElement).value;
    const description = (form.elements.namedItem('description') as HTMLTextAreaElement).value;
    const categoryId = (form.elements.namedItem('category') as HTMLSelectElement).value;
    const content = getContent();

    if (!title || !description || !content) {
      toast('请填写完整信息', 'warning');
      return;
    }
    if (title.length > 30) {
      toast('标题不能超过30个字符', 'warning');
      return;
    }
    if (description.length > 100) {
      toast('描述不能超过100个字符', 'warning');
      return;
    }
    if (content.length > 250000) {
      toast('内容不能超过250000个字符', 'warning');
      return;
    }

    try {
      const url = isEdit ? `/api/blogs/${blog!.id}` : '/api/blogs';
      const method = isEdit ? 'PUT' : 'POST';
      const response = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ title, description, content, category_id: categoryId }),
      });
      const result = await response.json();
      if (result.code === 200) {
        toast(
          isEdit ? '保存成功，正在返回...' : '上传成功！即将跳转到文章页面...',
          'success'
        );
        if (!isEdit && vditorLoadedRef.current && vditorRef.current) {
          (vditorRef.current as { clearCache?: () => void }).clearCache?.();
        }
        setTimeout(
          () => {
            window.location.href = result.redirect || '/blog/' + result.blog_id;
          },
          isEdit ? 800 : 1500
        );
      } else {
        toast('操作失败: ' + result.message, 'error');
      }
    } catch {
      toast('出现错误，请稍后重试', 'error');
    }
  }

  return (
    <>
      <section className="upload-hero">
        {isEdit ? (
          <>
            <h1>编辑文章</h1>
            <div className="text-muted">ID: {blog!.id}</div>
            <div className="mt-2" style={{ marginTop: 30 }}>
              <a className="button button-primary" href={`/blog/${blog!.id}`}>
                返回阅读页
              </a>
            </div>
          </>
        ) : (
          <h1>发布新文章</h1>
        )}
      </section>

      <div className="blog-form-container">
        {banInfo && (
          <div className="alert alert-danger" role="alert">
            <h5 className="alert-heading">您已被禁言</h5>
            <p className="mb-2">您当前无法{isEdit ? '编辑' : '发布新'}文章。</p>
            <hr />
            <p className="mb-0">
              <strong>原因：</strong>
              {banInfo.reason}
              <br />
              {banInfo.banUntilText && (
                <>
                  <strong>解除时间：</strong>
                  {banInfo.banUntilText}
                  <br />
                </>
              )}
              {banInfo.remainingHours != null &&
                (banInfo.remainingHours > 24 ? (
                  <>
                    <strong>剩余时间：</strong>约{(banInfo.remainingHours / 24).toFixed(1)}天
                  </>
                ) : (
                  <>
                    <strong>剩余时间：</strong>约{banInfo.remainingHours.toFixed(1)}小时
                  </>
                ))}
            </p>
          </div>
        )}

        <form
          id="blogForm"
          onSubmit={onSubmit}
          style={banInfo ? { opacity: 0.5, pointerEvents: 'none' } : undefined}
        >
          <div className="mb-3">
            <label htmlFor="title" className="form-label">
              标题
            </label>
            <input
              type="text"
              className="form-control"
              id="title"
              name="title"
              defaultValue={blog?.title ?? ''}
              required
            />
          </div>

          <div className="mb-3">
            <label htmlFor="description" className="form-label">
              摘要
            </label>
            <textarea
              className="form-control"
              id="description"
              name="description"
              rows={3}
              defaultValue={blog?.description ?? ''}
              required
            />
          </div>

          <div className="mb-3">
            <label htmlFor="category" className="form-label">
              栏目
            </label>
            <select className="form-select" id="category" name="category" defaultValue={blog?.categoryId ?? ''}>
              <option value="" className="form-option">
                选择栏目
              </option>
              {categories.map((category) => (
                <optgroup key={category.id} label={`${category.icon ?? ''} ${category.name}`}>
                  <option value={category.id} className="form-option">
                    {category.icon} {category.name}
                  </option>
                  {category.children.map((child) => (
                    <option key={child.id} value={child.id} className="form-option">
                      　└ {child.icon} {child.name}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </div>

          <div className="mb-3">
            <label className="form-label">内容（Markdown格式）（注意：粘贴的内容会自动变为引用。）</label>
            <div id="editor" ref={editorDivRef} style={{ height: '60vh' }}></div>
            <p
              id="fallback-message"
              ref={fallbackMsgRef}
              className="form-text text-muted"
              style={{ display: 'none' }}
            >
              Markdown编辑器加载失败，已切换到基础文本输入框。
            </p>
            <textarea
              id="fallback-editor"
              ref={fallbackRef}
              className="form-control"
              rows={20}
              style={{ display: 'none' }}
            ></textarea>
          </div>

          <div className="btn-row">
            <button type="submit" className="button button-primary">
              {isEdit ? '保存修改' : '提交'}
            </button>
            {isEdit && (
              <a href={`/blog/${blog!.id}`} className="btn btn-outline-secondary">
                取消
              </a>
            )}
          </div>
        </form>
      </div>
    </>
  );
}
