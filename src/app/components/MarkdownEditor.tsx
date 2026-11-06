'use client';

// ─────────────────────────────────────────────────────────────────────────────
// MarkdownEditor.tsx —— CodeMirror 6 源码编辑器 + 整篇只读预览（博客 / 剪贴板共用）
//
// 【职责边界】只管「编辑、预览、上传、导出」；提交接口、长度校验、可见性、禁言
// 判定、剪贴板的 Ctrl+S 与每分钟自动保存**仍归各自的表单**（§5.3）。表单通过
// `ref.getDoc()` 同步取最新原文 —— 绝不从防抖后的预览状态取提交内容。
//
// 【预览统一走新引擎】无论 Markdown 还是 Reactive，预览都由 `ReactivePreview`
// （compat → 引用适配 → worker 编译 → ReactiveDocument）渲染，与阅读页同一套
// 配置。**旧的 MarkdownRenderer / blog-renderer 已随 legacy 渲染面整体退役** ——
// 两套引擎的表格 / HTML 清洗 / 数学 / 脚注 / 引用内联会静默漂开，而「追加组件后
// 普通正文排版不变」正是靠同一套引擎 + 站点级 `markdownBreaks: true` 保证的。
//
// 【预览可本地交互，但不写业务】`ReactivePreview` 以 interactive + preview 渲染：
// 滑块 / 输入 / 图表可试；投票 / 收藏等站点嵌入只读。预览不发出任何业务写请求。
//
// 【导出 / 打印】等待当前正文的格式判定后，用 `renderStaticMarkup`（同一套 compat +
// 适配 + 编译选项）渲染**静态初始状态**；不走预览 DOM。
//
// 【主题】编辑器配色全走站点 CSS 变量，不需要监听 `data-theme`（见 cm-theme.ts）。
// ─────────────────────────────────────────────────────────────────────────────

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useReducer,
  useRef,
  useState,
} from 'react';
import {
  Compartment,
  EditorState,
  type Extension,
} from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { RefreshCw } from 'lucide-react';
import type { Diagnostic, LocalCompileWorker } from 'reactive-md';

import Toolbar, { VIEW_MODES } from './markdown-editor/Toolbar';
import ResourcePanel from './markdown-editor/ResourcePanel';
import ReactiveAuthoringPanel from './markdown-editor/ReactiveAuthoringPanel';
import { editorBaseTheme } from './markdown-editor/cm-theme';
import {
  buildExportHtml,
  downloadHtml,
  printHtml,
  REACTIVE_EXPORT_NOTE,
  renderStaticMarkup,
  safeFilename,
} from './markdown-editor/export';
import ReactivePreview from './reactive/ReactivePreview';
import type { ContentFormat } from '@/lib/content-format';
import { IMAGE_ACCEPT, uploadImageFile } from '@/lib/image-client';
import * as cmd from '@/lib/md-editor/commands';
import {
  AUTHOR_TOOL_LENGTH_LIMIT,
  applyReactiveAuthorAnalysis,
  applyReactiveCompletion,
  clearReactiveAuthorAnalysis,
  formatReactiveDocument,
  getReactiveCompletions,
  reactiveAuthoring,
  revealReactiveDiagnostic,
  type AuthorCompletion,
  type ReactiveAuthorAnalysis,
} from '@/lib/md-editor/reactive-authoring';
import { createDraftStore, type DraftStore } from '@/lib/md-editor/draft';
import {
  mightContainReactiveSyntax,
  type EditorDiagnostic,
  type EditorSubmitSnapshot,
} from '@/lib/md-editor/format-mode';
import { createFormatAnalyzer, type FormatAnalysis } from '@/lib/reactive/format-observer';
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
 * 格式分析的防抖。分析本身在 worker 里（见 `@/lib/reactive/format-observer`），
 * 这里只是不再为「连续敲字」的每一个中间态排队 —— 200k 正文也不该每键触发一次
 * 编译调度。停手 350ms 之后才分析，比预览略快一点（诊断要跟着手走）。
 */
const FORMAT_ANALYSIS_DEBOUNCE_MS = 350;

/** 提交时最多重试几次「正文在等分析时又被改了」。 */
const SUBMIT_ANALYSIS_ATTEMPTS = 3;

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
  /** 此刻应当提交的正文格式（含「插入组件后自动升级为 reactive」这一下）。 */
  getFormat(): ContentFormat;
  /** 这份正文的语法版本（服务端给的值；草稿恢复后是草稿里那一版）。 */
  getSyntaxVersion(): string | null;
  /**
   * 提交前的权威判定：等**当前正文**的异步分析落地，返回与判定同一份的正文 +
   * 格式 + 版本；无效增强语法（或分析失败）时 `blocked` 非空，调用方必须停下。
   *
   * 这是唯一允许在提交路径上做完整编译的地方（一次保存一次，不是每键）。
   */
  prepareSubmit(): Promise<EditorSubmitSnapshot>;
  /**
   * 保存**成功**后把服务端已持有的格式抬成持久下限（只升不降）。
   *
   * 表单的 `format` prop 只反映「进页面时」的库值；同页保存成功后服务端已经
   * 持有这份 reactive，本页必须跟着抬 —— 否则之后删光增强语法再保存，会因为
   * 表单仍传 markdown 而被静默降级（终审 F1）。传 markdown 不会降级。
   */
  pinSavedFormat(format: ContentFormat, syntaxVersion?: string | null): void;
}

