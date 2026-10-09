// ─────────────────────────────────────────────────────────────────────────────
// file-converter/engines/ffmpeg.ts —— FFmpeg.wasm 引擎封装（懒加载单例）。
//
// 【它是什么】@ffmpeg/ffmpeg 0.12.15 + @ffmpeg/core 0.12.10（单线程核心）的
//   加载（ensureFFmpeg）、探测（probe）、执行（exec）、终止（terminateFFmpeg）
//   与能力清单（getFFmpegState 的 encoders / decoders）的唯一入口。音频 / 视频
//   两个能力区的 runner 经 `await import('../engines/ffmpeg')` 动态引入本模块
//   —— 静态 import 会把 31MB 核心的加载路径卷进每个页面的主包。
//
// 【资产】核心文件全部从**同源** `/static/converter/ffmpeg/` 加载
//   （scripts/copy-converter-assets.mjs 从锁版本的 npm 包拷出；版本目录名 =
//   @ffmpeg/core 的 package.json version）。资产是同源 URL，直接给字符串，
//   **不走 toBlobURL**（那是给跨域 CDN 资产用的）。用户文件字节绝不出站。
//
// 【⚠️ 取消 / 超时的代价】0.12 的 exec 在 worker 里**同步**驱动 wasm 核心，
//   没有「只中断当前命令」的接口 —— 唯一的杀法是 terminate() 掉整个 worker，
//   已加载的 31MB 核心随之销毁。所以 exec 的 signal abort / withTimeout 超时
//   之后，本模块复位 loaded 状态：下一次 ensureFFmpeg 会**重新下载并加载整个
//   核心**（浏览器 HTTP 缓存通常能挡住重复下载，但 wasm 编译那一遍躲不掉）。
//   这是引擎协议决定的代价，调用方别指望「取消很便宜」。
//
// 【串行】全局只有一个核心（一个 worker、一份 MEMFS）。exec / probe 经内部
//   promise 链串行 —— 外层任务队列（queue.ts）已是串行，这里是双保险：
//   两路并发写同一个 MEMFS、交错收 log 通道，坏起来没有任何报错。
//
// 【输出契约】exec 非零退出抛 {kind, message, detail}（detail 是 stderr 尾部
//   ~1500 字）；一切方法尊重 AbortSignal（cancelled 透传，不包装）。
// ─────────────────────────────────────────────────────────────────────────────

import { LIMITS } from '../formats';
import type { ConvertError, ErrorKind } from '../types';
import { classifyError, withTimeout } from '../utils';
import {
  parseDecoders,
  parseEncoders,
  parseProbe,
  type ParsedProbeResult,
  type ParsedProbeStream,
} from './ffmpeg-parse';
import type { FFmpeg, LogEvent, ProgressEvent } from '@ffmpeg/ffmpeg';

/** ffmpeg 引擎状态（能力探测报告的直接来源）。 */
export interface FFmpegState {
  loaded: boolean;
  loading: boolean;
  encoders: string[];
  decoders: string[];
  error?: string;
}

// 导出名与契约保持 Stub 形状；定义在零依赖的 ffmpeg-parse.ts（node 单测直驱）。
export type ProbeStream = ParsedProbeStream;
export type ProbeResult = ParsedProbeResult;

/**
 * 核心版本目录 —— 必须与 scripts/copy-converter-assets.mjs 拷出的目录名一致
 * （那边读 node_modules/@ffmpeg/core/package.json 的 version；升级核心时两边一起动）。
 */
export const FFMPEG_CORE_VERSION = '0.12.10';

const CLASS_WORKER_URL = '/static/converter/ffmpeg/worker.js';
const CORE_URL = `/static/converter/ffmpeg/${FFMPEG_CORE_VERSION}/ffmpeg-core.js`;
const WASM_URL = `/static/converter/ffmpeg/${FFMPEG_CORE_VERSION}/ffmpeg-core.wasm`;

/** 引擎加载失败给用户的一句话（detail 里带真实原因）。 */
const ENGINE_LOAD_MESSAGE = '转换引擎加载失败（约 30MB，请检查网络后重试）';

