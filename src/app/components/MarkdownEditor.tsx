'use client';

// ─────────────────────────────────────────────────────────────────────────────
// MarkdownEditor.tsx —— CodeMirror 6 源码编辑器 + 整篇只读预览（博客 / 剪贴板共用）
//
// 【职责边界】只管「编辑、预览、上传、导出」；提交接口、长度校验、可见性、禁言
// 判定、剪贴板的 Ctrl+S 与每分钟自动保存**仍归各自的表单**（§5.3）。表单通过
// `ref.getDoc()` 同步取最新原文 —— 绝不从防抖后的预览状态取提交内容。
//
// 【预览永远挂载】预览面板不做懒挂载，代价是每次防抖后都要跑一遍整篇渲染，
// 换来三件事：切到「并排 / 预览」是瞬时的（没有加载态闪烁）、导出能直接读屏幕上
// 那棵 DOM（导出件与所见逐字一致）、没有「导出时预览还没渲染完」的竞态。
// 引用取数有会话级缓存（ContentRefResolver），同样的引用不会因重渲染重复请求。
//
// 【预览是只读的】`interactive={false}` —— 投票小组件的按钮全部禁用、不发任何
// 业务写请求（M0 就钉住了，见 blog-content-dom.ts）。预览里点不动任何东西。
//
// 【主题】编辑器配色全走站点 CSS 变量，不需要监听 `data-theme`（见 cm-theme.ts）。
// 预览里的代码高亮由 MarkdownRenderer 自己的 useHljsThemeStyles 跟随。
// ─────────────────────────────────────────────────────────────────────────────

import {
  forwardRef,
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useReducer,
  useRef,
  useState,
} from 'react';
import {
  EditorState,
  type Extension,
} from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { RefreshCw } from 'lucide-react';

import Toolbar, { VIEW_MODES } from './markdown-editor/Toolbar';
import ResourcePanel from './markdown-editor/ResourcePanel';
import { editorBaseTheme } from './markdown-editor/cm-theme';
import {
  absolutizeSiteUrls,
  buildExportHtml,
  downloadHtml,
  localizeFragmentLinks,
  printHtml,
  safeFilename,
  stripInteractiveShells,
} from './markdown-editor/export';
import MarkdownRenderer from './MarkdownRenderer';
import { ContentRefProcessor } from '@/lib/content-ref-processor';
import { ContentRefResolver } from '@/lib/content-ref-resolver';
import { renderBlogMarkdown } from '@/lib/blog-renderer';
import { enhanceBlogContent } from '@/lib/blog-content-dom';
import { IMAGE_ACCEPT, uploadImageFile } from '@/lib/image-client';
import * as cmd from '@/lib/md-editor/commands';
import { createDraftStore, type DraftStore } from '@/lib/md-editor/draft';
import { createInsertAnchor, type InsertAnchor } from '@/lib/md-editor/insert-anchor';
import {
  addUploadBatch,
  batchInsertPos,
  cancelUploadBatch,
  settleUploadSlot,
  uploadBatchField,
  uploadChipDecorations,
} from '@/lib/md-editor/upload-anchors';
import {
  MAX_CONCURRENT_UPLOADS,
  gateUploadBatch,
  imageMarkdown,
  isAcceptableImage,
  normalizeDroppedFiles,
  precheckFile,
  runLimited,
} from '@/lib/md-editor/upload';

/** 预览防抖：停手一小会儿再整篇渲染，避免每敲一个字跑一遍整篇管线。 */
const PREVIEW_DEBOUNCE_MS = 400;

/**
 * 并排视图在窄屏下没有意义（两栏各自不到 300px）。两处用到这个阈值，值必须一致：
 * 样式表把「并排」那颗按钮整个藏掉（`.md-editor__mode--split`，`_markdown-editor.scss`），
 * 这里负责视口在编辑途中变窄时把已经选中的并排退回编辑态。
 */