export interface MarkdownEditorProps {
  /** 外壳的 id（`editor` / `clipboard-editor`）—— 表单与 e2e 的元素钩子。 */
  id?: string;
  /** 初始正文。 */
  initialValue: string;
  /** 服务端给的语法版本（草稿恢复时以草稿那份为准）。null = 未知 / 旧文档。 */
  initialSyntaxVersion?: string | null;
  /**
   * 新建页的草稿键（`blog-upload-editor` / `clipboard-upload-editor`）。
   * **编辑态不要传** —— 编辑态既不读也不写新建草稿（§5.2）。
   */
  draftKey?: string;
  /** 文档标题（导出文件名与 `<title>`）。 */
  title?: string;
  /** 是否给公式按钮（剪贴板有、博客没有）。 */
  withMath?: boolean;
  /**
   * 正文格式的**下限**（服务端 / 草稿给的值）。
   *
   * 两种格式的预览与导出都走同一套新引擎；这一项只决定「哪些用户工具可见」与
   * 「提交时能不能降级」：`reactive` 是下限，删光组件也不自动变回 markdown。
   * 默认 markdown —— 全新文档按分析结果自动升级（见 `effectiveFormat`）。
   */
  format?: ContentFormat;
  /** 对外文章可按访客预览；默认保留成员编辑与引用能力。 */
  referenceMode?: 'expand' | 'external';
  /** 编辑区高度（CSS 值）。 */
  height?: string;
  /** CM6 初始化失败 —— 调用方把 textarea 回退显示出来，并用这个初值填进去。 */
  onInitError?: (initialValue: string) => void;
  /** 提示（上传失败、草稿冲突等）。由表单提供，保证每页只有一条 toast 通道。 */
  onNotify?: (message: string, type: 'error' | 'warning' | 'success') => void;
  /**
   * 恢复了一份**非 Markdown**草稿时通知表单。
   *
   * 草稿信封里存着它自己的格式（见 `lib/md-editor/draft.ts`）；表单的初始格式来自
   * 服务端或默认值。不把两者对齐，用户恢复一份 reactive 草稿后点保存，服务端会按
   * 表单上那个 markdown 写入 —— 正文没变，格式被静默改写。
   */
  onDraftFormatRestored?: (format: ContentFormat) => void;
  /** 草稿里那份语法版本（恢复时通知表单；提交由服务端定版本，前端不推导）。 */
  onDraftSyntaxVersionRestored?: (syntaxVersion: string | null) => void;
}