/** exec 返回的完整 log 的内存上限（超出截断并标注；进度行是主要来源）。 */
const LOG_CAP = 512 * 1024;

// ─── 模块级单例状态 ────────────────────────────────────────────────────────────
//
// 本模块只经动态 import 进客户端包，模块实例在一份编译产物里唯一；
// 不需要 globalThis（那是 instrumentation.ts 双编译才需要的手段）。

let ffmpeg: FFmpeg | null = null;
let loaded = false;
let loading = false;
let encoders: string[] = [];
let decoders: string[] = [];
let loadError: string | undefined;
/** 进行中的加载 Promise（并发 ensureFFmpeg 共享同一份；为空 = 没在加载）。 */
let loadPromise: Promise<void> | null = null;
/** exec / probe 串行链（永不 reject —— 失败只影响本次调用方）。 */
let execChain: Promise<unknown> = Promise.resolve();

export function getFFmpegState(): FFmpegState {
  return {
    loaded,
    loading,
    encoders: encoders.slice(),
    decoders: decoders.slice(),
    ...(loadError !== undefined ? { error: loadError } : {}),
  };
}

// ─── 加载 ──────────────────────────────────────────────────────────────────────

export async function ensureFFmpeg(
  onProgress?: (p: number | null, message?: string) => void
): Promise<void> {
  if (loaded) return;
  if (loadPromise) return loadPromise;
  loadPromise = doLoad(onProgress);
  try {
    await loadPromise;
  } finally {
    // 成功：loaded=true 让下次调用早退；失败：置空允许下次重试。
    loadPromise = null;
  }
}

async function doLoad(
  onProgress?: (p: number | null, message?: string) => void
): Promise<void> {
  loading = true;
  loadError = undefined;
  onProgress?.(null, '正在加载转换组件（约 30MB，仅首次）');
  let logBuf: string[] = [];
  const onLog = (ev: LogEvent) => {
    logBuf.push(ev.message);
  };
  let instance: FFmpeg | null = null;
  try {
    instance = new (await import('@ffmpeg/ffmpeg')).FFmpeg();
    ffmpeg = instance;
    instance.on('log', onLog);
    await withTimeout(
      instance.load({ classWorkerURL: CLASS_WORKER_URL, coreURL: CORE_URL, wasmURL: WASM_URL }),
      LIMITS.timeouts.ffmpegLoadMs,
      '转换组件加载超时'
    );
    // 能力清单：-encoders / -decoders 各跑一次，文本从 log 通道收。
    // （exec 只回退出码；清单打在 stdout，wasm 核心把 stdout/stderr 都走 log。）
    logBuf = [];
    await withTimeout(
      instance.exec(['-hide_banner', '-encoders']),
      LIMITS.timeouts.probeMs,
      '编码器清单探测超时'
    );
    const enc = parseEncoders(logBuf.join('\n'));
    logBuf = [];
    await withTimeout(
      instance.exec(['-hide_banner', '-decoders']),
      LIMITS.timeouts.probeMs,
      '解码器清单探测超时'
    );
    const dec = parseDecoders(logBuf.join('\n'));
    if (ffmpeg !== instance) {
      // 加载期间被 terminateFFmpeg 杀掉（页面侧主动终止）：不接管状态，直接丢弃。
      try {
        instance.terminate();
      } catch {
        /* 已死 */
      }
      throw { kind: 'cancelled', message: '已取消' } satisfies ConvertError;
    }
    encoders = enc;
    decoders = dec;
    loaded = true;
  } catch (e) {
    if (isKind(e, 'cancelled')) throw e; // 上面的「加载期间被终止」分支透传
    const msg = errorMessage(e);
    const tail = logBuf.length ? `\n${logBuf.slice(-20).join('\n')}` : '';
    const detail = (msg + tail).slice(0, 1500);
    if (instance && ffmpeg === instance) {
      loaded = false;
      loadError = detail.slice(0, 300);
      ffmpeg = null;
    }
    try {
      instance?.terminate();
    } catch {
      /* 已死 */
    }
    throw { kind: 'engine-load', message: ENGINE_LOAD_MESSAGE, detail } satisfies ConvertError;
  } finally {
    loading = false;
    instance?.off('log', onLog);
  }
}

