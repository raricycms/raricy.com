'use client';

// 云剪贴板 上传/编辑表单
//
// - 编辑器：vditor（与 BlogForm 对齐，vditor@3.10.7），icon sprite + KaTeX 从
//   /static/vditor 本地加载，避免运行时依赖 unpkg。
// - Math（LaTeX）：开启 preview.math（KaTeX 引擎），IR 模式下输入 $$..$$ 即可见渲染。
// - 提交：新建 → POST /api/clipboard；编辑 → PUT /api/clipboard/:id。
// - 保留 Flask 行为：Ctrl/⌘+S 手动保存（编辑态）、autoSave 每分钟自动保存、
//   publicity 是否公开。
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import Vditor from 'vditor';
import 'vditor/dist/index.css';
// 跟随站点 <html data-theme> 的亮/暗切换 —— 与 BlogForm 共用同一份实现
// （本地 CDN 常量也在这里），避免两边漂移。
import {
  VDITOR_LOCAL_CDN,
  applyVditorTheme,
  isDarkTheme,
  removeHljsTheme,
  syncHljsTheme,
  vditorThemeOptions,
  watchVditorTheme,
} from '@/lib/vditor-theme';
// 上传配置（fieldName / 响应结构两端对齐）—— 与博客编辑器共用，见该文件头注释
import { vditorUploadOptions } from '@/lib/vditor-upload';

function toast(msg: string, type: string) {
  if (typeof window === 'undefined') return;
  const w = window as unknown as { showToast?: (m: string, t: string) => void };
  if (w.showToast) w.showToast(msg, type);
}

export interface EditClip {
  id: string;
  title: string;
  content: string;
  publicity: boolean;
}

