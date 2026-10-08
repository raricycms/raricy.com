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
import { useEffect, useRef, useState } from 'react';
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

/**
 * 表单里**所有会进请求的字段**。拍快照与「提交之后又改了没」都只认这一处 ——
 * 漏一个字段的后果是那一格被静默丢掉（用户改了标题、页面说「保存成功」，
 * 标题却没存上去，而正文那一格看起来一切正常）。
 */
interface FormFields {
  title: string;
  description: string;
  categoryId: string;
  visibility: string;
  allowAnonymousComments: boolean;
  content: string;
}

/** 字段 → 说给用户听的名字（提示里要能点名：改了**哪一格**没发出去）。 */
const FIELD_LABELS: ReadonlyArray<readonly [keyof FormFields, string]> = [
  ['title', '标题'],
  ['description', '摘要'],
  ['categoryId', '栏目'],
  ['visibility', '可见范围'],
  ['allowAnonymousComments', '匿名评论开关'],
  ['content', '正文'],
];

export default function BlogForm({ categories, blog = null, banInfo = null }: BlogFormProps) {
  const isEdit = !!blog;
  const initialMarkdown = blog?.contentMarkdown ?? '';

  const editorRef = useRef<MarkdownEditorHandle>(null);
  const fallbackRef = useRef<HTMLTextAreaElement>(null);
  // 标题是**受控**的：它既要进提交快照，又是导出件的文件名与 `<title>`
  // （见 MarkdownEditor 的 title 参数）—— 用 defaultValue 的话导出拿到的永远是
  // 进页面那一刻的旧标题（新建页则是空）。
  const [title, setTitle] = useState(blog?.title ?? '');
  /** 同一时刻只允许一笔提交在飞：新建态两笔 POST = 两篇文章。 */
  const savingRef = useRef(false);
  /**
   * 新建成功后**留在页面上**时会钉住的那篇文章（null = 这一页还没建出过文章）。
   *
   * 【为什么需要它】「有未保存的改动就不跳转」这条规则一旦对新建态成立，用户就会
   * 停在这一页接着改、再点一次提交 —— 而这一页在服务端已经有了自己的文章。若第二笔
   * 还是 POST，那就是**同一份内容发出第二篇**（列表里多一篇，页面只跳去其中一篇）。
   * 钉住 id 之后第二笔走 PUT：既把改动存进刚建出来的那一篇，又不会多发。
   * ⚠️ 钉的是**内存里**这一页的身份：刷新页面它会丢，用户再提交仍会新建一篇
   * ——这是刻意接受的（草稿横幅恢复的是「上次没发出去的正文」，服务端那一篇还在，
   * 用户从文章页看得见）。要根治得把「本页已建出的 id」也落进草稿，那是另一件事。
   */
  const [pinnedId, setPinnedId] = useState<string | null>(null);
  /** 延迟跳转的定时器。卸载时要清掉 —— 否则「已经离开这一页了还被它拽走」。 */
  const jumpTimerRef = useRef<number | null>(null);
  /** 组件是否还挂着（异步回调据此判断「这一页还在不在」）。 */
  const aliveRef = useRef(true);

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

  /** 取此刻表单里所有会进请求的字段。 */
  function readFields(form: HTMLFormElement): FormFields {
    return {
      title: (form.elements.namedItem('title') as HTMLInputElement).value,
      description: (form.elements.namedItem('description') as HTMLTextAreaElement).value,
      categoryId: (form.elements.namedItem('category') as HTMLSelectElement).value,
      visibility: (form.elements.namedItem('visibility') as HTMLSelectElement).value,
      allowAnonymousComments: (form.elements.namedItem('allowAnonymous') as HTMLInputElement)
        .checked,
      content: getContent(),
    };
  }

  /** 相对快照改了哪几格（说人话的名字；没改就是空数组）。 */
  function changedLabels(snapshot: FormFields, current: FormFields): string[] {
    return FIELD_LABELS.filter(([key]) => snapshot[key] !== current[key]).map(([, label]) => label);
  }

  // 卸载 = 这一页已经不在了。此时既不该再弹提示，也不该再跳转 ——
  // 尤其是那个 800 / 1500ms 的延迟跳转：用户已经点了别处，它还会把人拽走。
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      if (jumpTimerRef.current !== null) {
        window.clearTimeout(jumpTimerRef.current);
        jumpTimerRef.current = null;
      }
    };
  }, []);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;

    // ★ 提交不能叠着发 ★ 上一次还在飞的时候再点一次，新建态就是**两篇文章**
    // （页面只跳去其中一篇，另一篇留在列表里，而用户根本没意识到自己发了两篇）。
    if (savingRef.current) {
      toast('正在提交，请稍候', 'warning');
      return;
    }

    // ★ 先把上一笔留下的待跳转定时器撤掉 ★
    // 上一笔成功之后排了一个 800 / 1500ms 的跳转；现在又开始新的一笔，那枚旧定时器
    // 只认「上一次的快照」，会在这一笔还在飞的时候把页面抢走 —— 用户看到的是
    // 「刚点提交，页面自己跳走了」，而这一笔的结果再也看不到（它回来后 aliveRef
    // 已经是 false，连提示都不会有）。
    if (jumpTimerRef.current !== null) {
      window.clearTimeout(jumpTimerRef.current);
      jumpTimerRef.current = null;
    }

    // 提交的是**这一刻**的表单：之后不管用户怎么改，成功回调都用这一份做判断。
    const snapshot = readFields(form);
    const { title, description, categoryId, visibility, allowAnonymousComments, content } =
      snapshot;

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

    savingRef.current = true;
    try {
      // 这一笔要写的是**哪一篇**：编辑态是服务端给的那篇；新建态若是「提交过一次、
      // 有改动因而留在页面上」的那一篇，就是它（见 pinnedId 的说明）。
      const targetId = blog?.id ?? pinnedId;
      const url = targetId ? `/api/blogs/${targetId}` : '/api/blogs';
      const method = targetId ? 'PUT' : 'POST';
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
      // 这一页可能已经不在了（用户点了别处）——那就什么也别做：不再弹提示，
      // 更不跳转。跳转会把人从**他现在这一页**上拽走。
      if (!aliveRef.current) return;
      if (result.code !== 200) {
        toast('操作失败: ' + result.message, 'error');
        return;
      }

      // 新建的第一笔成功之后，把这一页钉在这篇文章上（见 pinnedId 的说明）：
      // 之后再点提交是 PUT 它，而不是又发一篇。编辑态本来就钉着服务端那篇。
      const targetBlogId: string | null =
        targetId ?? (typeof result.blog_id === 'string' ? result.blog_id : null);
      if (!targetId && targetBlogId) setPinnedId(targetBlogId);

      // ★ 请求在飞的时候用户还能接着改 ★ —— 判据是**整份表单快照**，不是时间先后：
      // 成功回调只说明「这一份发出去了」，不说明「页面上现在这一份发出去了」。
      // 也**不是只比正文**：改了标题 / 摘要 / 可见范围而正文没动，同样没发出去。
      const changed = changedLabels(snapshot, readFields(form));
      const bodyChanged = changed.includes('正文');

      if (!isEdit && bodyChanged) {
        // 新建页有本地草稿，正文那一版接得住：先把它落盘再如实说明。
        editorRef.current?.flushDraft();
      } else if (!isEdit) {
        // 新建成功、又没有后续改动才清草稿 —— 编辑态用的是**服务端**那份正文，
        // 本来就没有本地草稿。clearDraft 内部是「先停待写、再删键」，顺序写反会让
        // 延迟回调把刚发布的正文写回 localStorage（下次进新建页看到一篇已发出去的旧文）。
        editorRef.current?.clearDraft();
      }

      if (changed.length > 0) {
        // ★ 有未保存的改动就**不跳** ★ 判据是整份快照，与编辑态同一条规则：
        // 跳走等于把这一段一起丢掉，而标题 / 摘要 / 栏目 / 可见范围 / 匿名开关
        // **没有草稿接得住**（草稿只存正文）。留在这儿，用户接着改、再点一次提交
        // 就能存上 —— 新建态此时已经钉在刚建出来的那一篇上（见 pinnedId），
        // 所以「再点一次」是更新，不会多出一篇。
        // ⚠️ 这一句必须**点名改了哪几格**：混成一句「有些改动没保存」等于让他自己猜；
        // 也只有正文那一版能说「草稿里有」。
        toast(
          `已保存的是提交那一刻的${changed.join('、')}；之后的改动还没保存 —— ` +
            `已留在页面上，请再保存一次` +
            (!isEdit && bodyChanged ? '（正文那一版也已留在本地草稿里）' : ''),
          'warning'
        );
        return;
      }

      toast(isEdit ? '保存成功，正在返回...' : '上传成功！即将跳转到文章页面...', 'success');

      // 延迟跳转：给用户一点时间看到提示。**这一段时间里还能继续改**，所以跳之前
      // 再核对一次 —— 否则「看着提示、顺手改了一个字」的那一段会随跳转一起消失。
      jumpTimerRef.current = window.setTimeout(
        () => {
          jumpTimerRef.current = null;
          if (!aliveRef.current) return;
          const late = changedLabels(snapshot, readFields(form));
          if (late.length > 0) {
            // ★ 同样不跳 ★ 这是上一版漏掉的那一半：这里只弹一句提示、然后照样
            // `window.location.href`，用户看着提示的同时页面就跳走了 —— 改动与提示
            // 一起消失，只留下一个「好像闪过什么」的印象。
            const lateBody = late.includes('正文');
            if (!isEdit && lateBody) editorRef.current?.flushDraft();
            toast(
              `你又改了${late.join('、')} —— 这一版还没保存，已留在页面上，请再保存一次` +
                (!isEdit && lateBody ? '（正文那一版也已留在本地草稿里）' : ''),
              'warning'
            );
            return;
          }
          // 地址取自**这一次响应**（不是页面上后来的任何状态）
          if (targetBlogId) window.location.href = result.redirect || `/blog/${targetBlogId}`;
        },
        isEdit ? 800 : 1500
      );
    } catch {
      if (aliveRef.current) toast('出现错误，请稍后重试', 'error');
    } finally {
      savingRef.current = false;
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
            value={title}
            onChange={(e) => setTitle(e.target.value)}
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
              // 导出件的文件名与 `<title>` 读的是**此刻**的标题（不是进页面那一刻的）
              title={title}
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
          {/* 「已经建出过一篇、现在是留在页面上改它」时按钮改口叫保存修改：
              这时再点提交走的是 PUT（见 pinnedId），文案说「提交」会让人以为
              又要发一篇新的，于是不敢点。 */}
          <button type="submit" className="button button-primary">
            {isEdit || pinnedId ? '保存修改' : '提交'}
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
