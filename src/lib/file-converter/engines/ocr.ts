// ─────────────────────────────────────────────────────────────────────────────
// file-converter/engines/ocr.ts —— Tesseract.js OCR 封装（懒加载单例 worker）。
//
// 【它是什么】对一组图片逐张识别，返回每张的纯文本（顺序与输入一致）。
//   pdf 能力区（扫描 PDF → TXT / DOCX）先逐页渲染成图，再把图交给 `ocrImages`；
//   本模块不认识 PDF，只吃图片 Blob。
//
// 【资产从哪来】worker / 核心 / 语言数据全部从**同源** `/static/converter/tesseract/`
//   加载（scripts/copy-converter-assets.mjs 从锁版本的 npm 包拷出）。绝不走 CDN：
//   离线 / 内网部署会当场坏，且会把「访客在识别什么」发给第三方。用户图片字节不出站。
//
// 【单例复用】tesseract 的 worker 启动 + 加载语言模型很贵，所以本模块持有一个
//   **模块级单例**。切换语言用 `reinitialize`（比重建 worker 便宜）。终止（取消 / 超时 /
//   页面主动 terminate）会复位单例，下一次调用重建。
//
// 【取消 / 超时】tesseract 的 recognize **不接受** AbortSignal，也不支持只中断单张 ——
//   唯一的杀法是 terminate() 掉整个 worker。所以 signal abort 与每页超时都以
//   「terminate worker + 复位」收场（下一次重建，代价由调用方承担）。这与 ffmpeg.ts 的
//   取消费用同源：引擎协议决定，不是实现偷懒。
//
// 【语言数据缺失】assets 没拷（忘记 prepare:converter）时 createWorker 会因 404 拒绝 ——
//   归类为 engine-load 并带上真实原因，页面显示「OCR 引擎加载失败」而不是一张空白结果。
// ─────────────────────────────────────────────────────────────────────────────

import { LIMITS } from '../formats';
import type { ConvertError } from '../types';
import { withTimeout } from '../utils';

export type OcrLang = 'eng' | 'chi_sim' | 'chi_sim+eng';

const WORKER_PATH = '/static/converter/tesseract/worker.min.js';
const CORE_PATH = '/static/converter/tesseract/tesseract-core-simd-lstm.js';
const LANG_PATH = '/static/converter/tesseract/langs';

const ENGINE_LOAD_MESSAGE = 'OCR 引擎加载失败（语言数据约数十 MB，请检查网络后重试）';

// ─── tesseract.js 的最小运行时形状（本模块只用到这几点）────────────────────────

interface TesseractWorker {
  recognize(image: Blob): Promise<{ data: { text: string } }>;
  terminate(): Promise<unknown>;
  reinitialize(langs: string, oem: number): Promise<unknown>;
}

interface TesseractModule {
  createWorker(
    langs: string,
    oem: number,
    options: {
      workerPath: string;
      corePath: string;
      langPath: string;
      gzip: boolean;
      logger?: (m: { status: string; progress: number }) => void;
      errorHandler?: (e: unknown) => void;
    }
  ): Promise<TesseractWorker>;
  OEM: { LSTM_ONLY: number };
}

// ─── 模块级单例 ───────────────────────────────────────────────────────────────

let worker: TesseractWorker | null = null;
let workerLang: OcrLang | null = null;
/** 进行中的建 worker Promise（并发共享；为空 = 没在建）。 */
let creating: Promise<TesseractWorker> | null = null;
/** 当前 recognize 的日志接收器（worker 的 logger 回调转发到这里）。 */
let logSink: ((m: { status: string; progress: number }) => void) | null = null;

function isAbortedError(e: unknown): boolean {
  if (typeof e !== 'object' || e === null) return false;
  const k = (e as { kind?: unknown }).kind;
  return k === 'cancelled' || k === 'timeout';
}

/** 立刻终止并复位单例（同步；进行中的 recognize 会因此 reject）。 */
export function terminateOcr(): void {
  const w = worker;
  worker = null;
  workerLang = null;
  logSink = null;
  if (w) {
    void Promise.resolve(w.terminate()).catch(() => {
      /* 已经死了 */
    });
  }
}

async function loadTesseract(): Promise<TesseractModule> {
  const m = (await import('tesseract.js')) as unknown as { default?: TesseractModule } & Partial<TesseractModule>;
  return (m.default ?? m) as TesseractModule;
}