export default function UploadForm({ clip }: { clip?: EditClip }) {
  const router = useRouter();
  const isEdit = !!clip;

  const [title, setTitle] = useState(clip?.title ?? '');
  const [content, setContent] = useState(clip?.content ?? '');
  const [publicity, setPublicity] = useState(clip ? clip.publicity : true);
  const [autoSave, setAutoSave] = useState(false);

  // vditor 句柄 + 加载状态；fallback 文本框给 vditor 加载失败时用。
  const vditorRef = useRef<Vditor | null>(null);
  const vditorLoadedRef = useRef(false);
  const editorDivRef = useRef<HTMLDivElement>(null);
  const fallbackMsgRef = useRef<HTMLParagraphElement>(null);
  const fallbackRef = useRef<HTMLTextAreaElement>(null);

  const titleRef = useRef(title);
  const contentRef = useRef(content);
  const publicityRef = useRef(publicity);
  titleRef.current = title;
  contentRef.current = content;
  publicityRef.current = publicity;

  // 取最新内容：优先 vditor，回退 fallback 文本框。
  function getContent(): string {
    if (vditorLoadedRef.current && vditorRef.current) {
      return vditorRef.current.getValue();
    }
    return fallbackRef.current?.value ?? contentRef.current ?? '';
  }

  async function saveClipboard(stayOnPage: boolean) {
    const data = {
      title: titleRef.current.trim(),
      // vditor 在编辑模式会保留标题外的 markdown 文本；fallback 时直接读 textarea。
      content: getContent(),
      publicity: publicityRef.current,
    };

    if (!data.title || !data.content) {
      toast('标题和正文不能为空', 'warning');
      return;
    }
    if (data.title.length > 30) {
      toast('标题不能超过30个字符', 'warning');
      return;
    }
    if (data.content.length > 250000) {
      toast('正文不能超过250000个字符', 'warning');
      return;
    }

    try {
      // 编辑态命中 PUT /api/clipboard/[id]（对齐 Flask POST /clipboard/<id>/edit）；
      // 新建态命中 POST /api/clipboard（对齐 Flask POST /clipboard/upload）。
      const url = isEdit ? `/api/clipboard/${clip!.id}` : '/api/clipboard';
      const method = isEdit ? 'PUT' : 'POST';
      const response = await fetch(url, {
        method,
        headers: {
          'Content-Type': 'application/json',
        },
        credentials: 'same-origin',
        body: JSON.stringify(data),
      });
      const result = await response.json();
      if (response.ok && result.code === 200) {
        if (stayOnPage) {
          toast('保存成功！', 'success');
          // 编辑态保存后清空 vditor 之外的文案 cache 不必要；保留即可。
        } else {
          router.push(`/clipboard/${result.id}`);
        }
      } else {
        const msg = result.message || '未知错误';
        if (stayOnPage) {
          toast(`保存失败：${msg}`, 'error');
        } else {
          alert(`上传失败，原因：${msg}`);
        }
      }
    } catch (error) {
      console.error(error);
      const msg = '出错了qaq，快去找raricy';
      if (stayOnPage) {
        toast(msg, 'error');
      } else {
        alert(msg);
      }
    }
  }

  // 用 ref 持有最新的 save 函数，供定时器与快捷键调用。
  const saveRef = useRef(saveClipboard);
  saveRef.current = saveClipboard;

  // Ctrl+S / Cmd+S 手动保存（新建态与编辑态一致）。
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        void saveRef.current(true);
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);

  // 编辑态：从 localStorage 读取「自动保存」偏好。
  useEffect(() => {
    if (!isEdit) return;
    setAutoSave(localStorage.getItem('clipboard_autosave_enabled') === 'true');
  }, [isEdit]);

  // 编辑态：开启后每分钟自动保存一次。
  useEffect(() => {
    if (!isEdit || !autoSave) return;
    const timer = setInterval(() => {
      void saveRef.current(true);
    }, 60000);
    return () => clearInterval(timer);
  }, [isEdit, autoSave]);

  // 初始化 vditor —— 与 BlogForm 用同一份本地 CDN，开启 math（KaTeX）支持。
  useEffect(() => {
    let cancelled = false;
    let unwatchTheme: (() => void) | null = null;

    function showFallback() {
      if (editorDivRef.current) editorDivRef.current.style.display = 'none';
      if (fallbackMsgRef.current) fallbackMsgRef.current.style.display = 'block';
      const fb = fallbackRef.current;
      if (fb) {
        fb.style.display = 'block';
        if (!fb.value && contentRef.current) fb.value = contentRef.current;
      }
      vditorLoadedRef.current = false;
    }

    try {
      if (cancelled) return;
      const dark = isDarkTheme();
      const { theme, contentTheme } = vditorThemeOptions(dark);
      // 必须在 new Vditor 之前 —— 靠 addStyle 的 id 去重接管代码高亮那条轨道
      syncHljsTheme(dark);
      vditorRef.current = new Vditor('clipboard-editor', {
        minHeight: 400,
        mode: 'ir',
        cdn: VDITOR_LOCAL_CDN,
        theme,
        // 启用 LaTeX：IR 模式下输入 $$..$$ 立即用本地 KaTeX 渲染。
        preview: { math: { engine: 'KaTeX' }, theme: { current: contentTheme } },
        toolbar: [
          'emoji', 'headings', 'bold', 'italic', 'strike', 'link', '|',
          'list', 'ordered-list', 'check', 'outdent', 'indent', '|',
          'quote', 'line', 'code', 'inline-code', 'math', 'upload', 'table', '|',
          'undo', 'redo', 'preview', 'export',
        ],
        counter: { enable: true, type: 'text' },
        upload: vditorUploadOptions((msg) => toast(msg, 'error')),
        cache: isEdit ? { enable: false } : { enable: true, id: 'clipboard-upload-editor' },
        value: contentRef.current ?? '',
      });
      vditorLoadedRef.current = true;
    } catch {
      showFallback();
    }

    if (vditorLoadedRef.current) {
      unwatchTheme = watchVditorTheme((dark) => applyVditorTheme(vditorRef.current, dark));
    }

    return () => {
      cancelled = true;
      unwatchTheme?.();
      // 该 <link> 挂在 head 上是全局的，留着会盖掉文章页 MarkdownRenderer 的 hljs 主题
      removeHljsTheme();
      // 销毁 vditor 实例，避免 React 严格模式 / 路由切换后节点还在内存里。
      try {
        vditorRef.current?.destroy?.();
      } catch {
        /* noop */
      }
      vditorRef.current = null;
      vditorLoadedRef.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    // 提交前停止自动保存（对齐 Flask stopAutoSave()）。
    setAutoSave(false);
    await saveClipboard(false);
  }

  function onToggleAutoSave(checked: boolean) {
    localStorage.setItem('clipboard_autosave_enabled', String(checked));
    setAutoSave(checked);
  }

  return (
    <div className="clipboard-page">
      <h1 className="clipboard-title">
        {isEdit ? `${clip!.title} 文章编辑` : '上传云剪贴板'}
      </h1>

      {isEdit && (
        <div className="clipboard-form__reminder">
          提示：编辑过程中可按 <kbd>Ctrl+S</kbd> 手动保存，以免内容丢失。也可以勾选下方
          {'"自动保存"'}开关，每分钟自动保存一次。
          <br />
          支持 Markdown 与 LaTeX（<code>$inline$</code> / <code>{'$$block$$'}</code>）。
        </div>
      )}

      {!isEdit && (
        <div className="clipboard-form__reminder">
          支持 Markdown 与 LaTeX（<code>$inline$</code> / <code>{'$$block$$'}</code>）。
        </div>
      )}

      <div className="clipboard-form">
        <form id="uploadForm" onSubmit={onSubmit}>
          <div className="clipboard-form__group">
            <label htmlFor="title">标题</label>
            <input
              type="text"
              id="title"
              name="title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="请输入标题"
              required
            />
          </div>

          <div className="clipboard-form__group">
            <label htmlFor="clipboard-editor">正文（支持 Markdown 与 LaTeX）</label>
            <div
              id="clipboard-editor"
              ref={editorDivRef}
              style={{
                height: '50vh',
                background: 'var(--color-background-page)',
                border: '1px solid var(--color-border)',
                borderRadius: '8px',
              }}
            />
            <p
              id="clipboard-editor-fallback-message"
              ref={fallbackMsgRef}
              className="clipboard-form__reminder"
              style={{ display: 'none', marginTop: '8px' }}
            >
              Markdown 编辑器加载失败，已切换到基础文本输入框。
            </p>
            <textarea
              id="clipboard-editor-fallback"
              ref={fallbackRef}
              rows={15}
              placeholder="请输入正文内容"
              style={{
                display: 'none',
                width: '100%',
                padding: 'var(--space-3, 12px)',
                border: '1px solid var(--color-border)',
                borderRadius: '8px',
                background: 'var(--color-background-card)',
                color: 'var(--color-text-primary)',
                fontSize: '1rem',
                lineHeight: 1.6,
                fontFamily: 'ui-monospace, monospace',
              }}
            />
          </div>

          <div className="clipboard-form__group clipboard-form__group--checkbox">
            <input
              type="checkbox"
              id="publicity"
              name="publicity"
              checked={publicity}
              onChange={(e) => setPublicity(e.target.checked)}
            />
            <label htmlFor="publicity">是否公开</label>
          </div>

          {isEdit && (
            <div className="clipboard-form__group clipboard-form__group--checkbox">
              <input
                type="checkbox"
                id="autoSaveToggle"
                name="autoSave"
                checked={autoSave}
                onChange={(e) => onToggleAutoSave(e.target.checked)}
              />
              <label htmlFor="autoSaveToggle">自动保存（每分钟）</label>
            </div>
          )}

          <button type="submit" className="clipboard-form__submit">
            {isEdit ? '更新' : '提交'}
          </button>
        </form>
      </div>
    </div>
  );
}
