// ─────────────────────────────────────────────────────────────────────────────
// file-converter/types.ts —— 格式转换器的**全部公共类型契约**
//
// 【它是什么】任务、结果、参数、能力登记表（EdgeDef / CategoryDef）、嗅探结果、
// 引擎句柄的形状定义。八个能力区（图片/音频/视频/文档/表格/文本/电子书/压缩包）
// 的 category 模块与引擎模块都按这里的形状对接，页面（ConverterApp）只认识这些类型。
//
// 【纪律】
//   · 本文件**零 import、零运行时代码**（只有类型与一个 const 断言辅助）。它会被
//     node 环境的单元测试 import —— 拖进 DOM 库、fflate 之类都行不通（会拖垮
//     「契约可单测」这条设计）。需要共享的运行时常量住 formats.ts。
//   · 新增字段时想清楚「谁会读它」：页面只读这里的字段展示，引擎只写这里的字段。
//     引擎私有的中间类型别放进来。
// ─────────────────────────────────────────────────────────────────────────────

/** 八个能力区（roadmap §1）。`document` 在 UI 上是一个标签页，由 pdf + office 两组合并。 */
export type CategoryKey =
  | 'image'
  | 'audio'
  | 'video'
  | 'document'
  | 'table'
  | 'text'
  | 'ebook'
  | 'archive';

/** 六种转换方式（roadmap §2）。结果说明里照实标注用的是哪一种。 */
export type ConvertMethod =
  | 'remux' // 换封装：不重编码
  | 'reencode' // 重新编码
  | 'reflow' // 重排版 / 结构转换
  | 'map' // 数据映射
  | 'extract' // 信息提取 / 重建
  | 'repack'; // 解包后重打包

/** 任务状态机（plan §6.3）。 */
export type TaskStatus =
  | 'validating'
  | 'queued'
  | 'loading-engine'
  | 'probing'
  | 'converting'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

/** 错误分类（plan §9.1）。页面按 kind 决定用户文案与「可否重试」。 */
export type ErrorKind =
  | 'unsupported' // 格式 / 类别不支持
  | 'oversize' // 超大小 / 像素 / 时长 / 页数等限额
  | 'corrupt' // 损坏 / 无法解码
  | 'capability' // 浏览器 / 引擎缺能力
  | 'engine-load' // 引擎加载失败
  | 'timeout'
  | 'cancelled'
  | 'budget' // 输出预算不足
  | 'unknown';

export interface ConvertError {
  kind: ErrorKind;
  /** 给用户看的一句话。 */
  message: string;
  /** 本地诊断细节（引擎 stderr 摘要等），折叠展示。 */
  detail?: string;
}

/** 一个输出文件。多数转换只有一个；帧序列等多输出由调用方先打包再交付。 */
export interface OutputFile {
  blob: Blob;
  /** 最终下载名（已规范化、已去重）。 */
  name: string;
  /** 这一份输出的补充说明（如「第 3 页」）。 */
  note?: string;
}

/** 转换产物。两类引擎（各 category 的 runner）都输出同一结构（plan §6.3）。 */
export interface ConvertResultData {
  outputs: OutputFile[];
  /** 实际输出 MIME（与字节一致，已校验）。 */
  mime: string;
  /** 实际输出扩展名（不带点，小写）。 */
  ext: string;
  inputSize: number;
  outputSize: number;
  /** 保留与损失说明（「视频保持，音频重新编码」「动画未保留」…），结果页照实列出。 */
  notices: string[];
  /** 页面用哪种预览。text 预览读 outputs[0] 的前若干 KB。 */
  previewKind: 'image' | 'audio' | 'video' | 'text' | 'none';
}

// ─── 参数 ────────────────────────────────────────────────────────────────────

export interface ParamOption {
  value: string;
  label: string;
}

export type ParamType = 'select' | 'range' | 'number' | 'color' | 'checkbox' | 'text';

export interface ParamSpec {
  key: string;
  label: string;
  type: ParamType;
  /**
   * select 的选项。可以是函数：在文件识别（inspect）之后动态生成，
   * 例如「选工作表」「选音轨」「选页码范围」。
   */
  options?: ParamOption[] | ((info: InspectInfo | null) => ParamOption[]);
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  defaultValue: string | number | boolean;
  help?: string;
  /** 高级选项：默认折叠（roadmap §1「默认给推荐目标与少量重要参数」）。 */
  advanced?: boolean;
  visibleIf?: (params: Record<string, unknown>) => boolean;
}

// ─── 内容识别 ────────────────────────────────────────────────────────────────

