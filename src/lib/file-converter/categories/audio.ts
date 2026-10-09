// ─────────────────────────────────────────────────────────────────────────────
// file-converter/categories/audio.ts —— 音频能力区（roadmap §5）。
//
// 【范围】MP3 / WAV / FLAC / M4A / OGG / AIFF 互转 + 同编码换封装（ogg→webm）。
//   全部走 FFmpeg 引擎（../engines/ffmpeg.ts，**动态 import** —— 静态引入会把 31MB
//   核心的加载路径卷进每个页面的主包）。
//
// 【共享助手】本文件同时导出 loadEngine / probeMedia / takeOutput / strParam /
//   numParam 等媒体 runner 公共件，video.ts 直接复用（两个类别同属 FFmpeg 引擎，
//   助手与 argv 拼装（engines/ffmpeg-args.ts，纯函数）分层）。
//
// 【纪律】
//   · LIMITS.audio 是硬上限：字节先判，时长 / 声道 / 采样率先 probe 再判。
//   · 换封装边（audio:repackage）**绝不偷偷转码**：probe 出的编码不在目标容器
//     白名单内就明确报错，指引用户改用重编码边。
//   · notices 如实标注有损 / 代际损失 / 元数据不保留（roadmap §15 硬要求）。
// ─────────────────────────────────────────────────────────────────────────────

import { AUDIO_SAMPLE_RATES, FORMATS, LIMITS, MP3_BITRATES, formatBytes, type FormatKey } from '../formats';
import type {
  CapabilityReport,
  CategoryDef,
  ConvertError,
  ConvertResultData,
  InspectInfo,
  ParamOption,
  RunContext,
  StreamInfo,
} from '../types';
import { classifyError, convertedName, withTimeout } from '../utils';
import {
  buildAudioRemux,
  buildAudioToAiff,
  buildAudioToFlac,
  buildAudioToM4a,
  buildAudioToMp3,
  buildAudioToOgg,
  buildAudioToWav,
  REPACKAGE_WEBM_CODECS,
  type IoNames,
} from '../engines/ffmpeg-args';

// ─── 媒体 runner 公共件（video.ts 复用）────────────────────────────────────────

/** 引擎模块的运行时形状（engines/ffmpeg.ts 的契约投影）。 */
export interface EngineApi {
  ensureFFmpeg(onProgress?: (p: number | null, message?: string) => void): Promise<void>;
  probe(
    bytes: Uint8Array,
    ext: string,
    timeoutMs?: number
  ): Promise<{ durationSec: number | null; streams: StreamInfo[]; formatName: string }>;
  exec(
    args: string[],
    inputs: { name: string; data: Uint8Array }[],
    outputNames: string[],
    opts: { timeoutMs: number; onProgress?: (p: number | null) => void; signal?: AbortSignal }
  ): Promise<{ files: Map<string, Uint8Array>; log: string }>;
}

export function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw { kind: 'cancelled', message: '已取消' } satisfies ConvertError;
}

/** 加载引擎（loading-engine 阶段，带超时与取消检查）。 */
export async function loadEngine(ctx: RunContext): Promise<EngineApi> {
  throwIfAborted(ctx.signal);
  ctx.onPhase('loading-engine');
  const eng = (await import('../engines/ffmpeg')) as EngineApi;
  await withTimeout(
    eng.ensureFFmpeg((p, m) => ctx.onProgress(p, m)),
    LIMITS.timeouts.ffmpegLoadMs,
    '加载转换组件超时，请重试'
  );
  throwIfAborted(ctx.signal);
  return eng;
}

/** 引擎内部输入名用的扩展名：嗅探结果优先，退化到文件名后缀；都不是就给 bin。 */
export function inputExtOf(ctx: RunContext): string {
  const sniffed = ctx.inspect?.sniff.ext;
  if (sniffed && /^[a-z0-9]{1,8}$/.test(sniffed)) return sniffed;
  const m = /\.([a-z0-9]{1,8})$/i.exec(ctx.file.name);
  return m ? m[1].toLowerCase() : 'bin';
}

export interface MediaProbeInfo {
  durationSec: number | null;
  streams: StreamInfo[];
}

/** 探测媒体信息（probing 阶段）。探测失败归类为「损坏 / 不支持」，不放行到转码。 */
export async function probeMedia(
  ctx: RunContext,
  eng: EngineApi,
  bytes: Uint8Array,
  ext: string
): Promise<MediaProbeInfo> {
  throwIfAborted(ctx.signal);
  ctx.onPhase('probing');
  try {
    const r = await eng.probe(bytes, ext, LIMITS.timeouts.probeMs);
    throwIfAborted(ctx.signal);
    return r;
  } catch (e) {
    throw classifyError(e, '无法读取媒体信息，文件可能损坏或编码不受支持');
  }
}