// ─── 探测 ──────────────────────────────────────────────────────────────────────

export async function probe(
  bytes: Uint8Array,
  ext: string,
  timeoutMs: number = LIMITS.timeouts.probeMs
): Promise<ProbeResult> {
  return enqueue(async () => {
    await ensureFFmpeg();
    const instance = requireInstance();
    // ext 只用于内部文件名（ffmpeg 按扩展名猜 demuxer）；白名单形状，防注入 FS 路径。
    const safeExt = /^[a-z0-9]{1,8}$/i.test(ext) ? ext.toLowerCase() : 'bin';
    const name = `in.${safeExt}`;
    const log = makeLogCollector(256 * 1024);
    instance.on('log', log.onLog);
    try {
      await instance.writeFile(name, copyBytes(bytes));
      // `-i` 必然非零退出（ffmpeg 要求输出文件）—— 退出码在这里**不是**失败判据，
      // 探测信息全在 stderr（wasm 核心经 log 通道上来）。
      await withTimeout(instance.exec(['-hide_banner', '-i', name]), timeoutMs, '读取媒体信息超时');
      const parsed = parseProbe(log.text());
      if (!parsed.formatName && parsed.streams.length === 0) {
        throw {
          kind: 'corrupt',
          message: '无法读取媒体信息，文件可能损坏或格式不受支持',
          detail: log.text().slice(-1500),
        } satisfies ConvertError;
      }
      return parsed;
    } catch (e) {
      // 超时后核心可能还在跑这条命令：整个杀掉，下次 ensureFFmpeg 重载（见文件头）。
      if (isKind(e, 'timeout')) terminateFFmpeg();
      throw classifyError(e, '无法读取媒体信息');
    } finally {
      instance.off('log', log.onLog);
      await deleteQuietly(instance, name);
    }
  });
}

// ─── 执行 ──────────────────────────────────────────────────────────────────────

/** ffmpeg 串输出占位符：`%04d` / `%d`（image2 滤镜与抽帧的产物名）。 */
const SEQ_PLACEHOLDER = /%(?:0(\d+))?d/;

/**
 * **纯函数**：串输出模式 + 目录里的文件名 → 展开后的文件名（按帧序排序）。
 *
 * 【为什么必须有这一步】调用方给的是「模式」而不是文件名单 —— ffmpeg 的
 * image2 会按帧数写出 frame-0001.png、frame-0002.png……。而 exec 的回读是按
 * 字面名逐个 readFile 的，模式串本身**从来不是文件**，于是抽帧类边会拿到一个
 * 空 Map，症状是「退出码 0 但未产生有效输出」。这里的展开把它们对上。
 *
 * 只认一个数字占位符（我们的抽取都只用一个）。返回 `null` = 这个模式里没有
 * 占位符（调用方按字面名处理，行为不变）。
 *
 * 【占位符宽度是硬判据】`%04d` 只认 4 位数 —— 帧数溢出到 5 位时 ffmpeg 会
 * 改用更宽的名字，此时**匹配不到就是没产出**（调用方据此报错），不会错配成
 * 别的任务残留的文件。
 */
export function expandSeqPattern(pattern: string, names: string[]): string[] | null {
  const m = SEQ_PLACEHOLDER.exec(pattern);
  if (!m) return null;
  const width = m[1] ? Number(m[1]) : 0;
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(
    `^${esc(pattern.slice(0, m.index))}(${width > 0 ? `\\d{${width}}` : '\\d+'})${esc(pattern.slice(m.index + m[0].length))}$`
  );
  return names
    .filter((n) => re.test(n))
    .sort((a, b) => seqIndexOf(a) - seqIndexOf(b));
}

/** 取文件名里那个数字（用于帧序排列）；取不到给 0。 */
function seqIndexOf(name: string): number {
  const m = /(\d+)(?!.*\d)/.exec(name);
  return m ? Number(m[1]) : 0;
}

