'use client';

// BlogForm — 发布/编辑文章表单（Flask BEM）
//
// - 编辑器：vditor npm 包（vditor@3.10.7），icon sprite + KaTeX 从 /static/vditor 本地加载
// - 提交：新建 → POST /api/blogs；编辑 → PUT /api/blogs/:id
// - 禁言时展示横幅并禁用表单
import { useEffect, useRef } from 'react';
import Vditor from 'vditor';
import 'vditor/dist/index.css';
import type { CategoryHierarchy } from '@/lib/blog-service';

// vditor 默认会从远端拉 icon sprite / 预览用 KaTeX；本仓把这些资源拷到
// public/static/vditor/，并把 cdn 指向这个本地路径，避免运行时依赖 unpkg。
const VDITOR_LOCAL_CDN = '/static/vditor';

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

  const vditorRef = useRef<Vditor | null>(null);
  const vditorLoadedRef = useRef(false);
  const editorDivRef = useRef<HTMLDivElement>(null);
  const fallbackMsgRef = useRef<HTMLParagraphElement>(null);
  const fallbackRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
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

    try {
      if (cancelled) return;
      vditorRef.current = new Vditor('editor', {
        minHeight: 500,
        mode: 'ir',
        cdn: VDITOR_LOCAL_CDN,
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
      });
      vditorLoadedRef.current = true;
    } catch {
      showFallback();
    }

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function getContent(): string {
    if (vditorLoadedRef.current && vditorRef.current) {
      return vditorRef.current.getValue();
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
          vditorRef.current.clearCache();
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
    <section className="blog-form-container" id="blog-form-container">
      {isEdit && (
        <div
          className="d-flex justify-content-between align-items-center mb-3"
        >
          <div>
            <h3 className="form-label">编辑文章 ID: {blog!.id}</h3>
          </div>
          <a href={`/blog/${blog!.id}`} className="button button-primary-small">
            返回阅读页
          </a>
        </div>
      )}

      {banInfo && (
        <div
          className="alert alert-danger"
          role="alert"
        >
          <strong>
            您已被禁言，无法{isEdit ? '编辑' : '发布新'}文章
          </strong>
          <p style={{ margin: '8px 0 4px' }}>
            <strong>原因：</strong>
            {banInfo.reason}
          </p>
          {banInfo.banUntilText && (
            <p style={{ margin: '4px 0' }}>
              <strong>解除时间：</strong>
              {banInfo.banUntilText}
            </p>
          )}
          {banInfo.remainingHours != null && (
            <p style={{ margin: '4px 0 0' }}>
              <strong>剩余时间：</strong>
              {banInfo.remainingHours > 24
                ? `约${(banInfo.remainingHours / 24).toFixed(1)}天`
                : `约${banInfo.remainingHours.toFixed(1)}小时`}
            </p>
          )}
        </div>
      )}

      <form
        id="blogForm"
        onSubmit={onSubmit}
        style={banInfo ? { opacity: 0.5, pointerEvents: 'none' } : undefined}
      >
        <div className="form-group">
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

        <div className="form-group">
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

        <div className="form-group">
          <label htmlFor="category" className="form-label">
            栏目
          </label>
          <select
            className="form-select"
            id="category"
            name="category"
            defaultValue={blog?.categoryId ?? ''}
          >
            <option value="">选择栏目</option>
            {categories.map((category) => (
              <optgroup key={category.id} label={`${category.icon ?? ''} ${category.name}`}>
                <option value={category.id}>
                  {category.icon} {category.name}
                </option>
                {category.children.map((child) => (
                  <option key={child.id} value={child.id}>
                    {child.icon} {child.name}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </div>

        <div className="form-group">
          <label className="form-label">
            内容（Markdown 格式）
          </label>
          <div
            id="editor"
            ref={editorDivRef}
            style={{
              height: '60vh',
              background: 'var(--color-background-content)',
              border: '2px solid var(--color-border)',
              borderRadius: '15px',
            }}
          ></div>
          <p
            id="fallback-message"
            ref={fallbackMsgRef}
            className="form-text"
            style={{ display: 'none' }}
          >
            Markdown 编辑器加载失败，已切换到基础文本输入框。
          </p>
          <textarea
            id="fallback-editor"
            ref={fallbackRef}
            className="form-control"
            rows={20}
            style={{
              display: 'none',
              fontFamily: 'ui-monospace, monospace',
            }}
          ></textarea>
        </div>

        <div className="actions">
          <button type="submit" className="button button-primary">
            {isEdit ? '保存修改' : '提交'}
          </button>
          {isEdit && (
            <a href={`/blog/${blog!.id}`} className="button button-primary-small">
              取消
            </a>
          )}
        </div>
      </form>
    </section>
  );
}