/** 从引擎输出里取结果文件；缺失 / 为空 = 失败（带 stderr 摘要），不交付半成品。 */
export function takeOutput(files: Map<string, Uint8Array>, name: string, log: string): Uint8Array<ArrayBuffer> {
  const out = files.get(name);
  if (!out || out.byteLength === 0) {
    throw { kind: 'corrupt', message: '转换未产生有效输出', detail: log.slice(-1500) } satisfies ConvertError;
  }
  // wasm FS 读出的必然是普通 ArrayBuffer 支撑的视图（SharedArrayBuffer 不进 MEMFS）；
  // 在这里断言一次（TS 5.7 起 Blob 只收 ArrayBuffer 支撑的视图），各 Blob 构造点就不用各写一遍。
  return out as Uint8Array<ArrayBuffer>;
}

/** 运行时编码器能力闸：能力报告已探测且缺该编码器时，给明确错误而不是让引擎炸。 */
export function assertEncoderAvailable(caps: CapabilityReport, encoder: string | null): void {
  if (!encoder) return;
  const f = caps.ffmpeg;
  if (f && f.loaded && !f.error && !f.encoders.includes(encoder)) {
    throw {
      kind: 'capability',
      message: `当前转换组件缺少 ${encoder} 编码器，请换一个目标格式`,
    } satisfies ConvertError;
  }
}

// ─── 参数解析（params 是 UI 冻结的快照，仍按白名单防御性解析）───────────────────

export function strParam(
  params: Record<string, unknown>,
  key: string,
  allowed: readonly string[],
  fallback: string
): string {
  const v = params[key];
  return typeof v === 'string' && allowed.includes(v) ? v : fallback;
}