/** 对 MEMFS 的列目录结果套用 expandSeqPattern（含子目录前缀还原）。 */
async function expandOutputNames(
  instance: { listDir: (path: string) => Promise<{ name: string; isDir: boolean }[]> },
  outputNames: string[]
): Promise<string[]> {
  const out: string[] = [];
  for (const name of outputNames) {
    const dir = name.includes('/') ? name.slice(0, name.lastIndexOf('/')) : '';
    const base = dir ? name.slice(dir.length + 1) : name;
    let entries: { name: string; isDir: boolean }[] = [];
    try {
      entries = await instance.listDir(dir);
    } catch {
      continue; // 目录都列不出来 = 没产出，交调用方判
    }
    const matched = expandSeqPattern(
      base,
      entries.filter((e) => !e.isDir).map((e) => e.name)
    );
    if (matched === null) {
      out.push(name); // 字面输出名，原样
      continue;
    }
    out.push(...matched.map((n) => (dir ? `${dir}/${n}` : n)));
  }
  return out;
}

export async function exec(
  args: string[],
  inputs: { name: string; data: Uint8Array }[],
  outputNames: string[],
  opts: { timeoutMs: number; onProgress?: (p: number | null) => void; signal?: AbortSignal }
): Promise<{ files: Map<string, Uint8Array>; log: string }> {
  return enqueue(async () => {
    await ensureFFmpeg();
    const instance = requireInstance();
    if (opts.signal?.aborted) throw { kind: 'cancelled', message: '已取消' } satisfies ConvertError;

    const log = makeLogCollector(LOG_CAP);
    const onProgress = (ev: ProgressEvent) => {
      if (!opts.onProgress) return;
      const p = ev.progress;
      // 0..1 比例直接转发；NaN / >1 / 负值 = 不确定进度
      if (typeof p === 'number' && Number.isFinite(p) && p >= 0 && p <= 1) opts.onProgress(p);
      else opts.onProgress(null);
    };
    const onAbort = () => {
      // wasm 核心无法软中断（见文件头）：杀整个 worker，状态复位待重载
      terminateFFmpeg();
    };

    instance.on('log', log.onLog);
    instance.on('progress', onProgress);
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    // 展开后的真实输出名 —— 在 try 外声明，好让 finally 一并清理它们。
    let realNames: string[] = outputNames;

    try {
      for (const input of inputs) {
        if (opts.signal?.aborted) throw { kind: 'cancelled', message: '已取消' } satisfies ConvertError;
        await instance.writeFile(input.name, copyBytes(input.data));
      }
      // 核心自带超时参数不传（-1）：超时语义由 withTimeout 统一掌管，
      // 超时即 terminateFFmpeg 复位 —— 核心自己限时返回的是非零码，与普
      // 通失败不可区分，错误分类会错。
      const code = await withTimeout(
        instance.exec(args, -1, opts.signal ? { signal: opts.signal } : undefined),
        opts.timeoutMs,
        '转换执行超时'
      );
      if (opts.signal?.aborted) throw { kind: 'cancelled', message: '已取消' } satisfies ConvertError;
      if (code !== 0) {
        throw {
          kind: kindFromLog(log.text()),
          message: '转换执行失败',
          detail: log.text().slice(-1500),
        } satisfies ConvertError;
      }
      // 串输出模式（frame-%04d.png）先展开成真实文件名，再逐个回读。
      realNames = await expandOutputNames(instance, outputNames);
      const files = new Map<string, Uint8Array>();
      for (const outName of realNames) {
        if (opts.signal?.aborted) throw { kind: 'cancelled', message: '已取消' } satisfies ConvertError;
        try {
          const data = await instance.readFile(outName);
          // 退出码 0 但输出缺失（如滤镜没匹配到帧）：不进 Map，由调用方
          // （takeOutput）带 log 报「未产生有效输出」—— 比在这里抛笼统错更有诊断价值。
          if (typeof data !== 'string') files.set(outName, data);
        } catch {
          /* 同上：缺失交调用方判 */
        }
      }
      return { files, log: log.text() };
    } catch (e) {
      if (opts.signal?.aborted) {
        throw { kind: 'cancelled', message: '已取消' } satisfies ConvertError;
      }
      if (isKind(e, 'timeout')) terminateFFmpeg(); // 见文件头「取消 / 超时的代价」
      throw classifyError(e, '转换执行失败');
    } finally {
      instance.off('log', log.onLog);
      instance.off('progress', onProgress);
      opts.signal?.removeEventListener('abort', onAbort);
      // 清理 MEMFS（尽力而为）：两次 exec 之间 FS 是共享的，残留文件会白占
      // wasm 内存；核心已被 terminate 时 deleteFile 会拒，静默吞掉。
      // 用 realNames：串输出会写出成百上千个帧文件，不清理的话一次次抽帧攒起来
      // 必然把 wasm 内存吃光。
      for (const n of [...inputs.map((i) => i.name), ...realNames]) {
        await deleteQuietly(instance, n);
      }
    }
  });
}