/**
 * 嗅探出的真实文件种类。**以字节为准**（plan §9.1「以内容为准识别」）。
 * `unknown` = 认不出 —— 调用方按「不支持」拒绝，不按扩展名猜。
 */
export type FileKind =
  | 'jpeg'
  | 'png'
  | 'gif'
  | 'webp'
  | 'bmp'
  | 'tiff'
  | 'ico'
  | 'svg'
  | 'heic'
  | 'avif'
  | 'mp3'
  | 'wav'
  | 'flac'
  | 'm4a'
  | 'ogg'
  | 'aiff'
  | 'mp4'
  | 'mkv'
  | 'webm'
  | 'mov'
  | 'avi'
  | 'flv'
  | 'wmv'
  | 'pdf'
  | 'zip'
  | 'gzip'
  | 'xz'
  | 'tar'
  | '7z'
  | 'rar'
  | 'epub'
  | 'docx'
  | 'xlsx'
  | 'pptx'
  | 'odt'
  | 'ods'
  | 'odp'
  | 'rtf'
  | 'doc'
  | 'xls'
  | 'ppt'
  | 'json'
  | 'ndjson'
  | 'xml'
  | 'yaml'
  | 'csv'
  | 'tsv'
  | 'srt'
  | 'vtt'
  | 'ass'
  | 'html'
  | 'markdown'
  | 'text'
  | 'unknown';

export interface SniffResult {
  kind: FileKind;
  /** 按内容给出的可信 MIME。 */
  mime: string;
  /** 建议规范扩展名（不带点）。 */
  ext: string;
  /** 补充说明（如「ZIP 容器，实为 EPUB」）。 */
  detail?: string;
}

/** 压缩包成员（archive 能力区的成员预览）。 */
export interface ArchiveMemberInfo {
  path: string;
  size: number;
  compressedSize?: number;
  isDir: boolean;
}

/**
 * inspect 的结果：识别 + 轻量元信息。**不重解码**：
 * 图片读头拿尺寸 / 动画标记；媒体的时长 / 声道要等任务执行时探测（plan §5.2）。
 */
export interface InspectInfo {
  sniff: SniffResult;
  name: string;
  size: number;
  // 图片
  width?: number;
  height?: number;
  animated?: boolean;
  // 文档 / 表格 / 包（轻量可读时填）
  pageCount?: number;
  sheets?: string[];
  members?: ArchiveMemberInfo[];
  /** 音视频的轨清单（CategoryDef.probe 填；probe 需要加载引擎，只在做选择时跑）。 */
  streams?: StreamInfo[];
  /** 额外键值（如 EPUB 标题）。 */
  extra?: Record<string, string>;
}

/** 一条媒体轨（ffmpeg 探测结果的零依赖投影）。 */
export interface StreamInfo {
  index: number;
  type: 'video' | 'audio' | 'subtitle' | 'other';
  codec: string;
  channels?: number;
  sampleRate?: number;
  width?: number;
  height?: number;
  language?: string;
}

// ─── 能力探测报告 ────────────────────────────────────────────────────────────

/** 运行时能力（plan §3.1 / §3.2「按设备能力提供」）。页面加载时探测一次。 */
export interface CapabilityReport {
  /** Canvas 能真正编码 WebP / AVIF（试编码 + 字节核对，不是问 canPlayType）。 */
  webpEncode: boolean;
  avifEncode: boolean;
  /** 浏览器能原生解码 AVIF。 */
  avifDecode: boolean;
  /** Worker 可用（FFmpeg 引擎的前提）。 */
  workerOk: boolean;
  /**
   * FFmpeg 核心的编码器 / 解码器清单。**未加载前为 null**
   * （音频 / 视频目标在核心未加载时仍然展示，标注「首次使用需下载组件」；
   * 加载失败时才把对应目标标为不可用）。
   */
  ffmpeg: {
    loaded: boolean;
    encoders: string[];
    decoders: string[];
    error?: string;
  } | null;
}

// ─── 能力登记表（roadmap §12.1 的有向图边）───────────────────────────────────

export interface RunContext {
  /** 主输入。 */
  file: File;
  /** 附加输入（图片序列、PDF 合并的其余文件、批量打包的成员）。无附加输入时是 [file]。 */
  files: File[];
  /** inspect 的缓存结果（可能为 null —— 识别失败但边声明了自带识别）。 */
  inspect: InspectInfo | null;
  params: Record<string, unknown>;
  signal: AbortSignal;
  /** 进度 0..1；null = 不确定进度（只显示阶段文字）。 */
  onProgress: (p: number | null, message?: string) => void;
  /** 阶段迁移（loading-engine / probing / converting）。 */
  onPhase: (phase: TaskStatus) => void;
  capabilities: CapabilityReport;
}