const MarkdownEditor = forwardRef<MarkdownEditorHandle, MarkdownEditorProps>(
  function MarkdownEditor(
    {
      id,
      initialValue,
      initialSyntaxVersion = null,
      draftKey,
      title = '',
      withMath = false,
      format = 'markdown',
      referenceMode = 'expand',
      height = '60vh',
      onInitError,
      onNotify,
      onDraftFormatRestored,
      onDraftSyntaxVersionRestored,
    },
    ref
  ) {
    const hostRef = useRef<HTMLDivElement>(null);
    const previewBodyRef = useRef<HTMLDivElement>(null);
    /**
     * 键盘提示的 id（编辑区用 aria-describedby 指过来）。
     *
     * **用调用方给的 `id` 派生，不用 `useId`**：`useId` 的值编码了组件在树里的
     * 位置，服务端与客户端的树只要有一处不同（dev 下按需重编译 / 快速刷新时
     * 代码版本错位就会这样）就会得到两个不同 id —— React 报 hydration mismatch，
     * 而且这个 id 只是 `aria-describedby` 的目标，没有唯一性要求。每页最多一个
     * 编辑器，`editor` / `clipboard-editor` 已经足够区分；没有 id 时退到固定值。
     */
    const kbHintId = id ? `${id}-kbd-hint` : 'md-editor-kbd-hint';
    const fileInputRef = useRef<HTMLInputElement>(null);
    const viewRef = useRef<EditorView | null>(null);
    const [view, setView] = useState<EditorView | null>(null);
    const [mode, setMode] = useState<ViewMode>('edit');
    const [refreshToken, setRefreshToken] = useState(0);
    const [previewDoc, setPreviewDoc] = useState(initialValue);
    // 正文改动后强制重算字数 / 撤销态。正文本身留在 CM6 的 state 里，
    // 不搬进 React state —— 25 万字的字符串每敲一下都过一遍 state 没意义。
    const [, bump] = useReducer((n: number) => n + 1, 0);

    /**
     * 当前正文的同步镜像 + 文档代次。
     *
     * 代次在**每次 docChanged 立刻**递增（不等 350ms 防抖）。所有异步结果
     * （worker 分析、提交判定）回来时必须核对代次 / 原文，旧结果绝不能贴到
     * 新正文上 —— 否则保存会先写下一版旧内容，界面诊断也可能闪回旧状态。
     */
    const latestSourceRef = useRef(initialValue);
    const documentGenerationRef = useRef(0);
    /** 提交判定函数（buildSnapshot 在它定义之前）；每次渲染刷新引用。 */
    const prepareSubmitRef = useRef<(() => Promise<EditorSubmitSnapshot>) | null>(null);

    const draftRef = useRef<DraftStore | null>(null);
    const [draftChoice, setDraftChoice] = useState<string | null>(null);
    /** 横幅里那份草稿自己的格式 / 语法版本（恢复时同步给表单）。 */
    const restoredDraftFormatRef = useRef<ContentFormat>('markdown');
    const restoredDraftVersionRef = useRef<string | null>(null);
    /** 当前正文的语法版本：服务端初值，草稿恢复时改用草稿那份。 */
    const syntaxVersionRef = useRef<string | null>(initialSyntaxVersion ?? null);
    /**
     * 格式同步的「水位」：上一次见到的格式，以及是否已经过了挂载那一刻。
     *
     * 只切格式、正文一个字没动时，CM6 的 updateListener **不会**触发；没有下面
     * 那条 effect，本地草稿里留着的还是旧格式 —— 下次恢复出来正文对上、格式对不上，
     * 页面上不会有任何提示。两件事必须同时成立：
     *   · **初次挂载不落盘**：新建页可能正留着一份旧草稿等用户在横幅里选，
     *     这时写一份「当前正文 + 表单格式」上去会把那份草稿直接覆盖掉；
     *   · 挂载之后的变化才是用户自己切的，正文没动也要把**新**格式存下去
     *     （绝不能拿表单原来的旧格式回写，草稿里存的格式才是恢复时的真相）。
     */
    const formatSyncRef = useRef({
      mounted: false,
      last: format as ContentFormat,
      lastVersion: null as string | null,
    });
    const [initFailed, setInitFailed] = useState(false);

    /**
     * 「刚插入过组件」——**只用于分析落地前的临时升级**，不是永久下限。
     *
     * 作者界面不再要求先手动选格式：从 Components 菜单插一个 `<slider>` 进来，
     * 这份正文就已经是增强语法了。插入后立刻保存时，分析还没回来，靠这一位让
     * `effectiveFormat` 立即是 reactive（提交仍会等分析）。
     *
     * 但**最终以解析事实为准**：新建的 Markdown 插了又删光 → 分析（或预筛）判定
     * 为 markdown 时，这一位必须清掉，不能凭空把一份普通 Markdown 存成 reactive。
     * 真正「永不下限」的只有 `format === 'reactive'`（已保存的增强文档）。
     */
    const [componentInserted, setComponentInserted] = useState(false);

    // ── 自动格式（异步 / worker，逐键不在主线程编译）───────────────────────
    /**
     * 最近一次**与当前正文对应**的分析结果。null = 尚未分析 / 正文里没有任何
     * 增强语法候选（预筛直接排除，不必排一次编译）。
     */
    const [formatAnalysis, setFormatAnalysis] = useState<FormatAnalysis | null>(null);
    const [analysisPending, setAnalysisPending] = useState(false);
    /** worker + 主线程回退都失败时的明确状态（不静默按 Markdown 保存）。 */
    const [analysisFailure, setAnalysisFailure] = useState<string | null>(null);
    /**
     * worker 回报的作者分析（tokens / 诊断），只用于源码装饰。
     *
     * 它**不是**格式判定的副本：`formatAnalysis` 给面板与提交用，这一份给 CM6
     * StateField 用。两者一起落地、一起作废，但正文一变就必须先清空 —— 旧偏移
     * 贴在新文字上不会报错，只会把着色与下划线指到别的字上。
     */
    const [authorAnalysis, setAuthorAnalysis] = useState<ReactiveAuthorAnalysis | null>(null);
    /** 这份 authorAnalysis 对应的原文（贴装饰前再核对一次）。 */
    const authorAnalysisSourceRef = useRef<string | null>(null);
    /** worker 失效、已回退主线程检查 —— 必须在 UI 明示，不能静默变慢。 */
    const [analysisFallback, setAnalysisFallback] = useState(false);
    /**
     * 当前正文真的在跑格式检查（含纯 Markdown 里的 `<`）。
     *
     * 回退提示只在「确实在检查」时出现：普通正文（没有任何候选语法）根本不排
     * 编译，这时把 worker 的技术状态铺给用户只是噪音。
     */
    const [analysisActive, setAnalysisActive] = useState(false);
    const analyzerRef = useRef<ReturnType<typeof createFormatAnalyzer> | null>(null);
    const analysisRevisionRef = useRef(0);
    const analysisTimerRef = useRef<number | null>(null);

    const invalidEnhanced = formatAnalysis?.effective === 'invalid-enhanced';
    const detectedReactive = formatAnalysis?.effective === 'reactive';
    /**
     * 同页保存成功抬起来的持久下限（终审 F1）。
     *
     * `format` prop 是**进页面时**的库值；保存成功后服务端已持有本次提交的格式，
     * 表单会把 `format` 一起抬起来。这一位是编辑器自己的同步兜底 —— 保存回调
     * 与下一次提交之间可能只隔一个微任务，不能等 prop 重渲染。
     * 只升不降：markdown 的保存不会把它清掉。
     */
    const [savedReactiveFloor, setSavedReactiveFloor] = useState(false);
    const savedReactiveFloorRef = useRef(false);
    const formatFloor: ContentFormat =
      format === 'reactive' || savedReactiveFloor ? 'reactive' : 'markdown';
    /**
     * 当前生效格式（只用于界面与预览，提交以 `prepareSubmit` 的判定为准）。
     *
     * 四档来源，优先级从高到低：
     *   1. `formatFloor` —— 服务端 / 草稿给的下限 + 同页保存成功后抬起的下限；
     *      已保存的增强文档**永久下限**，删光组件也不降级（审查 3.2 / 计划 §3.1）；
     *   2. `detectedReactive` —— 解析器对**当前正文**的有效增强语法事实；
     *   3. `invalidEnhanced` —— 解析器确认是增强语法但有错，仍按增强文档处理；
     *   4. `componentInserted && (分析在飞 / 失败)` —— 刚插入组件、结果还没回来
     *      的临时升级。一旦当前正文的分析落地为 markdown，第 4 条必须失效，
     *      否则「新建 MD 插入后删光」会凭空存成 reactive（本轮协调要求）。
     */
    const insertionPending = componentInserted && (analysisPending || analysisFailure !== null);
    const effectiveFormat: ContentFormat =
      formatFloor === 'reactive' || detectedReactive || invalidEnhanced || insertionPending
        ? 'reactive'
        : 'markdown';
    const effectiveFormatRef = useRef(effectiveFormat);
    effectiveFormatRef.current = effectiveFormat;
    /** 下限的同步副本：提交判定在 async 回调里读，不能拿到旧闭包。 */
    const formatFloorRef = useRef(formatFloor);
    formatFloorRef.current = formatFloor;

    /**
     * 草稿里存的格式：**只用已落地的解析事实 / 下限，不用临时升级**（终审 F5）。
     *
     * - 无效增强语法仍记 reactive：正文里有一段坏掉的 `<slider>` 时，草稿若记成
     *   markdown，恢复后会被当成普通文本，用户看不到任何提示；
     * - **只认「已落地、且对应当前正文」的结果**：`insertionPending` 与旧一遍
     *   分析遗留的 `detectedReactive` / `invalidEnhanced` 都不算身份 —— 正文刚
     *   变、新结果还没回来时，旧事实可能已经不属于这份正文。写进草稿会把一份
     *   普通 Markdown 永久抬成 reactive；恢复时正文原样还在，重新分析会按最终
     *   事实升级或保持 Markdown。
     */
    const settledReactive =
      !analysisPending &&
      analysisFailure === null &&
      (detectedReactive || invalidEnhanced);
    const draftFormat: ContentFormat =
      formatFloor === 'reactive' || settledReactive ? 'reactive' : 'markdown';
    const draftFormatRef = useRef(draftFormat);
    draftFormatRef.current = draftFormat;
    /** 草稿随附的语法版本：Reactive 用分析给的权威值，Markdown 恒 null。 */
    const draftSyntaxVersionRef = useRef<string | null>(null);
    draftSyntaxVersionRef.current =
      draftFormat === 'reactive'
        ? (formatAnalysis?.syntaxVersion ?? syntaxVersionRef.current)
        : null;
    const draftSyntaxVersion = draftSyntaxVersionRef.current;

    // ── Reactive 作者工具 ───────────────────────────────────────────────────
    /** null = 补全面板没开；[] = 开了但当前位置没有候选。 */
    const [authoringCompletions, setAuthoringCompletions] = useState<AuthorCompletion[] | null>(
      null
    );
    const [authoringStatus, setAuthoringStatus] = useState<string | null>(null);
    /**
     * 只装作者工具的那一格。**用 Compartment 而不是重建 EditorView**：
     * 切格式时 dispatch 一次 reconfigure，正文、选区与撤销历史都留在原 state 里
     * （重建 = 历史清空，而这一点不会报错）。
     */
    const reactiveCompartmentRef = useRef(new Compartment());
    /**
     * 代次：切走格式后，旧扩展迟到的回调不得把分析写回面板。
     * 每次都从 1 开始递增，闭包里只认自己那一代。
     */
    const reactiveGenerationRef = useRef(0);

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
          syntaxVersionRef.current = read.syntaxVersion;
          restoredDraftVersionRef.current = read.syntaxVersion;
          if (read.format !== format) onDraftFormatRestored?.(read.format);
          if (read.syntaxVersion !== (initialSyntaxVersion ?? null)) {
            onDraftSyntaxVersionRestored?.(read.syntaxVersion);
          }
        } else {
          // 两份都有内容：不静默覆盖任何一份，交给用户在横幅里选
          restoredDraftFormatRef.current = read.format;
          restoredDraftVersionRef.current = read.syntaxVersion;
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
    /**
     * 通知状态机「这个槽位有结果了」。**只传失败原因，不传长度 / 位置**：
     * 成功那一条连正文一起走同一个事务，插进去的那段区间由状态机自己从改动里
     * 映射出来（见 upload-anchors.ts 的 settleUploadSlot）。
     */
    const settleSlot = useCallback((batchId: number, index: number, message?: string) => {
      const v = viewRef.current;
      if (!v || destroyedRef.current) return;
      v.dispatch({
        effects: settleUploadSlot.of({ batchId, key: `${batchId}:${index}`, message }),
      });
    }, []);

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
          const rejected = precheckFile(file);
          if (rejected) {
            settleSlot(batchId, index, rejected);
            notify(`${file.name || '图片'}：${rejected}`, 'error');
            return;
          }
          const result = await uploadImageFile(file);
          // 迟到的结果：批次被取消、或者编辑器已经卸载 —— 直接丢弃。
          // 图床里的东西照旧留着（服务端已经收了），不靠删素材来补偿一次取消的编辑。
          if (destroyedRef.current || abortedRef.current.has(batchId)) return;
          if (!result.ok) {
            settleSlot(batchId, index, result.message);
            notify(`${file.name || '图片'}：${result.message}`, 'error');
            return;
          }
          const markdown = imageMarkdown(file.name || 'image.png', result.url);
          const live = viewRef.current;
          if (!live) return;
          const at = batchInsertPos(live.state, batchId, index);
          if (at === null) return; // 批次已退场（整批取消 / 锚点被删）—— 不插
          live.dispatch({
            changes: { from: at, insert: markdown },
            // 长度不进效果：插进去的那段正文就在这一条 change 里，状态机自己映射
            effects: settleUploadSlot.of({ batchId, key: `${batchId}:${index}` }),
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

    // ── Reactive 作者动作 ───────────────────────────────────────────────────
    /** 「补全」按钮：候选按**当前光标**现取，面板展示后由用户挑一条。 */
    const requestCompletions = useCallback(() => {
      const v = viewRef.current;
      if (!v || effectiveFormatRef.current !== 'reactive') return;
      if (v.state.doc.length > AUTHOR_TOOL_LENGTH_LIMIT) {
        // 同步解析在主线程；超长正文直接说明，不假装「没有候选」。
        setAuthoringCompletions(null);
        setAuthoringStatus('正文超过 5 万字符，暂不支持补全；编辑与保存不受影响。');
        return;
      }
      setAuthoringStatus(null);
      try {
        setAuthoringCompletions(getReactiveCompletions(v) ?? []);
      } catch {
        // 面板说「没有候选」比静默无反应好 —— 用户至少知道按到了。
        setAuthoringCompletions([]);
      }
    }, []);

    const pickCompletion = useCallback((item: AuthorCompletion) => {
      const v = viewRef.current;
      if (!v) return;
      const applied = applyReactiveCompletion(v, item);
      setAuthoringCompletions(null);
      setAuthoringStatus(applied ? null : '这条补全没有插入，请重新触发补全。');
      if (applied) v.focus();
    }, []);

    const formatAuthoringDocument = useCallback(() => {
      const v = viewRef.current;
      if (!v) return;
      if (v.state.doc.length > AUTHOR_TOOL_LENGTH_LIMIT) {
        setAuthoringStatus('正文超过 5 万字符，暂不支持格式化；编辑与保存不受影响。');
        return;
      }
      const changed = formatReactiveDocument(v);
      setAuthoringStatus(changed ? '已格式化，可一步撤销。' : '没有需要格式化的内容。');
      v.focus();
    }, []);

    const revealDiagnostic = useCallback((diagnostic: Diagnostic) => {
      const v = viewRef.current;
      if (!v) return;
      revealReactiveDiagnostic(v, diagnostic);
      v.focus();
    }, []);

    // ── 自动格式分析 ────────────────────────────────────────────────────────
    /**
     * 排一次分析：防抖 + 预筛，真正的编译在 worker（`format-observer`）里。
     *
     * 这个函数刻意只读 ref 与 setter —— updateListener 在挂载时只建一次，
     * 闭包里的任何 state 都会是旧值。
     */
    const scheduleAnalysis = useCallback((source: string) => {
      if (analysisTimerRef.current !== null) {
        window.clearTimeout(analysisTimerRef.current);
        analysisTimerRef.current = null;
      }
      if (!mightContainReactiveSyntax(source)) {
        // 肯定不含增强语法：作废在飞结果，直接回到「纯 Markdown」。
        analysisRevisionRef.current += 1;
        setFormatAnalysis(null);
        setAnalysisPending(false);
        setAnalysisFailure(null);
        setAnalysisActive(false);
        authorAnalysisSourceRef.current = null;
        setAuthorAnalysis(null);
        // 当前正文连一个增强语法候选都没有：插入过组件也已删光。清掉临时升级 ——
        // 新建 Markdown 以最终事实为准；已保存 reactive 由 `format` 下限兜住。
        setComponentInserted(false);
        return;
      }
      setAnalysisActive(true);
      setAnalysisPending(true);
      analysisTimerRef.current = window.setTimeout(() => {
        analysisTimerRef.current = null;
        const analyzer = analyzerRef.current;
        if (!analyzer) {
          setAnalysisPending(false);
          return;
        }
        const revision = (analysisRevisionRef.current += 1);
        const generation = documentGenerationRef.current;
        void analyzer
          .analyze(source, revision)
          .then((result) => {
            if (destroyedRef.current) return;
            // 乱序 / 被更新正文取代的结果一律丢弃（契约 §2）：revision、代次、
            // 原文三重核对 —— 防抖窗口里 docChanged 不会推进 revision，只看它不够。
            if (generation !== documentGenerationRef.current) return;
            if (source !== latestSourceRef.current) return;
            if (result.revision !== analysisRevisionRef.current) return;
            if (result.effective === 'superseded') {
              if (result.revision === analysisRevisionRef.current) setAnalysisPending(false);
              return;
            }
            setFormatAnalysis(result);
            setAnalysisPending(false);
            setAnalysisFailure(null);
            // 当前正文（含刚插入又删光的组件）最终按解析器判定：markdown 就
            // 撤掉临时升级；invalid / reactive 则继续保持增强身份。
            if (result.effective === 'markdown') setComponentInserted(false);
            // worker 已经把 authoring analysis 一起算好了（includeAuthorAnalysis）；
            // 这里只负责把它交给 CM6 装饰，不在主线程再跑一遍（审查 3.3）。
            const nextAuthor = result.author ?? null;
            authorAnalysisSourceRef.current = nextAuthor ? source : null;
            setAuthorAnalysis(nextAuthor);
            // worker / fallback 由 FormatAnalysis 直接回报，不用再从选项回调猜。
            setAnalysisFallback(result.fallback);
            if (result.syntaxVersion) syntaxVersionRef.current = result.syntaxVersion;
            // 草稿来自旧语法版本：明确提示，别让它在保存时被服务端拒绝时才暴露。
            const restored = restoredDraftVersionRef.current;
            if (
              restored &&
              result.effective === 'reactive' &&
              result.syntaxVersion &&
              restored !== result.syntaxVersion
            ) {
              setAuthoringStatus('草稿来自旧语法版本，保存时可能被拒绝；请检查正文后重新保存');
            }
          })
          .catch(() => {
            if (destroyedRef.current) return;
            setAnalysisPending(false);
            setAnalysisFailure('无法检查正文格式，请稍后再试');
          });
      }, FORMAT_ANALYSIS_DEBOUNCE_MS);
    }, []);

    // 分析器：一次挂载一份，卸载即终止 worker。
    useEffect(() => {
      let analyzer: ReturnType<typeof createFormatAnalyzer> | null = null;
      try {
        // worker 不可用时上游回退主线程，编辑会变慢 —— 面板必须说出来。
        analyzer = createFormatAnalyzer({
          createWorker: () =>
            // MarkdownEditor 在 src/app/components；worker 在 src/lib/reactive。
            new Worker(new URL('../../lib/reactive/compile.worker.ts', import.meta.url), {
              type: 'module',
            }) as unknown as LocalCompileWorker,
          onModeChange: (nextMode) => {
            if (destroyedRef.current) return;
            setAnalysisFallback(nextMode === 'fallback');
          },
        });
        analyzerRef.current = analyzer;
      } catch {
        // Worker 起不来时上游调度器会异步回退主线程；这里只是兜底标记，
        // 下面的提交判定会明确 blocked 而不是猜格式。
        analyzerRef.current = null;
      }
      // 打开已有正文（含草稿恢复）时先给一次分析；没有候选语法时预筛会直接跳过。
      scheduleAnalysis(resolvedInitialRef.current);
      return () => {
        analyzerRef.current = null;
        if (analysisTimerRef.current !== null) {
          window.clearTimeout(analysisTimerRef.current);
          analysisTimerRef.current = null;
        }
        analyzer?.dispose();
      };
      // 只建一次：分析器跟着编辑器生命周期走
      // eslint-disable-next-line react-hooks/exhaustive-deps
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
        // Reactive 作者工具（高亮 / 分析 / Ctrl+Space 补全 / 诊断）由下面那条
        // [format] effect 往这一格里 reconfigure；Markdown 模式这一格是空的。
        reactiveCompartmentRef.current.of([]),
        ...editorBaseTheme,
        uploadBatchField,
        uploadChipDecorations,
        // 自定义键放在默认键位表**前面**：同一组键位里先出现的先匹配。
        // Ctrl/Cmd+S **刻意不绑** —— 剪贴板的保存由表单那一个页面级监听负责，
        // 两边都绑就会对同一次按键发两遍保存请求（§5.3）。
        keymap.of([
          /**
           * 单行换行（Shift+Enter）—— 见 commands.ts 的 insertLineBreak。
           *
           * ⚠️ **必须排在这里**（defaultKeymap 之前）：键位表为每一个 `key` 名维护
           * 一条命令链，**先注册的先跑**。defaultKeymap 里
           * `{ key: 'Enter', run: insertNewlineAndIndent, shift: insertNewlineAndIndent }`
           * 那个 `shift` 字段注册的正是 `Shift-Enter` 这个键名 —— 排到它后面就永远
           * 轮不到我们这条（症状是 Shift+Enter 与 Enter 一模一样，且不报错）。
           */
          { key: 'Shift-Enter', run: cmd.insertLineBreak() },
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
          latestSourceRef.current = text;
          // 立刻推进代次：在飞的分析 / 提交判定从这一刻起就过期了。
          documentGenerationRef.current += 1;
          // 候选与装饰都绑定于旧源码偏移：正文一变先全部收起，再等新分析。
          // 装饰的 StateField 自己也会在 docChanged 时清空，这里同步镜像状态。
          authorAnalysisSourceRef.current = null;
          setAuthorAnalysis(null);
          if (effectiveFormatRef.current === 'reactive') {
            setAuthoringCompletions(null);
          }
          bump();
          schedulePreview(text);
          scheduleAnalysis(text);
          draftRef.current?.schedule({
            format: draftFormatRef.current,
            text,
            syntaxVersion: draftSyntaxVersionRef.current,
          });
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

    // ── format → Reactive 作者扩展的启停 ────────────────────────────────────
    // 用 Compartment 热替换：切格式**不重建 EditorState**（否则正文与撤销历史
    // 一起没了，而且不报错）。分析 / 补全状态一并清空 —— 旧正文的诊断留在
    // 新格式上就是假报警。
    useEffect(() => {
      const generation = (reactiveGenerationRef.current += 1);
      setAuthoringCompletions(null);
      setAuthoringStatus(null);
      const v = viewRef.current;
      if (!v) return;

      const extension =
        effectiveFormat === 'reactive'
          ? reactiveAuthoring({
              onCompletions: (items) => {
                if (destroyedRef.current || reactiveGenerationRef.current !== generation) return;
                setAuthoringCompletions(items);
                setAuthoringStatus(null);
              },
              onTooLong: () => {
                if (destroyedRef.current || reactiveGenerationRef.current !== generation) return;
                setAuthoringCompletions(null);
                setAuthoringStatus('正文超过 5 万字符，暂不支持补全；编辑与保存不受影响。');
              },
            })
          : [];

      v.dispatch({ effects: reactiveCompartmentRef.current.reconfigure(extension) });
    }, [effectiveFormat]);

    /**
     * 把 worker 的 authoring analysis 贴回编辑区。
     *
     * 必须排在上面那条 Compartment effect **之后**：`markdown → reactive` 切换时
     * 新扩展要先装进 state，StateEffect 才找得到承载它的 StateField。正文在
     * worker 回来之后又变过（`authorAnalysisSourceRef` 与当前 doc 不一致）时
     * 一律清空 —— 旧偏移不贴到新文字上。
     */
    useEffect(() => {
      const v = viewRef.current;
      if (!v) return;
      if (effectiveFormat !== 'reactive') {
        clearReactiveAuthorAnalysis(v);
        return;
      }
      if (authorAnalysis && authorAnalysisSourceRef.current === v.state.doc.toString()) {
        applyReactiveAuthorAnalysis(v, authorAnalysis);
      } else {
        clearReactiveAuthorAnalysis(v);
      }
    }, [authorAnalysis, effectiveFormat, view]);

    useEffect(() => () => draftRef.current?.dispose(), []);

    // ── 只切格式 / 版本 = 一次草稿写入 ───────────────────────────────────────
    // 正文没动时 updateListener 不会跑，格式 / 语法版本本身也就没人落盘（见
    // formatSyncRef）。这里补「自动识别完成 / 草稿恢复后格式变了」这一种情况。
    useEffect(() => {
      const sync = formatSyncRef.current;
      if (!sync.mounted) {
        // 初次挂载：正文与格式的初值来自草稿或服务端，不是用户刚改的。
        sync.mounted = true;
        sync.last = draftFormat;
        sync.lastVersion = draftSyntaxVersion;
        return;
      }
      if (sync.last === draftFormat && sync.lastVersion === draftSyntaxVersion) return;
      sync.last = draftFormat;
      sync.lastVersion = draftSyntaxVersion;
      const store = draftRef.current;
      const view = viewRef.current;
      // 编辑器没起来（已回退 textarea）时正文不在 docRef 这面镜子里，别拿旧快照写草稿。
      if (!store || !view) return;
      // schedule 的语义就是「用这一份替换排队中的旧值」—— 正好是切换格式要的。
      store.schedule({
        format: draftFormat,
        text: view.state.doc.toString(),
        syntaxVersion: draftSyntaxVersion,
      });
    }, [draftFormat, draftSyntaxVersion]);

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
     * 取**导出 / 打印用的正文快照**。
     *
     * 两件事合在一起：
     *   1. 先等**当前正文**的格式判定（与保存同一条 `prepareSubmit`）：刚插入组件、
     *      350ms 分析还没回来时立刻点导出，不能按旧格式走另一套引擎（审查 5.4）；
     *   2. 无论 Markdown 还是 Reactive，都用**统一的新引擎**做静态渲染
     *      （`renderStaticMarkup` → compat + 引用适配 + `reactiveCompileOptions(format)`），
     *      旧 MarkdownRenderer / blog-renderer 已随 legacy 渲染面整体退役（审查 5.1）。
     *
     * 判定 blocked（无效增强语法 / 不可发布）时明确提示并拒绝导出 —— 宁可什么都不
     * 下载，也不要给一份按错误格式生成的残缺文件。
     */
    const buildSnapshot = useCallback(async (): Promise<{
      title: string;
      bodyHtml: string;
      footerNote?: string;
    } | null> => {
      if (snapshotBusyRef.current) {
        notify('正在生成导出内容，请稍候…', 'warning');
        return null;
      }
      snapshotBusyRef.current = true;
      try {
        const prepare = prepareSubmitRef.current;
        if (!prepare) {
          notify('导出失败：编辑器还没准备好，请稍后再试', 'error');
          return null;
        }
        const prepared = await prepare();
        if (prepared.blocked) {
          notify(`导出失败：${prepared.blocked.message}`, 'error');
          return null;
        }
        const bodyHtml = await renderStaticMarkup({
          source: prepared.content,
          format: prepared.format,
          // 导出跟随当前预览口径（终审 F2）：访客视角预览是 external 时，
          // 私有剪贴板 / 投票 / 收藏夹保留字面量，导出件不得越过同一边界。
          referenceMode,
        });
        return {
          title,
          bodyHtml,
          footerNote: prepared.format === 'reactive' ? REACTIVE_EXPORT_NOTE : undefined,
        };
      } catch {
        notify('导出失败：正文没能渲染出来，请稍后再试', 'error');
        return null;
      } finally {
        snapshotBusyRef.current = false;
      }
    }, [notify, title, referenceMode]);

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

    // ── 提交前的权威判定 ────────────────────────────────────────────────────
    /**
     * 等**当前正文**的分析落地，返回与判定同一份的提交快照。
     *
     * 这是唯一允许在提交路径上做一次完整编译的地方（一次保存一次）。三种情况都
     * 明确说出来，绝不静默按 Markdown 保存：
     *   · `invalid-enhanced` → 带诊断的 blocked（表单提示 + 保留草稿 + 不提交）；
     *   · 分析器不可用 / 抛错 → blocked（宁可让用户重试，也不猜）；
     *   · 正文在等待期间又变了 → 用新正文重来（最多 3 次），仍不稳定就 blocked。
     */
    const prepareSubmit = useCallback(async (): Promise<EditorSubmitSnapshot> => {
      const currentSource = () =>
        viewRef.current?.state.doc.toString() ?? docRef.current;

      // 已保存为 reactive 的文档是**唯一下限**：即使删光组件也不自动降级。
      // 「插入过组件」不是下限 —— 新建 Markdown 插了又删光时，最终保存按本次
      // 分析判定（无增强语法就是 markdown），否则会凭空改写文档格式。
      const floorReactive = formatFloorRef.current === 'reactive';
      for (let attempt = 0; attempt < SUBMIT_ANALYSIS_ATTEMPTS; attempt += 1) {
        const content = currentSource();
        if (!mightContainReactiveSyntax(content)) {
          return {
            content,
            format: floorReactive ? 'reactive' : 'markdown',
            syntaxVersion: floorReactive ? syntaxVersionRef.current : null,
            blocked: null,
          };
        }
        const analyzer = analyzerRef.current;
        if (!analyzer) {
          return {
            content,
            format: 'reactive',
            syntaxVersion: syntaxVersionRef.current,
            blocked: {
              message: '编辑器还没准备好检查正文格式，请稍后再保存',
              diagnostics: [],
            },
          };
        }
        const revision = (analysisRevisionRef.current += 1);
        const generation = documentGenerationRef.current;
        let result: FormatAnalysis;
        try {
          result = await analyzer.analyze(content, revision);
        } catch {
          return {
            content,
            format: 'reactive',
            syntaxVersion: syntaxVersionRef.current,
            blocked: {
              message: '无法检查正文格式，请稍后再试；草稿已经保留',
              diagnostics: [],
            },
          };
        }
        // 等待期间用户又改了正文 —— 这一份不再是「当前」，用新正文重来。
        if (
          result.effective === 'superseded' ||
          result.revision !== revision ||
          generation !== documentGenerationRef.current ||
          currentSource() !== content
        ) {
          continue;
        }
        // 与实时分析共用同一份结果：提交完的界面计数不该回到上一版。
        if (analysisRevisionRef.current === revision) {
          setFormatAnalysis(result);
          setAnalysisPending(false);
          setAnalysisFailure(null);
          // 提交路径也可能拿到更新的 authoring analysis（例如刚打开就保存，
          // 实时防抖还没回来）。不贴回装饰会让语法着色停在上一次结果上。
          const nextAuthor = result.author ?? null;
          authorAnalysisSourceRef.current = nextAuthor ? content : null;
          setAuthorAnalysis(nextAuthor);
          setAnalysisFallback(result.fallback);
        }
        const diagnostics: EditorDiagnostic[] = result.diagnostics;
        if (result.effective === 'invalid-enhanced') {
          return {
            content,
            format: 'reactive',
            syntaxVersion: result.syntaxVersion ?? syntaxVersionRef.current,
            blocked: {
              message: '正文含无效的增强语法，已保留草稿；请按诊断修正后再保存',
              diagnostics,
            },
          };
        }
        // 解析器认识这份语法，但发布闸门（预算 / 降级 / 未知宿主）仍可能拒绝。
        // 服务端会 400 —— 前端必须同样拦下并给出诊断，而不是只回一句通用错误。
        //
        // 这条判定**对 markdown 同样成立**：effective='markdown' 但 publishable=false
        // （典型：超预算的未闭合 `<` / `{{`）时，若按 markdown 交给表单，服务端只会
        // 回通用 400，本地预算诊断整段丢失（R3-141）。所以不按 effective 分叉。
        const reactive = result.effective === 'reactive' || floorReactive;
        if (!result.publishable) {
          return {
            content,
            format: reactive ? 'reactive' : 'markdown',
            syntaxVersion: reactive ? (result.syntaxVersion ?? syntaxVersionRef.current) : null,
            blocked: {
              message: '正文暂时不能发布，请按诊断修正后再保存',
              diagnostics,
            },
          };
        }
        if (result.syntaxVersion) syntaxVersionRef.current = result.syntaxVersion;
        return {
          content,
          format: reactive ? 'reactive' : 'markdown',
          syntaxVersion: reactive ? (result.syntaxVersion ?? syntaxVersionRef.current) : null,
          blocked: null,
        };
      }

      return {
        content: currentSource(),
        format: effectiveFormatRef.current,
        syntaxVersion: syntaxVersionRef.current,
        blocked: {
          message: '正文仍在变化，暂时无法确定格式，请稍后再保存',
          diagnostics: [],
        },
      };
    }, []);

    // ── 对外接口 ────────────────────────────────────────────────────────────
    useImperativeHandle(
      ref,
      (): MarkdownEditorHandle => ({
        getDoc: () => viewRef.current?.state.doc.toString() ?? docRef.current,
        isReady: () => viewRef.current !== null,
        clearDraft: () => draftRef.current?.clear(),
        flushDraft: () => draftRef.current?.flush(),
        focus: () => viewRef.current?.focus(),
        getFormat: () => effectiveFormatRef.current,
        getSyntaxVersion: () => syntaxVersionRef.current,
        prepareSubmit,
        pinSavedFormat: (savedFormat, savedVersion) => {
          // 只升不降：保存成 markdown 不会撤销已经保存过的 reactive 身份。
          if (savedFormat !== 'reactive') return;
          if (savedVersion) syntaxVersionRef.current = savedVersion;
          if (savedReactiveFloorRef.current) return;
          // 同步写 ref：表单的成功回调可能紧接着就发起下一笔，不能等重渲染。
          savedReactiveFloorRef.current = true;
          setSavedReactiveFloor(true);
          formatFloorRef.current = 'reactive';
          effectiveFormatRef.current = 'reactive';
        },
      }),
      [prepareSubmit]
    );
    // buildSnapshot 定义在 prepareSubmit 之前，用引用拿到最新实现。
    prepareSubmitRef.current = prepareSubmit;

    /** 恢复旧草稿：整体替换正文，并把它作为一次可撤销的操作留下。 */
    function applyDraft(value: string) {
      const v = viewRef.current;
      if (v) {
        v.dispatch({
          changes: { from: 0, to: v.state.doc.length, insert: value },
          selection: { anchor: value.length },
        });
      }
      // dispatch 会经 updateListener 先排一份「当前（旧）格式 + 恢复后的正文」。
      // 表单若接受草稿的格式，那一份里的格式就是过期值 —— 恢复后立刻关页，
      // 落盘的就是格式错位的那一份。这里明确再排一次，把**最终正文与最终格式
      // 一起**写下去（schedule 替换掉前一份）；表单没接这个回调时，最终格式
      // 仍是表单当前那一档，两份保持一致。
      const restoredFormat = restoredDraftFormatRef.current;
      const restoredVersion = restoredDraftVersionRef.current;
      syntaxVersionRef.current = restoredVersion;
      let finalFormat = effectiveFormatRef.current;
      if (restoredFormat !== effectiveFormatRef.current && onDraftFormatRestored) {
        onDraftFormatRestored(restoredFormat);
        finalFormat = restoredFormat;
      }
      if (restoredVersion !== (initialSyntaxVersion ?? null)) {
        onDraftSyntaxVersionRestored?.(restoredVersion);
      }
      draftRef.current?.schedule({
        format: finalFormat,
        text: value,
        syntaxVersion: restoredVersion,
      });
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
          reactive={effectiveFormat === 'reactive'}
          onRequestCompletions={
            effectiveFormat === 'reactive' ? requestCompletions : undefined
          }
          onFormat={formatAuthoringDocument}
          onComponentInserted={() => setComponentInserted(true)}
          onPickFiles={() => fileInputRef.current?.click()}
          onOpenResources={openResources}
          onExportHtml={onExportHtml}
          onPrint={onPrint}
        />

        {/*
          诊断条：增强语法（含无效的）或确实有诊断时才出现。默认收起，只在标题行
          显示「检查中 / 错误 N · 警告 M / 未发现问题」。普通 Markdown 不占版面。

          ⚠️ 唯一的例外是 worker 回退（`analysisActive && analysisFallback`）：
          纯 Markdown 里只要有一个 `<`，格式检查就会在主线程跑，这时必须说一句
          「本地检查」；否则用户只感到变卡，而页面上一切正常（终审 F4）。
          普通正文没在检查时不排编译，也不会出现这块技术提示。
        */}
        {(effectiveFormat === 'reactive' ||
          invalidEnhanced ||
          analysisFailure !== null ||
          (analysisActive && analysisFallback) ||
          (formatAnalysis?.candidates.length ?? 0) > 0) && (
          <ReactiveAuthoringPanel
            diagnostics={formatAnalysis?.diagnostics ?? []}
            localized={formatAnalysis !== null}
            pending={analysisPending}
            failure={analysisFailure}
            fallback={analysisFallback}
            completions={authoringCompletions}
            status={authoringStatus}
            onSelectCompletion={pickCompletion}
            onCloseCompletions={() => setAuthoringCompletions(null)}
            onRevealDiagnostic={revealDiagnostic}
          />
        )}

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
              {/* 本地控件可操作，但预览不发任何业务写请求（投票 / 收藏只读）。 */}
              <span className="md-editor__preview-label">预览</span>
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
              {/*
                预览**全部**走统一引擎：普通 Markdown 与增强文档同一份 compat /
                引用适配 / 编译选项，避免「预览一套、阅读另一套」。Markdown 父
                文档同样传 format，Markdown 子剪贴板按约定内联一层。
              */}
              <ReactivePreview
                key={`${referenceMode}:${effectiveFormat}`}
                source={previewDoc}
                refreshToken={refreshToken}
                referenceMode={referenceMode}
                format={effectiveFormat}
              />
            </div>
          </div>
        </div>

        <div className="md-editor__foot">
          <span className="md-editor__count numeric" aria-live="polite">
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