// ─── 终止 ──────────────────────────────────────────────────────────────────────

/** 同步终止核心并复位状态。进行中 / 排队中的调用会以 cancelled / terminated 收场。 */
export function terminateFFmpeg(): void {
  const instance = ffmpeg;
  ffmpeg = null;
  loaded = false;
  loading = false;
  encoders = [];
  decoders = [];
  // loadPromise 不清：在飞的 doLoad 会因 worker 死亡而 reject，其 catch 发现
  // `ffmpeg !== instance` 后不写状态，错误照常抛给那一处的 awaiter。
  try {
    instance?.terminate();
  } catch {
    /* 已死 */
  }
}

// ─── 内部件 ────────────────────────────────────────────────────────────────────

/** 串行链：上一次无论成败都接着跑本次；链本身永不 reject。 */
function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const result = execChain.then(task, task);
  execChain = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}

function requireInstance(): FFmpeg {
  if (!ffmpeg) {
    throw { kind: 'engine-load', message: ENGINE_LOAD_MESSAGE, detail: '引擎实例缺失' } satisfies ConvertError;
  }
  return ffmpeg;
}

/**
 * writeFile 会把传入 Uint8Array 的 buffer **transfer** 进 worker（调用方那份
 * 随即被清空）。调用方可能复用原字节（如 GIF 双遍的第二遍还要喂同一输入），
 * 所以进引擎前一律复制一份。
 */
function copyBytes(data: Uint8Array): Uint8Array {
  return data.slice();
}

function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'object' && e !== null && 'message' in e) {
    return String((e as { message: unknown }).message);
  }
  return String(e);
}

function isKind(e: unknown, kind: ErrorKind): boolean {
  return typeof e === 'object' && e !== null && (e as { kind?: unknown }).kind === kind;
}

/** 滚动日志收集器：到上限后停收并标注（长转码的进度行是主要来源）。 */
function makeLogCollector(cap: number): { onLog: (ev: LogEvent) => void; text: () => string } {
  let buf = '';
  let truncated = false;
  return {
    onLog: (ev: LogEvent) => {
      if (truncated) return;
      if (buf.length + ev.message.length + 1 > cap) {
        truncated = true;
        buf += '\n[日志过长，已截断]';
        return;
      }
      buf += (buf ? '\n' : '') + ev.message;
    },
    text: () => buf,
  };
}

/**
 * 非零退出时按 stderr 尾部文案归类（页面按 kind 决定用户文案）：
 * 容器损坏 / 编码缺失 / 内存耗尽各有明确说法；都不沾给 unknown。
 */
function kindFromLog(log: string): ErrorKind {
  const tail = log.slice(-4000).toLowerCase();
  if (/unknown encoder|unknown decoder|encoder .*not found|decoder .*not found/.test(tail)) {
    return 'capability';
  }
  if (/cannot allocate memory|out of memory/.test(tail)) return 'budget';
  if (/invalid data found|moov atom not found|corrupt|truncated file/.test(tail)) return 'corrupt';
  return 'unknown';
}

async function deleteQuietly(instance: FFmpeg, name: string): Promise<void> {
  try {
    await instance.deleteFile(name);
  } catch {
    /* 文件不存在或核心已死：都无需处理 */
  }
}