const SPLIT_MIN_WIDTH = 768;

type ViewMode = 'edit' | 'split' | 'preview';

export interface MarkdownEditorHandle {
  /** 最新原文（同步）。提交与草稿都从这里取。 */
  getDoc(): string;
  /** 能否用编辑器（false = 已回退到 textarea，调用方改用 textarea 取值）。 */
  isReady(): boolean;
  /** 发布成功后清草稿：先停待写再删键，顺序在 DraftStore 里保证。 */
  clearDraft(): void;
  /** 立刻把待写的草稿落盘（提交前用）。 */
  flushDraft(): void;
  /** 聚焦编辑区。 */
  focus(): void;
}

export interface MarkdownEditorProps {
  /** 外壳的 id（`editor` / `clipboard-editor`）—— 表单与 e2e 的元素钩子。 */
  id?: string;
  /** 初始正文。 */
  initialValue: string;
  /**
   * 新建页的草稿键（`blog-upload-editor` / `clipboard-upload-editor`）。
   * **编辑态不要传** —— 编辑态既不读也不写新建草稿（§5.2）。
   */
  draftKey?: string;
  /** 文档标题（导出文件名与 `<title>`）。 */
  title?: string;
  /** 是否给公式按钮（剪贴板有、博客没有）。 */
  withMath?: boolean;
  /** 编辑区高度（CSS 值）。 */
  height?: string;
  /** CM6 初始化失败 —— 调用方把 textarea 回退显示出来，并用这个初值填进去。 */
  onInitError?: (initialValue: string) => void;
  /** 提示（上传失败、草稿冲突等）。由表单提供，保证每页只有一条 toast 通道。 */
  onNotify?: (message: string, type: 'error' | 'warning' | 'success') => void;
}