async function ensureWorker(lang: OcrLang, signal?: AbortSignal): Promise<TesseractWorker> {
  if (worker && workerLang === lang) return worker;
  // 语言不一致：用 reinitialize（比重建便宜）—— 但仅当现有 worker 健康时。
  if (worker && workerLang !== lang) {
    const w = worker;
    try {
      await withTimeout(w.reinitialize(lang, (await loadTesseract()).OEM.LSTM_ONLY), LIMITS.timeouts.ocrPageMs * 2, 'OCR 切换语言超时');
      workerLang = lang;
      return w;
    } catch (e) {
      if (isAbortedError(e)) throw e;
      // reinitialize 失败：退化为重建
      terminateOcr();
    }
  }
  if (creating) return creating;
  if (signal?.aborted) throw { kind: 'cancelled', message: '已取消' } satisfies ConvertError;

  creating = (async () => {
    let mod: TesseractModule;
    try {
      mod = await loadTesseract();
    } catch (e) {
      throw { kind: 'engine-load', message: ENGINE_LOAD_MESSAGE, detail: errorText(e).slice(0, 1500) } satisfies ConvertError;
    }
    let w: TesseractWorker;
    try {
      w = await withTimeout(
        mod.createWorker(lang, mod.OEM.LSTM_ONLY, {
          workerPath: WORKER_PATH,
          corePath: CORE_PATH,
          langPath: LANG_PATH,
          gzip: true,
          logger: (m) => logSink?.(m),
          errorHandler: () => {
            /* 错误经 recognize 的 reject 上报；这里吞掉避免控制台噪音 */
          },
        }),
        LIMITS.timeouts.ocrPageMs * 3,
        'OCR 引擎初始化超时'
      );
    } catch (e) {
      const err = e as Partial<ConvertError>;
      if (err?.kind === 'cancelled') throw e;
      if (err?.kind === 'timeout') {
        // 初始化超时：可能已经 spawn 了半个 worker，尽力清掉
        throw { kind: 'engine-load', message: ENGINE_LOAD_MESSAGE, detail: 'OCR 引擎初始化超时' } satisfies ConvertError;
      }
      throw { kind: 'engine-load', message: ENGINE_LOAD_MESSAGE, detail: errorText(e).slice(0, 1500) } satisfies ConvertError;
    }
    if (signal?.aborted) {
      // 建好那一刻已被取消：立刻回收，不接管单例
      void Promise.resolve(w.terminate()).catch(() => undefined);
      throw { kind: 'cancelled', message: '已取消' } satisfies ConvertError;
    }
    worker = w;
    workerLang = lang;
    return w;
  })();

  try {
    return await creating;
  } finally {
    creating = null;
  }
}

/**
 * 对一组图片逐张 OCR，返回每张的纯文本（顺序与输入一致）。
 * 进度 = (已完成页 + 当前页进度) / 总页数。取消 / 超时会终止底层 worker。
 */
export async function ocrImages(
  images: Blob[],
  lang: OcrLang,
  opts: { signal?: AbortSignal; onProgress?: (p: number | null, message?: string) => void }
): Promise<string[]> {
  const total = images.length;
  const out: string[] = [];
  if (total === 0) return out;
  const { signal, onProgress } = opts;
  const throwIfAborted = (): void => {
    if (signal?.aborted) throw { kind: 'cancelled', message: '已取消' } satisfies ConvertError;
  };

  throwIfAborted();
  const w = await ensureWorker(lang, signal);
  throwIfAborted();

  // abort 一律终止 worker（recognize 没有别的中断手段，见文件头）。
  const onAbort = (): void => terminateOcr();
  signal?.addEventListener('abort', onAbort, { once: true });

  try {
    for (let i = 0; i < total; i++) {
      throwIfAborted();
      let pageProgress = 0;
      logSink = (m) => {
        if (typeof m?.progress === 'number' && Number.isFinite(m.progress)) {
          pageProgress = Math.min(1, Math.max(0, m.progress));
        }
        onProgress?.((i + pageProgress) / total, `识别第 ${i + 1}/${total} 页`);
      };
      let text: string;
      try {
        const r = await withTimeout(w.recognize(images[i]), LIMITS.timeouts.ocrPageMs, `第 ${i + 1} 页识别超时`);
        text = r?.data?.text ?? '';
      } catch (e) {
        if (isAbortedError(e)) {
          // 超时 / 已取消：worker 状态不可信，终止复位
          terminateOcr();
          if ((e as ConvertError).kind === 'timeout') {
            throw { kind: 'timeout', message: `第 ${i + 1} 页识别超时，请减少页数或缩小分辨率后重试` } satisfies ConvertError;
          }
          throw { kind: 'cancelled', message: '已取消' } satisfies ConvertError;
        }
        throw { kind: 'unknown', message: `第 ${i + 1} 页识别失败`, detail: errorText(e).slice(0, 1500) } satisfies ConvertError;
      } finally {
        logSink = null;
      }
      throwIfAborted();
      out.push(text);
      onProgress?.((i + 1) / total);
    }
    return out;
  } finally {
    signal?.removeEventListener('abort', onAbort);
    logSink = null;
  }
}

/** 释放单例 worker（页面离开或用户主动释放时调用；可重复调用）。 */
export async function disposeOcr(): Promise<void> {
  const w = worker;
  worker = null;
  workerLang = null;
  logSink = null;
  if (w) {
    try {
      await w.terminate();
    } catch {
      /* 已经死了 */
    }
  }
}

function errorText(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'object' && e !== null && 'message' in e) return String((e as { message: unknown }).message);
  return String(e);
}
