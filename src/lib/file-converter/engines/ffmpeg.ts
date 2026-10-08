// STUB —— 实施 agent A 将整体替换本文件。
// 契约（消费的类别模块按此签名调用，不许改）：
//   核心文件从同源 /static/converter/ffmpeg/ 加载（scripts/copy-converter-assets.mjs）。
//   一切方法都要尊重 AbortSignal；exec 非零退出抛 {kind, message, detail: stderr 摘要}。

/** ffmpeg 引擎状态（能力探测报告的直接来源）。 */
export interface FFmpegState {
  loaded: boolean;
  loading: boolean;
  encoders: string[];
  decoders: string[];
  error?: string;
}

export interface ProbeStream {
  index: number;
  type: 'video' | 'audio' | 'subtitle' | 'other';
  codec: string;
  channels?: number;
  sampleRate?: number;
  width?: number;
  height?: number;
  language?: string;
}

export interface ProbeResult {
  durationSec: number | null;
  streams: ProbeStream[];
  formatName: string;
}

export function getFFmpegState(): FFmpegState {
  return { loaded: false, loading: false, encoders: [], decoders: [] };
}

export async function ensureFFmpeg(
  _onProgress?: (p: number | null, message?: string) => void
): Promise<void> {
  throw { kind: 'unknown', message: 'ffmpeg 引擎尚未实现' };
}

export async function probe(
  _bytes: Uint8Array,
  _ext: string,
  _timeoutMs?: number
): Promise<ProbeResult> {
  throw { kind: 'unknown', message: 'ffmpeg 引擎尚未实现' };
}

export async function exec(
  _args: string[],
  _inputs: { name: string; data: Uint8Array }[],
  _outputNames: string[],
  _opts: { timeoutMs: number; onProgress?: (p: number | null) => void; signal?: AbortSignal }
): Promise<{ files: Map<string, Uint8Array>; log: string }> {
  throw { kind: 'unknown', message: 'ffmpeg 引擎尚未实现' };
}

export function terminateFFmpeg(): void {}
