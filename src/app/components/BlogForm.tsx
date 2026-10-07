'use client';

// BlogForm — 发布/编辑文章表单
//
// - 编辑器：MarkdownEditor（CodeMirror 6，与云剪贴板共用），见其文件头
// - 提交：新建 → POST /api/blogs；编辑 → PUT /api/blogs/:id
// - 禁言时展示横幅并禁用表单
//
// 【本文件不管编辑器内部的事】工具条、预览、上传、导出、草稿都由 MarkdownEditor
// 负责；这里只管**表单语义**：字段校验、长度上限、档位与匿名开关、提交与跳转，
// 以及「发布成功后清草稿」这一下。
import { useRef, useState } from 'react';
import MarkdownEditor, { type MarkdownEditorHandle } from './MarkdownEditor';
import type { CategoryHierarchy } from '@/lib/blog-service';
// 可见性词汇必须从 ./blog-visibility 取（那个模块零依赖）——**不能**从 blog-service，
// 它拖着 prisma，值导出会把服务端依赖拉进客户端包。理由见该文件头。
import { BLOG_VISIBILITIES, VISIBILITY_LABEL } from '@/lib/blog-visibility';
import type { BlogVisibility } from '@/lib/blog-visibility';

function toast(msg: string, type: string) {
  if (typeof window === 'undefined') return;
  const w = window as unknown as { showToast?: (m: string, t: string) => void };
  if (w.showToast) w.showToast(msg, type);
}

/** 新建页的本地草稿键。**沿用 Vditor 时代的键名，且存的也是 Markdown 原文** ——
 *  换键名 = 用户上一版留下的草稿静默消失（见 lib/md-editor/draft.ts 文件头）。 */
const DRAFT_KEY = 'blog-upload-editor';

export interface BlogFormBlog {
  id: string;
  title: string;
  description: string;
  categoryId: number | null;
  visibility: BlogVisibility;
  /** 是否允许匿名评论（作者可关，默认允许）。 */
  allowAnonymousComments: boolean;
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

  const editorRef = useRef<MarkdownEditorHandle>(null);
  const fallbackRef = useRef<HTMLTextAreaElement>(null);

  // 编辑器起不来时的兜底：一块普通 textarea（旧的 `#fallback-editor` 原样保留）。
  // 初始化失败时 MarkdownEditor 会把**当时该有的正文**（含刚恢复的草稿）回调出来，
  // 这里填进 textarea —— 否则用户看到的是空白，会以为正文丢了。
  const [initFailed, setInitFailed] = useState(false);
  const [fallbackValue, setFallbackValue] = useState(initialMarkdown);