export function numParam(
  params: Record<string, unknown>,
  key: string,
  fallback: number,
  min: number,
  max: number
): number {
  const v = params[key];
  const n =
    typeof v === 'number' && Number.isFinite(v)
      ? v
      : typeof v === 'string' && v.trim() !== ''
        ? Number(v)
        : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/** 轨道参数解析：'auto' / 越界 → 0（第一条）；合法序号照用。 */
export function trackOrdinal(v: unknown, count: number): number {
  if (typeof v === 'string' && /^\d+$/.test(v)) {
    const n = parseInt(v, 10);
    if (n >= 0 && n < count) return n;
  }
  return 0;
}

// ─── 音频限额与共享文案 ─────────────────────────────────────────────────────────

const AUDIO_KINDS = ['mp3', 'wav', 'flac', 'm4a', 'ogg', 'aiff'] as const;

/** 有损源 → 有损目标时的「代际损失」提示。 */
const LOSSY_KINDS: ReadonlySet<string> = new Set(['mp3', 'm4a', 'ogg']);

const BITRATE_VALUES = MP3_BITRATES.map(String);

function oversize(message: string): ConvertError {
  return { kind: 'oversize', message };
}

function checkAudioLimits(probe: MediaProbeInfo, sniffKind: string | undefined): void {
  const audioStreams = probe.streams.filter((s) => s.type === 'audio');
  if (audioStreams.length === 0) {
    throw { kind: 'corrupt', message: '未找到音频轨，文件可能损坏或不是音频文件' } satisfies ConvertError;
  }
  if (audioStreams.length > 1) {
    throw { kind: 'unsupported', message: '暂不支持多音轨音频文件' } satisfies ConvertError;
  }
  // 封面图在 probe 里也是一条 video 轨，引擎契约没给 disposition，无法区分封面与
  // 真实视频。OGG 族没有封面惯例，有视频轨基本就是 Theora 视频 —— 拒掉并指路。
  if (sniffKind === 'ogg' && probe.streams.some((s) => s.type === 'video')) {
    throw { kind: 'unsupported', message: '该 OGG 文件含视频轨，请到「视频」标签页处理' } satisfies ConvertError;
  }
  if (probe.durationSec === null || !(probe.durationSec > 0)) {
    throw { kind: 'corrupt', message: '无法获得可信时长，文件可能损坏' } satisfies ConvertError;
  }
  if (probe.durationSec > LIMITS.audio.maxDurationSec) {
    throw oversize(`时长约 ${Math.round(probe.durationSec)} 秒，超过 ${LIMITS.audio.maxDurationSec} 秒上限`);
  }
  const a = audioStreams[0];
  if (a.channels && a.channels > LIMITS.audio.maxChannels) {
    throw oversize(`暂不支持 ${a.channels} 声道的音频（上限双声道），请先混音为双声道`);
  }
  if (a.sampleRate && a.sampleRate > LIMITS.audio.maxSampleRate) {
    throw oversize(`采样率 ${a.sampleRate} Hz 超过 ${LIMITS.audio.maxSampleRate} Hz 上限`);
  }
}

// ─── 音频转换 runner（所有重编码 / 换封装边共用）────────────────────────────────

interface AudioJobSpec {
  formatKey: FormatKey;
  /** 重编码所需的 ffmpeg 编码器名（换封装 / PCM 给 null）。 */
  encoder: string | null;
  /** probe 传进来是为了「保持源规格」这类决定（如 AIFF 跟随源采样率，不静默降采样）。 */
  args: (io: IoNames, probe: MediaProbeInfo) => string[];
  /** 换封装边：源编码必须在白名单内，否则明确报错（绝不偷偷转码）。 */
  remuxCodecWhitelist?: readonly string[];
  remuxContainerLabel?: string;
  notices: (ctx: RunContext) => string[];
}

async function runAudioJob(ctx: RunContext, spec: AudioJobSpec): Promise<ConvertResultData> {
  const file = ctx.file;
  if (file.size > LIMITS.audio.maxBytes) {
    throw oversize(`文件 ${formatBytes(file.size)} 超过 ${formatBytes(LIMITS.audio.maxBytes)} 上限`);
  }
  const eng = await loadEngine(ctx);
  const bytes = new Uint8Array(await file.arrayBuffer());
  throwIfAborted(ctx.signal);
  const ext = inputExtOf(ctx);
  const probe = await probeMedia(ctx, eng, bytes, ext);
  checkAudioLimits(probe, ctx.inspect?.sniff.kind);

  if (spec.remuxCodecWhitelist) {
    const codec = probe.streams.find((s) => s.type === 'audio')?.codec ?? '';
    if (!spec.remuxCodecWhitelist.includes(codec)) {
      throw {
        kind: 'unsupported',
        message: `该文件的音频编码是 ${codec || '未知'}，无法直接装进 ${spec.remuxContainerLabel} 容器；请改用重编码目标（如 MP3 / OGG）`,
      } satisfies ConvertError;
    }
  } else {
    assertEncoderAvailable(ctx.capabilities, spec.encoder);
  }

  const fmt = FORMATS[spec.formatKey];
  const io: IoNames = { inputName: `input.${ext}`, outputName: `output.${fmt.ext}` };
  ctx.onPhase('converting');
  const { files, log } = await eng.exec(spec.args(io, probe), [{ name: io.inputName, data: bytes }], [io.outputName], {
    timeoutMs: LIMITS.timeouts.transcodeAudioMs,
    onProgress: (p) => ctx.onProgress(p),
    signal: ctx.signal,
  });
  throwIfAborted(ctx.signal);
  const out = takeOutput(files, io.outputName, log);
  const name = convertedName(ctx.file.name, fmt.ext, new Set());
  return {
    outputs: [{ blob: new Blob([out]), name }],
    mime: fmt.mime,
    ext: fmt.ext,
    inputSize: file.size,
    outputSize: out.byteLength,
    notices: spec.notices(ctx),
    previewKind: 'audio',
  };
}

function lossyNotices(ctx: RunContext, head: string): string[] {
  const kind = ctx.inspect?.sniff.kind;
  const first = kind && LOSSY_KINDS.has(kind) ? `${head}；源文件已是有损编码，再次压缩会进一步损失音质（代际损失）` : head;
  return [first, '元数据与封面不保留'];
}

function losslessNotices(ctx: RunContext, head: string): string[] {
  const kind = ctx.inspect?.sniff.kind;
  const tail = kind && LOSSY_KINDS.has(kind) ? '转为无损格式不会恢复源文件已丢失的细节' : '不提升原音质';
  return [head, tail, '元数据与封面不保留'];
}

// ─── 类别定义 ─────────────────────────────────────────────────────────────────

export const CATEGORY: CategoryDef = {
  key: 'audio',
  label: '音频',
  hint: 'MP3 / WAV / FLAC / M4A / OGG / AIFF 互转与同编码换封装。单文件 ≤ 20 MiB、≤ 5 分钟、双声道以内；重编码会损失音质，结果页如实标注。文件只在本机处理。',
  accept: '.mp3,.wav,.flac,.m4a,.ogg,.oga,.opus,.aif,.aiff',
  maxFilesPerTask: 1,
  edges: [
    {
      id: 'audio:to-mp3',
      label: 'MP3（广泛兼容）',
      from: [...AUDIO_KINDS],
      to: 'mp3',
      method: 'reencode',
      notices: ['有损重编码（MP3），音质会有损失', '元数据与封面不保留'],
      params: [
        {
          key: 'bitrate',
          label: '码率',
          type: 'select',
          options: MP3_BITRATES.map((b) => ({ value: String(b), label: `${b} kbps` })),
          defaultValue: '192',
          help: '越高音质越好、体积越大',
        },
      ],
      requires: ['worker', 'ffmpeg', 'ffmpeg-enc:libmp3lame'],
      run: (ctx) =>
        runAudioJob(ctx, {
          formatKey: 'mp3',
          encoder: 'libmp3lame',
          args: (io) => buildAudioToMp3({ ...io, bitrate: strParam(ctx.params, 'bitrate', BITRATE_VALUES, '192') }),
          notices: (c) => lossyNotices(c, `有损重编码为 MP3（${strParam(ctx.params, 'bitrate', BITRATE_VALUES, '192')} kbps）`),
        }),
      status: 'live',
      group: '兼容播放',
    },
    {
      id: 'audio:to-wav',
      label: 'WAV（供编辑软件使用）',
      from: [...AUDIO_KINDS],
      to: 'wav',
      method: 'reencode',
      notices: ['16 位 PCM，体积明显增大', '转为 WAV 不会提升原音质', '元数据与封面不保留'],
      params: [
        {
          key: 'sampleRate',
          label: '采样率',
          type: 'select',
          options: [
            { value: '44100', label: '44100 Hz' },
            { value: '48000', label: '48000 Hz' },
          ],
          defaultValue: '44100',
          advanced: true,
          help: '不改变音质；仅在目标软件要求时调整',
        },
      ],
      requires: ['worker', 'ffmpeg'],
      run: (ctx) =>
        runAudioJob(ctx, {
          formatKey: 'wav',
          encoder: null,
          args: (io) => buildAudioToWav({ ...io, sampleRate: strParam(ctx.params, 'sampleRate', ['44100', '48000'], '44100') }),
          notices: (c) => losslessNotices(c, '解码为 16 位 PCM WAV，体积明显增大'),
        }),
      status: 'live',
      group: '无损 / 编辑素材',
    },
    {
      id: 'audio:to-flac',
      label: 'FLAC（无损压缩存档）',
      from: [...AUDIO_KINDS],
      to: 'flac',
      method: 'reencode',
      notices: ['无损压缩，体积较大', '不会恢复有损源已丢失的细节', '元数据与封面不保留'],
      params: [],
      requires: ['worker', 'ffmpeg'],
      run: (ctx) =>
        runAudioJob(ctx, {
          formatKey: 'flac',
          encoder: null,
          args: (io) => buildAudioToFlac(io),
          notices: (c) => losslessNotices(c, '无损压缩为 FLAC，体积较大'),
        }),
      status: 'live',
      group: '无损 / 编辑素材',
    },
    {
      id: 'audio:to-ogg-vorbis',
      label: 'OGG Vorbis（开放格式）',
      from: [...AUDIO_KINDS],
      to: 'ogg',
      method: 'reencode',
      notices: ['有损重编码（Vorbis），音质会有损失', '元数据与封面不保留'],
      params: [],
      requires: ['worker', 'ffmpeg', 'ffmpeg-enc:libvorbis'],
      run: (ctx) =>
        runAudioJob(ctx, {
          formatKey: 'ogg',
          encoder: 'libvorbis',
          args: (io) => buildAudioToOgg({ ...io, codec: 'libvorbis' }),
          notices: (c) => lossyNotices(c, '有损重编码为 OGG Vorbis'),
        }),
      status: 'live',
      group: '开放格式',
    },
    {
      id: 'audio:to-ogg-opus',
      label: 'OGG Opus（语音最省体积）',
      from: [...AUDIO_KINDS],
      to: 'ogg',
      method: 'reencode',
      notices: ['有损重编码（Opus）', 'Opus 对语音与低码率最省体积', '元数据与封面不保留'],
      params: [],
      requires: ['worker', 'ffmpeg', 'ffmpeg-enc:libopus'],
      run: (ctx) =>
        runAudioJob(ctx, {
          formatKey: 'ogg',
          encoder: 'libopus',
          args: (io) => buildAudioToOgg({ ...io, codec: 'libopus' }),
          notices: (c) => lossyNotices(c, '有损重编码为 OGG Opus（对语音最省体积）'),
        }),
      status: 'live',
      group: '开放格式',
    },
    {
      id: 'audio:to-m4a',
      label: 'M4A / AAC（手机小体积）',
      from: [...AUDIO_KINDS],
      to: 'm4a',
      method: 'reencode',
      notices: ['有损重编码（AAC 192 kbps）', '元数据与封面不保留'],
      params: [],
      requires: ['worker', 'ffmpeg', 'ffmpeg-enc:aac'],
      run: (ctx) =>
        runAudioJob(ctx, {
          formatKey: 'm4a',
          encoder: 'aac',
          args: (io) => buildAudioToM4a(io),
          notices: (c) => lossyNotices(c, '有损重编码为 M4A（AAC 192 kbps）'),
        }),
      status: 'live',
      group: '兼容播放',
    },
    {
      id: 'audio:to-aiff',
      label: 'AIFF（特定编辑软件）',
      from: [...AUDIO_KINDS],
      to: 'aiff',
      method: 'reencode',
      notices: ['16 位 PCM，体积明显增大', '转为 AIFF 不会提升原音质', '元数据与封面不保留'],
      params: [],
      requires: ['worker', 'ffmpeg'],
      run: (ctx) =>
        runAudioJob(ctx, {
          formatKey: 'aiff',
          encoder: null,
          args: (io, probe) => {
            // AIFF 没有暴露采样率参数：跟随源采样率（白名单内），不认得才退回 44100 ——
            // 不静默把 48 kHz 源降采样。
            const src = probe.streams.find((s) => s.type === 'audio')?.sampleRate;
            const rate = src && (AUDIO_SAMPLE_RATES as readonly number[]).includes(src) ? String(src) : '44100';
            return buildAudioToAiff({ ...io, sampleRate: rate });
          },
          notices: (c) => losslessNotices(c, '解码为 16 位 PCM AIFF，体积明显增大'),
        }),
      status: 'live',
      group: '无损 / 编辑素材',
    },
    {
      id: 'audio:repackage',
      label: 'WebM（同编码换封装，零损失）',
      from: ['ogg'],
      to: 'webm',
      method: 'remux',
      notices: ['不重编码，零损失（仅更换容器）', '元数据与封面不保留'],
      params: [],
      match: (info) => {
        // probe 已给出轨清单时，编码装不进 WebM 就不展示；probe 失败（没有轨信息）
        // 仍然展示，由 runner 给出明确错误。
        const a = info.streams?.find((s) => s.type === 'audio');
        if (!a) return true;
        return REPACKAGE_WEBM_CODECS.includes(a.codec);
      },
      requires: ['worker', 'ffmpeg'],
      estimateOutput: (info) => info.size,
      run: (ctx) =>
        runAudioJob(ctx, {
          formatKey: 'webm',
          encoder: null,
          remuxCodecWhitelist: REPACKAGE_WEBM_CODECS,
          remuxContainerLabel: 'WebM',
          args: (io) => buildAudioRemux(io),
          notices: () => ['不重编码，零损失（仅 OGG → WebM 换容器）', '元数据与封面不保留'],
        }),
      status: 'live',
      group: '换封装',
    },
  ],
  // probe：给「换封装」边的 match 填轨清单。只对音频族嗅探结果触发；失败降级为 {}
  // （没有轨信息只是让 remux 边晚点报错，不挡重编码边）。
  probe: async (file, info) => {
    try {
      if (!(AUDIO_KINDS as readonly string[]).includes(info.sniff.kind)) return {};
      const bytes = new Uint8Array(await file.arrayBuffer());
      const eng = (await import('../engines/ffmpeg')) as EngineApi;
      await eng.ensureFFmpeg();
      const r = await eng.probe(bytes, info.sniff.ext, LIMITS.timeouts.probeMs);
      return { streams: r.streams };
    } catch {
      return {};
    }
  },
};

// 供 video.ts 复用的轨道选项渲染（音轨 / 字幕共用描述拼装）。
export function streamTrackLabel(s: StreamInfo, ordinalLabel: string): string {
  const parts = [s.codec];
  if (s.channels) parts.push(s.channels === 1 ? '单声道' : s.channels === 2 ? '双声道' : `${s.channels} 声道`);
  if (s.sampleRate) parts.push(`${s.sampleRate}Hz`);
  if (s.language) parts.push(s.language);
  return `${ordinalLabel}（${parts.join(' · ')}）`;
}

export function autoTrackOption(): ParamOption[] {
  return [{ value: 'auto', label: '自动（第一条）' }];
}