/** 转换执行体。约定：**必须**校验输出非空且 MIME / 字节与声明一致后才 resolve。 */
export type Runner = (ctx: RunContext) => Promise<ConvertResultData>;

export interface EdgeDef {
  /** 全局唯一，如 `image:png-to-jpeg`。进任务记录与测试断言。 */
  id: string;
  /** 菜单里显示的目标名，如「JPG（便于分享）」。 */
  label: string;
  /** 这条边接受的输入 kinds（与 match 并用）。 */
  from: FileKind[];
  /** 输出格式（formats.ts 的键）。 */
  to: string;
  /** 六种转换方式之一 —— 结果说明会用它解释「这次转换改变了什么」。 */
  method: ConvertMethod;
  /** 这条边的保留 / 损失说明模板，逐条列在结果页。 */
  notices: string[];
  params: ParamSpec[];
  /**
   * 额外的内容判据（在 sniff 之后调用）。例如静态图边拒绝动画标记、
   * 音频边只接受单 / 双声道。不实现 = 只看 from。
   */
  match?: (info: InspectInfo) => boolean;
  /**
   * 这条边**展示前**需要的运行时能力。元素形如：
   *   'webp-encode' | 'avif-encode' | 'avif-decode' | 'worker'
   *   'ffmpeg'（核心可加载）| 'ffmpeg-enc:libmp3lame' | 'ffmpeg-dec:aac'
   * 能力不满足时该边不进菜单（roadmap：未验收的方向不出现在可执行菜单）。
   */
  requires?: string[];
  /** 预估输出字节数（null = 估不出）。用于输出预算的提前拒绝（plan §7.1）。 */
  estimateOutput?: (info: InspectInfo, params: Record<string, unknown>) => number | null;
  /** 执行体。`status: 'planned'` 的边**没有**实现（仅登记），故可选；
   *  live / gated 的边缺 run 会被 registryProblems 与执行器双重拦下。 */
  run?: Runner;
  /**
   * 建设状态（roadmap §12.1）：live = 已验收可执行；gated = 代码在但当前
   * 环境 / 构建不满足（不进菜单）；planned = 仅登记，不实现 run。
   */
  status: 'live' | 'gated' | 'planned';
  /** 边在类别菜单里的分组小标题（如「动图」「提取」「打包」）。 */
  group?: string;
}

export interface CategoryDef {
  key: CategoryKey;
  label: string;
  /** 标签页顶部的一行说明（能力范围与限制）。 */
  hint: string;
  /** 文件选择框的 accept 属性（提示用；真正的判据是 sniff）。 */
  accept: string;
  /** 一个任务最多带几个输入文件（1 = 单文件任务；>1 = 序列 / 合并 / 打包）。 */
  maxFilesPerTask: number;
  edges: EdgeDef[];
  /**
   * 深度探测（可选）：inspect 之后、展示参数之前调用，补充 `sheets` / `streams` /
   * `pageCount` 这类需要真读文件才知道的信息（可能加载引擎，页面只在选中
   * 该类别时对候选文件调用）。失败必须**自行降级**（返回 {}），不得抛。
   */
  probe?: (file: File, info: InspectInfo) => Promise<Partial<InspectInfo>>;
}

// ─── 任务 ────────────────────────────────────────────────────────────────────

export interface ConvertTask {
  id: string;
  /** 执行代次：重试 +1。异步回调必须校验 id + gen，旧代次结果不得覆盖（plan §6.3）。 */
  gen: number;
  category: CategoryKey;
  edgeId: string;
  /** 主文件名（展示用，已按纯文本渲染）。 */
  fileName: string;
  /** 所有输入的合计字节。 */
  fileSize: number;
  files: File[];
  /** 参数快照：开始转换那一刻冻结（plan §5.2）。 */
  params: Record<string, unknown>;
  inspect: InspectInfo | null;
  status: TaskStatus;
  progress: number | null;
  message?: string;
  result?: ConvertResultData;
  error?: ConvertError;
  /** 结果占用的输出预算字节（succeeded 后 = result.outputSize）。 */
  heldOutputBytes: number;
}

/** 队列对外快照（页面渲染用）。 */
export interface QueueSnapshot {
  tasks: ConvertTask[];
  /** 正在执行的任务 id（串行：最多一个）。 */
  activeId: string | null;
  /** 输出预算暂停中（等待用户释放结果）。 */
  budgetPaused: boolean;
  heldOutputTotal: number;
}