  // 判据是 isReady() 而不是「ref 在不在」：初始化失败时 MarkdownEditor 渲染 null，
  // 但 useImperativeHandle 仍会在提交阶段把句柄挂上去 —— 只看 ref 就会读到编辑器里
  // 那份**初始化那一刻**的旧正文，用户在兜底 textarea 里改的字一个字都不会提交，
  // 而且页面上看不出任何异常。
  function getContent(): string {
    const editor = editorRef.current;
    if (editor?.isReady()) return editor.getDoc();
    return fallbackRef.current?.value ?? fallbackValue;
  }

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const title = (form.elements.namedItem('title') as HTMLInputElement).value;
    const description = (form.elements.namedItem('description') as HTMLTextAreaElement).value;
    const categoryId = (form.elements.namedItem('category') as HTMLSelectElement).value;
    const visibility = (form.elements.namedItem('visibility') as HTMLSelectElement).value;
    const allowAnonymousComments = (form.elements.namedItem('allowAnonymous') as HTMLInputElement)
      .checked;
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
        body: JSON.stringify({
          title,
          description,
          content,
          category_id: categoryId,
          visibility,
          allow_anonymous_comments: allowAnonymousComments,
        }),
      });
      const result = await response.json();
      if (result.code === 200) {
        // ★ 请求在飞的时候用户还能接着打字 ★ —— 那一段**没被发出去**。
        // 判据是「现在的正文还是不是提交时那一份」，不是时间先后：成功回调只说明
        // 「这一份发出去了」，不说明「编辑器里现在这一份发出去了」。
        const changedSinceSubmit = !isEdit && getContent() !== content;
        toast(
          isEdit ? '保存成功，正在返回...' : '上传成功！即将跳转到文章页面...',
          'success'
        );
        if (changedSinceSubmit) {
          // 这一页马上要跳走，那一段新改动只在编辑器里、不落盘就没了 ——
          // 先把它写进本地草稿，再如实告诉用户发出去的是哪一版。
          editorRef.current?.flushDraft();
          toast('发布的是提交那一刻的正文；提交之后你又改了一些，已留在本地草稿里', 'warning');
        } else if (!isEdit) {
          // 新建成功才清草稿 —— 编辑态用的是**服务端**那份正文，本来就没有本地草稿。
          // clearDraft 内部是「先停待写、再删键」，顺序写反会让延迟回调把刚发布的
          // 正文写回 localStorage（下次进新建页看到一篇已经发出去的旧文）。
          editorRef.current?.clearDraft();
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
        // 这里原先还有一行「编辑文章 ID: N」——文章 ID 是内部句柄，编辑者不需要它
        // （列表 / 阅读页都不显示），已删。这颗退回阅读页的按钮是这一行仅剩的内容，
        // 所以靠右对齐改成 justify-content-end：between 在只剩一个孩子时是左对齐的。
        <div className="d-flex justify-content-end align-items-center mb-3">
          <a href={`/blog/${blog!.id}`} className="button button-secondary">
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

        {/* 可见性：与栏目同构的一个 select（不另造单选组 —— 少一套样式与一条类名守卫）。
            三档的短语来自 ./blog-visibility 的 VISIBILITY_LABEL，一句话说明只在这里；
            **不在前端写死档名**：加第四档时前端会跟着长出来，不会静默少一个选项。 */}
        <div className="form-group">
          <label htmlFor="visibility" className="form-label">
            可见范围
          </label>
          <select
            className="form-select"
            id="visibility"
            name="visibility"
            defaultValue={blog?.visibility ?? 'internal'}
          >
            {BLOG_VISIBILITIES.map((v) => (
              <option key={v} value={v}>
                {VISIBILITY_LABEL[v]}
              </option>
            ))}
          </select>
          <span className="form-hint text-muted">
            仅站内可见：只有站内核心用户读得到（默认）。凭链接可读：拿到链接的任何人
            都能打开，但不会出现在任何列表里、也不会被搜索引擎收录。对外公开：任何人
            可读，可能被搜索引擎收录与第三方存档。
          </span>
          <span className="form-hint text-muted">
            公开前请自行确认正文里没有不适合外传的内容。公开后可能被第三方抓取存档，
            改回「仅站内可见」不会收回已经抓走的副本。
          </span>
        </div>

        {/* 匿名评论开关：作者对**自己的文章**的互动规则设置。
            默认勾上（本站口径：默认允许）。关掉只影响「以后能不能再匿名发」——
            已经发出的匿名评论不受影响（它们的化名序号冻在评论行上）。
            服务端闸门在 comment-service.createComment，这里只是让作者改得到。 */}
        <div className="form-group">
          <label className="form-label" htmlFor="allowAnonymous">
            匿名评论
          </label>
          <div className="form-check">
            <input
              type="checkbox"
              className="form-check-input"
              id="allowAnonymous"
              name="allowAnonymous"
              defaultChecked={blog?.allowAnonymousComments ?? true}
            />
            <label className="form-check-label" htmlFor="allowAnonymous">
              允许读者以化名匿名评论
            </label>
          </div>
          <span className="form-hint text-muted">
            匿名评论者在本文下始终显示同一个化名（第一位是 Alice，第二位是 Bob，以此类推），
            头像按化名生成。<strong>管理员</strong>仍能在管理日志里查到真实作者
            （你和读者都看不到）。
          </span>
        </div>

        <div className="form-group">
          <label className="form-label">
            内容（Markdown 格式）
          </label>
          {/* 只有新建页给草稿键：编辑态的正文是服务端那一份，本地草稿在编辑态既不读
              也不写 —— 否则「上个月新建到一半的半成品」会覆盖掉正在编辑的已发布文章。 */}
          {!banInfo && (
            <MarkdownEditor
              id="editor"
              ref={editorRef}
              initialValue={initialMarkdown}
              draftKey={isEdit ? undefined : DRAFT_KEY}
              title={blog?.title ?? ''}
              height="60vh"
              onNotify={toast}
              onInitError={(value) => {
                setFallbackValue(value);
                setInitFailed(true);
              }}
            />
          )}
          {initFailed && !banInfo && (
            <>
              <p id="fallback-message" className="form-text">
                Markdown 编辑器加载失败，已切换到基础文本输入框。
              </p>
              <textarea
                id="fallback-editor"
                ref={fallbackRef}
                className="form-control"
                rows={20}
                value={fallbackValue}
                onChange={(e) => setFallbackValue(e.target.value)}
                style={{ fontFamily: 'ui-monospace, monospace' }}
              />
            </>
          )}
        </div>

        <div className="actions">
          <button type="submit" className="button button-primary">
            {isEdit ? '保存修改' : '提交'}
          </button>
          {isEdit && (
            <a href={`/blog/${blog!.id}`} className="button button-secondary">
              取消
            </a>
          )}
        </div>
      </form>
    </section>
  );
}