const MarkdownEditor = forwardRef<MarkdownEditorHandle, MarkdownEditorProps>(
  function MarkdownEditor(
    {
      id,
      initialValue,
      draftKey,
      title = '',
      withMath = false,
      height = '60vh',
      onInitError,
      onNotify,
    },
    ref
  ) {
    const hostRef = useRef<HTMLDivElement>(null);
    const previewBodyRef = useRef<HTMLDivElement>(null);
    /** 键盘提示的 id（编辑区用 aria-describedby 指过来）。 */
    const kbHintId = useId();
    const fileInputRef = useRef<HTMLInputElement>(null);
    const viewRef = useRef<EditorView | null>(null);
    const [view, setView] = useState<EditorView | null>(null);
    const [mode, setMode] = useState<ViewMode>('edit');
    const [refreshToken, setRefreshToken] = useState(0);
    const [previewDoc, setPreviewDoc] = useState(initialValue);
    // 正文改动后强制重算字数 / 撤销态。正文本身留在 CM6 的 state 里，
    // 不搬进 React state —— 25 万字的字符串每敲一下都过一遍 state 没意义。
    const [, bump] = useReducer((n: number) => n + 1, 0);

    /** 会话级引用缓存：跨预览重渲染复用，编辑器销毁即释放（§5.1）。 */
    const resolverRef = useRef<ContentRefResolver | null>(null);
    if (!resolverRef.current) resolverRef.current = new ContentRefResolver('expand');

    const draftRef = useRef<DraftStore | null>(null);
    const [draftChoice, setDraftChoice] = useState<string | null>(null);
    const [initFailed, setInitFailed] = useState(false);

    /** 已取消 / 已销毁的批次 —— 迟到的上传结果据此丢弃，绝不插回正文。 */
    const abortedRef = useRef(new Set<number>());
    /**
     * 「插入引用」面板的落点。面板打开期间正文仍会变（上传完成、撤销），
     * 所以它必须按 change desc 映射（见 lib/md-editor/insert-anchor.ts）。
     */
    const insertAnchorRef = useRef<InsertAnchor | null>(null);
    const [resourcesOpen, setResourcesOpen] = useState(false);
    const destroyedRef = useRef(false);
    const batchSeqRef = useRef(0);
    const previewTimerRef = useRef<number | null>(null);
    const docRef = useRef(initialValue);
    const modeRef = useRef<ViewMode>('edit');
    modeRef.current = mode;

    const notify = useCallback(
      (message: string, type: 'error' | 'warning' | 'success' = 'error') => {
        onNotify?.(message, type);
      },
      [onNotify]
    );

    // ── 草稿：决定初始正文 ───────────────────────────────────────────────────
    // 读一次就定下来（后面由 CM6 接管），所以放在 ref 里而不是 state。
    const resolvedInitialRef = useRef(initialValue);
    if (draftRef.current === null && draftKey) {
      // 只在第一轮渲染时读；创建的 store 也一直留着给后续的防抖写入用
      const store = createDraftStore(draftKey, {
        onUnavailable: () => notify('浏览器不允许保存本地草稿，本次编辑不会被自动保留', 'warning'),
      });
      draftRef.current = store;
      const read = store.read();
      if (read.ok && read.value && read.value !== initialValue) {
        if (!initialValue) {
          // 新建页没有服务端初值 —— 直接恢复，不问（这是绝大多数情况）
          resolvedInitialRef.current = read.value;
        } else {
          // 两份都有内容：不静默覆盖任何一份，交给用户在横幅里选
          setDraftChoice(read.value);
        }
      }
    }
    // ⚠️ **只赋一次**。`docRef` 是「当前正文」的镜像，之后由 CM6 的 updateListener
    // 每次改动刷新；这一行放在渲染体里无条件跑的话，**任何一次重渲染都会把它倒回
    // 初值**。表现是静默的：打完字点「预览」/「并排」，那一下读的正是这个 ref，
    // 于是预览被刷成一篇**空文档**（防抖那一路明明是对的，被这一下覆盖掉）。
    // 字数统计不受影响 —— 它读的是 `view.state.doc.length`，所以页面上「N 字」
    // 一切正常，只有预览是空的。
    const docInitializedRef = useRef(false);
    if (!docInitializedRef.current) {
      docInitializedRef.current = true;
      docRef.current = resolvedInitialRef.current;
    }

    // ── 预览防抖 ────────────────────────────────────────────────────────────
    const schedulePreview = useCallback((text: string, immediate = false) => {
      if (previewTimerRef.current !== null) {
        window.clearTimeout(previewTimerRef.current);
        previewTimerRef.current = null;
      }
      if (immediate) {
        setPreviewDoc(text);
        return;
      }
      previewTimerRef.current = window.setTimeout(() => {
        previewTimerRef.current = null;
        setPreviewDoc(text);
      }, PREVIEW_DEBOUNCE_MS);
    }, []);

    // ── 上传 ────────────────────────────────────────────────────────────────
    const settleSlot = useCallback(
      (batchId: number, index: number, length: number, message?: string) => {
        const v = viewRef.current;
        if (!v || destroyedRef.current) return;
        v.dispatch({
          effects: settleUploadSlot.of({
            batchId,
            key: `${batchId}:${index}`,
            length,
            message,
          }),
        });
      },
      []
    );

    const startUpload = useCallback(
      (candidates: File[], pos: number) => {
        const v = viewRef.current;
        if (!v || destroyedRef.current) return;
        const gate = gateUploadBatch(candidates);
        if (!gate.ok) {
          notify(gate.message, 'warning');
          return;
        }
        if (gate.files.length === 0) return;

        const batchId = (batchSeqRef.current += 1);
        v.dispatch({
          effects: addUploadBatch.of({
            id: batchId,
            pos,
            names: gate.files.map((f) => f.name || 'image'),
          }),
        });

        void runLimited(gate.files, MAX_CONCURRENT_UPLOADS, async (file, index) => {
          const key = `${batchId}:${index}`;
          const rejected = precheckFile(file);
          if (rejected) {
            settleSlot(batchId, index, 0, rejected);
            notify(`${file.name || '图片'}：${rejected}`, 'error');
            return;
          }
          const result = await uploadImageFile(file);
          // 迟到的结果：批次被取消、或者编辑器已经卸载 —— 直接丢弃。
          // 图床里的东西照旧留着（服务端已经收了），不靠删素材来补偿一次取消的编辑。
          if (destroyedRef.current || abortedRef.current.has(batchId)) return;
          if (!result.ok) {
            settleSlot(batchId, index, 0, result.message);
            notify(`${file.name || '图片'}：${result.message}`, 'error');
            return;
          }
          const markdown = imageMarkdown(file.name || 'image.png', result.url);
          const live = viewRef.current;
          if (!live) return;
          const at = batchInsertPos(live.state, batchId, index);
          if (at === null) return; // 批次已退场（整批取消）—— 不插
          live.dispatch({
            changes: { from: at, insert: markdown },
            effects: settleUploadSlot.of({ batchId, key, length: markdown.length }),
          });
        });
      },
      [notify, settleSlot]
    );

    const cancelBatch = useCallback((batchId: number) => {
      abortedRef.current.add(batchId);
      const v = viewRef.current;
      v?.dispatch({ effects: cancelUploadBatch.of(batchId) });
    }, []);

    // ── 资源面板（图床 / 音频 / 剪贴板 / 投票 / 收藏夹）────────────────────────
    const openResources = useCallback(() => {
      const v = viewRef.current;
      if (!v) return;
      const anchor = insertAnchorRef.current ?? (insertAnchorRef.current = createInsertAnchor());
      // 落点 = 打开面板那一刻的主选区表头。面板是模态的、用户点不动编辑区，
      // 但**上传会插进正文**，所以之后每次改动都要把落点映射过去。
      anchor.capture(v.state.selection.main.head);
      setResourcesOpen(true);
    }, []);

    const closeResources = useCallback(() => {
      insertAnchorRef.current?.clear();
      setResourcesOpen(false);
      // 焦点还给编辑区：Esc 关掉面板之后接着打字，不该还要再点一下正文
      viewRef.current?.focus();
    }, []);

    const insertResource = useCallback((text: string) => {
      const v = viewRef.current;
      const anchor = insertAnchorRef.current;
      if (!v || !anchor) return;
      const raw = anchor.get() ?? v.state.selection.main.head;
      const at = Math.max(0, Math.min(raw, v.state.doc.length));
      v.dispatch({
        changes: { from: at, insert: text },
        selection: { anchor: at + text.length },
        scrollIntoView: true,
      });
      // 落点重设到插入内容之后（**显式赋绝对值**，不依赖 mapPos 的 assoc 语义：
      // 「连续插两条会不会反序」不该由一行注释之外的东西决定）
      anchor.capture(at + text.length);
      setResourcesOpen(false);
      v.focus();
    }, []);

    // ── CM6 生命周期 ────────────────────────────────────────────────────────
    useEffect(() => {
      const host = hostRef.current;
      if (!host) return;
      destroyedRef.current = false;

      const extensions: Extension[] = [
        history(),
        // 不加这一条，EditorState.create 会把多选区**静默压成一个**（asSingle()）——
        // 于是 Alt+点出来的第二个光标、以及列选择，会在下一次状态重建时消失，
        // 而工具条里的命令本来是按「逐区间」写的（见 commands.ts）。
        EditorState.allowMultipleSelections.of(true),
        /**
         * 键盘用户走出编辑区的唯一出口。
         *
         * CodeMirror 自己实现了一条：**先按 Escape，再按 Tab**（两秒内）焦点就交给
         * 下一个可聚焦元素 —— 按下 Escape 时它把 `tabFocusMode` 置成 now+2000，
         * 这期间放行 Tab 的默认行为（见 @codemirror/view 的 input.ts）。
         * ⚠️ **我们一条 Escape 键处理都不写**：再绑一次就会把这条原生路径盖掉，
         * 而编辑器默认吃掉 Tab（indentWithTab 拿它缩进），盖掉的后果是键盘用户
         * 被关在正文里出不来。所以要做的只是**把它说出来**（下面那句提示）。
         */
        EditorView.contentAttributes.of({ 'aria-describedby': kbHintId }),
        EditorView.lineWrapping,
        markdown(),
        ...editorBaseTheme,
        uploadBatchField,
        uploadChipDecorations,
        // 自定义键放在默认键位表**前面**：同一组键位里先出现的先匹配。
        // Ctrl/Cmd+S **刻意不绑** —— 剪贴板的保存由表单那一个页面级监听负责，
        // 两边都绑就会对同一次按键发两遍保存请求（§5.3）。
        keymap.of([
          { key: 'Mod-b', run: cmd.toggleWrap('**', '粗体') },
          { key: 'Mod-i', run: cmd.toggleWrap('*', '斜体') },
          { key: 'Mod-Shift-x', run: cmd.toggleWrap('~~', '删除线') },
          { key: 'Mod-e', run: cmd.toggleWrap('`', 'code') },
          { key: 'Mod-k', run: cmd.insertLink() },
          ...defaultKeymap,
          ...historyKeymap,
          indentWithTab,
        ]),
        EditorView.updateListener.of((update) => {
          if (!update.docChanged) return;
          // 面板开着的时候正文也会变（在飞的上传落进正文、用户按了撤销）：
          // 落点跟着改动走，否则面板里挑的那条会插到别处去。
          insertAnchorRef.current?.map(update.changes);
          const text = update.state.doc.toString();
          docRef.current = text;
          bump();
          schedulePreview(text);
          draftRef.current?.schedule(text);
        }),
        EditorView.domEventHandlers({
          /**
           * 粘贴。**文本优先**：剪贴板里只要有纯文本，一律交回 CM6 的默认行为
           * （它只插 `text/plain`，不会拿 HTML 去补围栏或改写 Markdown）。
           * 只有「一点文本都没有、但有图片文件」时才当成图片粘贴 —— 这条顺序
           * 保证不会为了找图片而阻断一次正常的文字粘贴（§1.2）。
           */
          paste(event, v) {
            const data = event.clipboardData;
            if (!data) return false;
            if (data.getData('text/plain') || data.getData('text/uri-list')) return false;
            const { files } = normalizeDroppedFiles(data.files);
            const images = files.filter(isAcceptableImage);
            if (images.length === 0) return false;
            event.preventDefault();
            startUpload(images, v.state.selection.main.head);
            return true;
          },
          /**
           * 拖拽。**必须拦下图片文件**：CM6 默认对拖进来的文件是「读出它的文本内容
           * 再插入」（input.ts 的 handlers.drop），图片二进制会被读成乱七八糟的字符
           * 塞进正文。非图片的拖拽一律放行 —— 站内拖动选中文字要靠它。
           */
          drop(event, v) {
            const dt = event.dataTransfer;
            if (!dt) return false;
            const { files } = normalizeDroppedFiles(dt.files);
            const images = files.filter(isAcceptableImage);
            if (images.length === 0) return false;
            event.preventDefault();
            const at = v.posAtCoords({ x: event.clientX, y: event.clientY });
            startUpload(images, at ?? v.state.selection.main.head);
            return true;
          },
        }),
      ];

      let instance: EditorView;
      try {
        instance = new EditorView({
          state: EditorState.create({ doc: resolvedInitialRef.current, extensions }),
          parent: host,
        });
      } catch {
        setInitFailed(true);
        onInitError?.(resolvedInitialRef.current);
        return;
      }

      // 上传徽标上的 × —— 事件委托挂在编辑器根上（widget 是 CM6 自己建的 DOM，
      // 拿不到 React 的合成事件）。
      const onChipClick = (event: MouseEvent) => {
        const target = event.target as HTMLElement | null;
        const holder = target?.closest?.('[data-upload-cancel]');
        if (!holder) return;
        const id = Number(holder.getAttribute('data-upload-cancel'));
        if (Number.isFinite(id)) cancelBatch(id);
      };
      instance.dom.addEventListener('click', onChipClick);

      viewRef.current = instance;
      setView(instance);

      return () => {
        destroyedRef.current = true;
        instance.dom.removeEventListener('click', onChipClick);
        if (previewTimerRef.current !== null) {
          window.clearTimeout(previewTimerRef.current);
          previewTimerRef.current = null;
        }
        instance.destroy();
        viewRef.current = null;
        setView(null);
      };
      // 只建一次：初始正文与扩展都在建实例那一刻定下来
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useEffect(() => () => draftRef.current?.dispose(), []);

    // ── 并排视图的窄屏降级 ──────────────────────────────────────────────────
    useEffect(() => {
      if (typeof window === 'undefined' || !window.matchMedia) return;
      const mq = window.matchMedia(`(max-width: ${SPLIT_MIN_WIDTH - 1}px)`);
      const apply = () => {
        if (mq.matches && modeRef.current === 'split') setMode('edit');
      };
      apply();
      mq.addEventListener('change', apply);
      return () => mq.removeEventListener('change', apply);
    }, []);

    // ── 导出 / 打印 ────────────────────────────────────────────────────────
    /** 同一时刻只允许一份快照在渲染 —— 连点两下导出会渲染两遍、下载两份。 */
    const snapshotBusyRef = useRef(false);

    /**
     * 取**导出 / 打印用的正文快照**：拿此刻编辑器里的原文，跑一遍与预览**同一套**
     * 管线（引用预处理 → blog-renderer → blog-content-dom），在离屏容器里跑完后处理
     * 再取出正文 HTML。
     *
     * 【为什么不直接读预览面板那棵 DOM】预览是**防抖 400ms** 的，背后还挂着一条异步
     * 取数 —— 敲完最后一个字**立刻**点导出，读到的正是**敲之前**那一版。这个错误
     * 不报错、不提示，导出件只是安静地少一段。所以导出必须自己按**当时**的原文算一份。
     *
     * 【为什么挂进 document 而不是在内存里拼】MathJax 排公式要量字号，脱离文档的
     * 元素量出来是 0，公式会退化成原文。离屏放置（left:-100000px）不可见、不影响版面。
     *
     * 失败（取数或渲染抛异常）时给一句 toast 并返回 null —— 宁可什么都不下载，
     * 也不要静默给一份缺内容的文件。
     */
    const buildSnapshot = useCallback(async (): Promise<{
      title: string;
      bodyHtml: string;
    } | null> => {
      if (snapshotBusyRef.current) {
        // ★ 第二次点击必须**说话** ★ 早退本身是对的（连点两下不该渲染两遍、下两份），
        // 但静默早退在用户那边就是「点了没反应」—— 而这一趟偏偏是最慢的一趟
        // （整篇引用取数 + MathJax），越慢越容易连点，也就越容易撞上。
        notify('正在生成导出内容，请稍候…', 'warning');
        return null;
      }
      snapshotBusyRef.current = true;
      let holder: HTMLDivElement | null = null;
      try {
        const source = viewRef.current?.state.doc.toString() ?? docRef.current;
        const resolver = resolverRef.current;
        if (!resolver) return null;
        // 本轮的真值（含投票小组件要用的那格）随 text 一起出来 —— 见 preprocessRound。
        const { text, entries } = await new ContentRefProcessor(resolver).preprocessRound(source);
        const rendered = renderBlogMarkdown(text);

        holder = document.createElement('div');
        holder.className = 'blog-content-container';
        holder.style.cssText = 'position:absolute;left:-100000px;top:0;width:760px;';
        holder.innerHTML = rendered.html;
        document.body.appendChild(holder);

        // 不传 voteGeneration：这个 holder 每次都是**新建的元素**，不存在
        // 「元素还在、数据换了」那种要不掉 `data-rendered` 缓存的情况。
        // 小组件的数据取自**这一轮**的 entries（与正文同一次取数）：不回头问会话缓存，
        // 免得缓存在这两段之间被作废成另一代。
        enhanceBlogContent(holder, {
          interactive: false,
          mathCount: rendered.mathCount,
          voteData: (id) => {
            const hit = entries.get(`vote:${id}`);
            return hit ? (hit.data ?? null) : undefined;
          },
        });
        // 剥掉只在站内页面上才成立的空壳（代码块的「复制」按钮）；
        // 把相对地址解析成这一页的绝对地址；纯 `#锚点` 摘掉 target（就地跳）。
        stripInteractiveShells(holder);
        absolutizeSiteUrls(holder);
        localizeFragmentLinks(holder);

        return { title, bodyHtml: holder.innerHTML };
      } catch {
        notify('导出失败：正文没能渲染出来，请稍后再试', 'error');
        return null;
      } finally {
        holder?.remove();
        snapshotBusyRef.current = false;
      }
    }, [notify, refreshToken, title]);

    const onExportHtml = useCallback(() => {
      void (async () => {
        const snap = await buildSnapshot();
        if (!snap) return;
        downloadHtml(`${safeFilename(snap.title || '未命名')}.html`, buildExportHtml(snap));
      })();
    }, [buildSnapshot]);

    const onPrint = useCallback(() => {
      void (async () => {
        const snap = await buildSnapshot();
        if (!snap) return;
        printHtml(buildExportHtml(snap));
      })();
    }, [buildSnapshot]);

    // ── 对外接口 ────────────────────────────────────────────────────────────
    useImperativeHandle(
      ref,
      (): MarkdownEditorHandle => ({
        getDoc: () => viewRef.current?.state.doc.toString() ?? docRef.current,
        isReady: () => viewRef.current !== null,
        clearDraft: () => draftRef.current?.clear(),
        flushDraft: () => draftRef.current?.flush(),
        focus: () => viewRef.current?.focus(),
      }),
      []
    );

    /** 恢复旧草稿：整体替换正文，并把它作为一次可撤销的操作留下。 */
    function applyDraft(value: string) {
      const v = viewRef.current;
      if (v) {
        v.dispatch({
          changes: { from: 0, to: v.state.doc.length, insert: value },
          selection: { anchor: value.length },
        });
      }
      setDraftChoice(null);
    }

    const charCount = view ? view.state.doc.length : resolvedInitialRef.current.length;

    if (initFailed) return null;

    return (
      <div className="md-editor" id={id} data-mode={mode}>
        {draftChoice !== null && (
          <div className="md-editor__draft-banner" role="status">
            <span>本地还留着一份上次没发出去的草稿，要恢复它吗？</span>
            <button type="button" className="md-editor__draft-btn" onClick={() => applyDraft(draftChoice)}>
              恢复草稿
            </button>
            <button
              type="button"
              className="md-editor__draft-btn md-editor__draft-btn--ghost"
              onClick={() => setDraftChoice(null)}
            >
              用当前内容
            </button>
          </div>
        )}

        <Toolbar
          view={view}
          withMath={withMath}
          onPickFiles={() => fileInputRef.current?.click()}
          onOpenResources={openResources}
          onExportHtml={onExportHtml}
          onPrint={onPrint}
        />

        {resourcesOpen && <ResourcePanel onClose={closeResources} onInsert={insertResource} />}

        {/*
          隐藏的文件输入。**必须同时带 hidden 属性与行内 display:none**：
          base.js 的 enhanceFileInputs 会给「看得见的」原生 file input 套一层
          .filepick UI（一颗蓝按钮 + 「未选择文件」+ ×），工具栏里就会凭空多出一个
          控件（2026-10 线上真实出现过）。它只认 `hidden` 属性与**行内**
          `style.display === 'none'` 两种 —— 写在样式表里的 display:none 它看不见。
          也别给它挂类名：那样就得在样式表里写一条同样看不见的规则，
          白白多一处「写了但没生效」的地方。
        */}
        <input
          ref={fileInputRef}
          type="file"
          multiple
          hidden
          accept={IMAGE_ACCEPT}
          style={{ display: 'none' }}
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            // 清空 value：否则「再选同一批文件」不会触发 change，看着像点了没反应
            e.target.value = '';
            const v = viewRef.current;
            if (files.length > 0 && v) startUpload(files, v.state.selection.main.head);
          }}
        />

        <div className="md-editor__body" style={{ height }}>
          <div className="md-editor__pane md-editor__pane--source" ref={hostRef} />

          <div className="md-editor__pane md-editor__pane--preview">
            <div className="md-editor__preview-bar">
              <span className="md-editor__preview-label">预览（只读）</span>
              <button
                type="button"
                className="md-editor__refresh"
                title="刷新预览：重新读取正文里的引用"
                aria-label="刷新预览"
                onClick={() => setRefreshToken((n) => n + 1)}
              >
                <RefreshCw size={14} strokeWidth={2} aria-hidden="true" />
                刷新引用
              </button>
            </div>
            <div className="md-editor__preview-body" ref={previewBodyRef}>
              <MarkdownRenderer
                content={previewDoc}
                contentRefs="expand"
                interactive={false}
                resolver={resolverRef.current}
                refreshToken={refreshToken}
              />
            </div>
          </div>
        </div>

        <div className="md-editor__foot">
          <span className="md-editor__count" aria-live="polite">
            {charCount} 字
          </span>
          {/* 「先 Esc 再 Tab」是 CodeMirror **自带**的行为（见上面 contentAttributes
              那段），不是我们写的键处理 —— 这里只负责把它说出来：编辑器默认吃掉
              Tab（缩进），不说的话键盘用户只能靠试出来。窄屏由样式表转成 sr-only。 */}
          <span className="md-editor__kbd" id={kbHintId}>
            按 Esc 再 Tab 可到工具条
          </span>
          {/* 视图切换用 btn-tab 那档（「当前所在页常驻最高级空闲态」），
              **不是 .segmented 胶囊滑块**：那个控件的适用范围被 frontend-styles.md
              钉死为「2 选 1 的互斥视图切换」，这里是三档、且窄屏还要少一档。 */}
          <div className="md-editor__modes" role="group" aria-label="视图切换">
            {VIEW_MODES.map(({ key, label, Icon }) => (
              <button
                key={key}
                type="button"
                // 「并排」这一档在窄屏由样式表整个藏掉（`.md-editor__mode--split`）——
                // 390px 上并排 = 两栏各不到 190px，两栏都不成样子。藏在这里而不是
                // 组件里过滤，是为了不引入一次「先渲染后收起」的闪烁与 hydration 分叉。
                className={`md-editor__mode${key === 'split' ? ' md-editor__mode--split' : ''}${
                  mode === key ? ' is-active' : ''
                }`}
                aria-pressed={mode === key}
                // 窄屏下把文字标签藏起来只留图标（见 _markdown-editor.scss），
                // 那时按钮的可访问名就只剩这个 aria-label 了。
                aria-label={label}
                title={label}
                onClick={() => {
                  // 切到并排 / 预览时立刻用当前正文刷新一次，不等防抖
                  if (key !== 'edit') schedulePreview(docRef.current, true);
                  setMode(key);
                }}
              >
                <Icon size={14} strokeWidth={2} aria-hidden="true" />
                <span className="md-editor__mode-label">{label}</span>
              </button>
            ))}
          </div>
        </div>
      </div>
    );
  }
);

export default MarkdownEditor;
