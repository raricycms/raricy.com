// ─────────────────────────────────────────────────────────────────────────────
// file-converter/categories/video.ts —— 视频能力区（roadmap §6）。
//
// 【范围】MP4 / MKV / WebM / MOV / AVI / FLV / WMV 的转码与换封装、提取音频、
//   提取文本字幕、抽帧打包、动图（GIF / 动画 WebP）、图片序列合成 MP4。
//   全部走 FFmpeg 引擎（动态 import；argv 拼装一律在 ../engines/ffmpeg-args.ts）。
//
// 【纪律】
//   · LIMITS.video 硬上限：字节先判，时长 / 分辨率 probe 后判。
//   · remux-to-mp4 是**自适应边**：probe 后编码兼容就整条 copy（零损失），不兼容
//     才转码，走哪条路照实写进 notices（roadmap §6.3 例 1/2）。
//   · 单文件边遇到多文件任务**明确报错** —— maxFilesPerTask=200 是为图片序列开的，
//     队列会把多选合成一个任务（见 tasksForBatch），静默只转第一个就是丢文件。
//   · 抽帧输出 ZIP 用 fflate 动态引入；压缩级别 0（png / jpg 本身已压缩）。
//   · 图片序列的格式必须统一（全 PNG 或全 JPG）：image2 用单一模式串喂入，
//     解码器按第一个文件定，混合内容会解码失败 —— 与其赌引擎行为，不如明确拒绝。
// ─────────────────────────────────────────────────────────────────────────────

import { FORMATS, LIMITS, MP3_BITRATES, formatBytes } from '../formats';
import type {
  CategoryDef,
  ConvertError,
  ConvertResultData,
  InspectInfo,
  ParamOption,
  RunContext,
  StreamInfo,
} from '../types';
import { convertedName, sanitizeBase } from '../utils';
import {
  audioEncodeArgsFor,
  audioMapOf,
  buildExtractSubtitle,
  buildFramesToVideo,
  buildGifPaletteArgs,
  buildGifRenderArgs,
  buildVideoExtractAudio,
  buildVideoRemuxMkv,
  buildVideoRemuxMp4,
  buildVideoReencodeMp4,
  buildVideoToFrames,
  buildVideoToWebm,
  buildVideoToWebpAnim,
  canCopyAudio,
  decideMp4Route,
  evenScaleWidth,
  pickAudioStreams,
  pickFirstVideo,
  subtitleMapOf,
  EXTRACT_AUDIO_FORMATS,
  EXTRACT_ENCODER,
  TEXT_SUBTITLE_CODECS,
  type ExtractAudioFormat,
  type IoNames,
} from '../engines/ffmpeg-args';
import {
  assertEncoderAvailable,
  inputExtOf,
  loadEngine,
  numParam,
  probeMedia,
  strParam,
  streamTrackLabel,
  takeOutput,
  throwIfAborted,
  trackOrdinal,
  autoTrackOption,
  type EngineApi,
  type MediaProbeInfo,
} from './audio';

const VIDEO_KINDS = ['mp4', 'mkv', 'webm', 'mov', 'avi', 'flv', 'wmv'] as const;

const BITRATE_VALUES = MP3_BITRATES.map(String);

/** 抽帧单次上限（帧数），防 MEMFS 被 PNG 序列撑爆。 */
const MAX_FRAMES = 150;

/** 图片序列合成的输入上限（与 CATEGORY.maxFilesPerTask 一致；序列名 %03d 最多 999）。 */
const MAX_SEQUENCE_FILES = 200;

function oversize(message: string): ConvertError {
  return { kind: 'oversize', message };
}

function unsupported(message: string): ConvertError {
  return { kind: 'unsupported', message };
}

/** 单文件边的多文件守卫（见文件头纪律）。 */
function assertSingleFile(ctx: RunContext): void {
  if (ctx.files.length !== 1) {
    throw unsupported(`该目标一次只处理一个视频文件（当前选了 ${ctx.files.length} 个）；多文件仅「图片序列合成 MP4」支持`);
  }
}

/** 读输入 + 探测 + 视频限额。requireVideo=false 用于提取音频 / 字幕（纯音频 MP4 可达）。 */
async function prepareMedia(
  ctx: RunContext,
  opts: { requireVideo: boolean }
): Promise<{ eng: EngineApi; bytes: Uint8Array; ext: string; probe: MediaProbeInfo }> {
  assertSingleFile(ctx);
  const file = ctx.file;
  if (file.size > LIMITS.video.maxBytes) {
    throw oversize(`文件 ${formatBytes(file.size)} 超过 ${formatBytes(LIMITS.video.maxBytes)} 上限`);
  }
  const eng = await loadEngine(ctx);
  const bytes = new Uint8Array(await file.arrayBuffer());
  throwIfAborted(ctx.signal);
  const ext = inputExtOf(ctx);
  const probe = await probeMedia(ctx, eng, bytes, ext);

  const v = pickFirstVideo(probe.streams);
  if (opts.requireVideo && !v) {
    throw unsupported('未找到视频轨（纯音频文件请到「音频」标签页，或用「提取音频」）');
  }
  if (probe.durationSec === null || !(probe.durationSec > 0)) {
    throw { kind: 'corrupt', message: '无法获得可信时长，文件可能损坏' } satisfies ConvertError;
  }
  if (probe.durationSec > LIMITS.video.maxDurationSec) {
    throw oversize(`时长约 ${Math.round(probe.durationSec)} 秒，超过 ${LIMITS.video.maxDurationSec} 秒上限`);
  }
  if (v && v.width && v.width > LIMITS.video.maxWidth) {
    throw oversize(`宽度 ${v.width}px 超过 ${LIMITS.video.maxWidth}px 上限`);
  }
  if (v && v.height && v.height > LIMITS.video.maxHeight) {
    throw oversize(`高度 ${v.height}px 超过 ${LIMITS.video.maxHeight}px 上限`);
  }
  return { eng, bytes, ext, probe };
}

/**
 * 只带第一条视频 + 第一条音频的输出（MP4 / WebM）照实列出被丢下的轨道
 * （roadmap §6.3 例 1：「不能静默少一条轨道」）。
 */
function droppedTrackNotices(streams: StreamInfo[]): string[] {
  const notices: string[] = [];
  const videos = streams.filter((s) => s.type === 'video').length;
  if (videos > 1) notices.push(`仅带入第一条视频轨，其余 ${videos - 1} 条未带入`);
  const audios = streams.filter((s) => s.type === 'audio').length;
  if (audios > 1) notices.push(`仅带入第一条音频轨，其余 ${audios - 1} 条未带入`);
  const subs = streams.filter((s) => s.type === 'subtitle').length;
  if (subs > 0) notices.push('字幕轨未带入输出（可用「提取字幕」单独导出）');
  return notices;
}

/** 动图输出的额外轨道说明（这类输出**根本没有**声音，别用 droppedTrackNotices 的措辞）。 */
function extraVideoTrackNotice(streams: StreamInfo[]): string[] {
  const videos = streams.filter((s) => s.type === 'video').length;
  return videos > 1 ? [`仅转换第一条视频轨，其余 ${videos - 1} 条未带入`] : [];
}

async function execToSingleOutput(
  ctx: RunContext,
  eng: EngineApi,
  args: string[],
  io: IoNames,
  bytes: Uint8Array
): Promise<Uint8Array<ArrayBuffer>> {
  ctx.onPhase('converting');
  const { files, log } = await eng.exec(args, [{ name: io.inputName, data: bytes }], [io.outputName], {
    timeoutMs: LIMITS.timeouts.transcodeVideoMs,
    onProgress: (p) => ctx.onProgress(p),
    signal: ctx.signal,
  });
  throwIfAborted(ctx.signal);
  return takeOutput(files, io.outputName, log);
}

function videoResult(
  ctx: RunContext,
  out: Uint8Array<ArrayBuffer>,
  formatKey: 'mp4' | 'webm' | 'mkv' | 'gif' | 'webp',
  notices: string[]
): ConvertResultData {
  const fmt = FORMATS[formatKey];
  const name = convertedName(ctx.file.name, fmt.ext, new Set());
  const previewKind = formatKey === 'gif' || formatKey === 'webp' ? 'image' : 'video';
  return {
    outputs: [{ blob: new Blob([out], { type: fmt.mime }), name }],
    mime: fmt.mime,
    ext: fmt.ext,
    inputSize: ctx.file.size,
    outputSize: out.byteLength,
    notices,
    previewKind,
  };
}

// ─── 轨道参数的动态选项（probe 已填 info.streams；probe 失败时给 auto 兜底）──────

function audioTrackOptions(info: InspectInfo | null): ParamOption[] {
  const tracks = (info?.streams ?? []).filter((s) => s.type === 'audio');
  if (!tracks.length) return autoTrackOption();
  return tracks.map((s, i) => ({ value: String(i), label: streamTrackLabel(s, `音轨 ${i + 1}`) }));
}

function subtitleTrackOptions(info: InspectInfo | null): ParamOption[] {
  const tracks = (info?.streams ?? []).filter((s) => s.type === 'subtitle');
  if (!tracks.length) return autoTrackOption();
  return tracks.map((s, i) => ({
    value: String(i),
    label: `字幕 ${i + 1}（${s.codec}${s.language ? ` · ${s.language}` : ''}）`,
  }));
}

/** 光栅图字节验明正身：只认 PNG / JPEG 签名（以字节为准，不看扩展名）。 */
function sniffRasterKind(bytes: Uint8Array): 'png' | 'jpg' | null {
  if (bytes.length >= 4 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpg';
  return null;
}

// ─── 类别定义 ─────────────────────────────────────────────────────────────────

export const CATEGORY: CategoryDef = {
  key: 'video',
  label: '视频',
  hint: 'MP4 / MKV / WebM / MOV / AVI / FLV / WMV 转码、换封装、提取音频与字幕、抽帧、动图；图片序列（全 PNG 或全 JPG）可合成 MP4。单文件 ≤ 100 MiB、≤ 2 分钟、1080p 以内。文件只在本机处理。',
  accept: '.mp4,.mkv,.webm,.mov,.avi,.flv,.wmv,.m4v,.png,.jpg,.jpeg',
  maxFilesPerTask: MAX_SEQUENCE_FILES,
  edges: [
    {
      id: 'video:remux-to-mp4',
      label: 'MP4（优先换封装，不兼容才转码）',
      from: [...VIDEO_KINDS],
      to: 'mp4',
      method: 'remux',
      notices: ['编码兼容时不重编码（零损失）；不兼容时视频转 H.264、音频转 AAC（有损）', '元数据不保留'],
      params: [],
      requires: ['worker', 'ffmpeg', 'ffmpeg-enc:libx264', 'ffmpeg-enc:aac'],
      estimateOutput: (info) => (info.streams && decideMp4Route(info.streams) === 'copy' ? info.size : null),
      run: async (ctx) => {
        const { eng, bytes, ext, probe } = await prepareMedia(ctx, { requireVideo: true });
        const route = decideMp4Route(probe.streams);
        if (route === 'reencode') {
          assertEncoderAvailable(ctx.capabilities, 'libx264');
          assertEncoderAvailable(ctx.capabilities, 'aac');
        }
        const io: IoNames = { inputName: `input.${ext}`, outputName: 'output.mp4' };
        const args = route === 'copy' ? buildVideoRemuxMp4(io) : buildVideoReencodeMp4({ ...io, crf: 28, preset: 'veryfast' });
        const out = await execToSingleOutput(ctx, eng, args, io, bytes);
        const firstAudio = pickAudioStreams(probe.streams)[0];
        const notices =
          route === 'copy'
            ? ['音视频编码不变，仅更换容器（零损失）', '元数据不保留']
            : ['源编码与 MP4 不兼容：视频已重编码为 H.264（CRF 28，有损）', '音频重编码为 AAC 128 kbps（如有音轨）', '元数据不保留'];
        if (route === 'copy' && firstAudio?.codec === 'mp3') {
          notices.push('音轨为 MP3 in MP4，部分播放器可能不识别');
        }
        notices.push(...droppedTrackNotices(probe.streams));
        return videoResult(ctx, out, 'mp4', notices);
      },
      status: 'live',
      group: '换封装与兼容',
    },
    {
      id: 'video:remux-to-mkv',
      label: 'MKV（原编码换容器，保留全部轨道）',
      from: [...VIDEO_KINDS],
      to: 'mkv',
      method: 'remux',
      notices: ['不重编码，零损失（全部轨道原样带入）', '元数据不保留'],
      params: [],
      requires: ['worker', 'ffmpeg'],
      estimateOutput: (info) => info.size,
      run: async (ctx) => {
        const { eng, bytes, ext } = await prepareMedia(ctx, { requireVideo: true });
        const io: IoNames = { inputName: `input.${ext}`, outputName: 'output.mkv' };
        const out = await execToSingleOutput(ctx, eng, buildVideoRemuxMkv(io), io, bytes);
        return videoResult(ctx, out, 'mkv', ['不重编码，零损失（含字幕在内的全部轨道原样带入）', '元数据不保留']);
      },
      status: 'live',
      group: '换封装与兼容',
    },
    {
      id: 'video:to-webm',
      label: 'WebM（网页播放）',
      from: [...VIDEO_KINDS],
      to: 'webm',
      method: 'reencode',
      notices: ['重编码为 VP9 + Opus（有损）', '元数据不保留'],
      params: [
        {
          key: 'crf',
          label: '质量（CRF）',
          type: 'range',
          min: 20,
          max: 40,
          step: 1,
          defaultValue: 32,
          advanced: true,
          help: '越小越清晰、体积越大',
        },
      ],
      requires: ['worker', 'ffmpeg', 'ffmpeg-enc:libvpx-vp9', 'ffmpeg-enc:libopus'],
      run: async (ctx) => {
        const { eng, bytes, ext, probe } = await prepareMedia(ctx, { requireVideo: true });
        assertEncoderAvailable(ctx.capabilities, 'libvpx-vp9');
        assertEncoderAvailable(ctx.capabilities, 'libopus');
        const crf = numParam(ctx.params, 'crf', 32, 20, 40);
        const io: IoNames = { inputName: `input.${ext}`, outputName: 'output.webm' };
        const out = await execToSingleOutput(ctx, eng, buildVideoToWebm({ ...io, crf }), io, bytes);
        return videoResult(ctx, out, 'webm', [
          `重编码为 VP9（CRF ${crf}，有损）+ Opus 128 kbps`,
          '元数据不保留',
          ...droppedTrackNotices(probe.streams),
        ]);
      },
      status: 'live',
      group: '换封装与兼容',
    },
    {
      id: 'video:to-mp4-h264',
      label: 'MP4 / H.264（强制重编码，参数可调）',
      from: [...VIDEO_KINDS],
      to: 'mp4',
      method: 'reencode',
      notices: ['重编码为 H.264 + AAC（有损）', '元数据不保留'],
      params: [
        {
          key: 'crf',
          label: '质量（CRF）',
          type: 'range',
          min: 20,
          max: 40,
          step: 1,
          defaultValue: 28,
          advanced: true,
          help: '越小越清晰、体积越大',
        },
        {
          key: 'presetSpeed',
          label: '编码速度',
          type: 'select',
          options: ['ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium', 'slow'].map((v) => ({ value: v, label: v })),
          defaultValue: 'veryfast',
          advanced: true,
          help: '越慢同画质下体积越小，耗时越长',
        },
      ],
      requires: ['worker', 'ffmpeg', 'ffmpeg-enc:libx264', 'ffmpeg-enc:aac'],
      run: async (ctx) => {
        const { eng, bytes, ext, probe } = await prepareMedia(ctx, { requireVideo: true });
        assertEncoderAvailable(ctx.capabilities, 'libx264');
        assertEncoderAvailable(ctx.capabilities, 'aac');
        const crf = numParam(ctx.params, 'crf', 28, 20, 40);
        const preset = strParam(ctx.params, 'presetSpeed', ['ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium', 'slow'], 'veryfast');
        const io: IoNames = { inputName: `input.${ext}`, outputName: 'output.mp4' };
        const out = await execToSingleOutput(ctx, eng, buildVideoReencodeMp4({ ...io, crf, preset }), io, bytes);
        return videoResult(ctx, out, 'mp4', [
          `重编码为 H.264（CRF ${crf} / ${preset}，有损）+ AAC 128 kbps`,
          '元数据不保留',
          ...droppedTrackNotices(probe.streams),
        ]);
      },
      status: 'live',
      group: '换封装与兼容',
    },
    {
      id: 'video:extract-audio',
      label: '提取音频（能直接抽取就不重编码）',
      from: [...VIDEO_KINDS],
      to: 'mp3',
      method: 'extract',
      notices: ['源编码与目标一致时直接抽取（零损失），否则重编码（有损）', '元数据不保留'],
      params: [
        { key: 'track', label: '音轨', type: 'select', options: audioTrackOptions, defaultValue: 'auto' },
        {
          key: 'format',
          label: '格式',
          type: 'select',
          options: [
            { value: 'mp3', label: 'MP3（广泛兼容）' },
            { value: 'm4a', label: 'M4A / AAC（小体积）' },
            { value: 'ogg', label: 'OGG Vorbis（开放格式）' },
            { value: 'flac', label: 'FLAC（无损，体积大）' },
            { value: 'wav', label: 'WAV（无压缩，供编辑）' },
          ],
          defaultValue: 'mp3',
        },
        {
          key: 'bitrate',
          label: '码率',
          type: 'select',
          options: MP3_BITRATES.map((b) => ({ value: String(b), label: `${b} kbps` })),
          defaultValue: '192',
          visibleIf: (params) => params.format === 'mp3' || params.format === 'ogg',
        },
      ],
      match: (info) => !info.streams || info.streams.some((s) => s.type === 'audio'),
      requires: ['worker', 'ffmpeg', 'ffmpeg-enc:libmp3lame', 'ffmpeg-enc:aac'],
      estimateOutput: (info, params) => {
        const tracks = (info.streams ?? []).filter((s) => s.type === 'audio');
        if (!tracks.length) return null;
        const format = strParam(params, 'format', EXTRACT_AUDIO_FORMATS, 'mp3') as ExtractAudioFormat;
        const codec = tracks[trackOrdinal(params.track, tracks.length)]?.codec;
        return codec && canCopyAudio(codec, format) ? info.size : null;
      },
      run: async (ctx) => {
        const { eng, bytes, ext, probe } = await prepareMedia(ctx, { requireVideo: false });
        const tracks = probe.streams.filter((s) => s.type === 'audio');
        if (!tracks.length) throw unsupported('该文件没有音频轨');
        const ordinal = trackOrdinal(ctx.params.track, tracks.length);
        const format = strParam(ctx.params, 'format', EXTRACT_AUDIO_FORMATS, 'mp3') as ExtractAudioFormat;
        const bitrate = strParam(ctx.params, 'bitrate', BITRATE_VALUES, '192');
        const source = tracks[ordinal];
        const copy = canCopyAudio(source.codec, format);
        if (!copy) assertEncoderAvailable(ctx.capabilities, EXTRACT_ENCODER[format]);
        const fmt = FORMATS[format];
        const io: IoNames = { inputName: `input.${ext}`, outputName: `output.${fmt.ext}` };
        const args = buildVideoExtractAudio({
          ...io,
          audioMap: audioMapOf(ordinal),
          codecArgs: copy ? ['-c:a', 'copy'] : audioEncodeArgsFor(format, bitrate),
        });
        ctx.onPhase('converting');
        const { files, log } = await eng.exec(args, [{ name: io.inputName, data: bytes }], [io.outputName], {
          timeoutMs: LIMITS.timeouts.transcodeAudioMs,
          onProgress: (p) => ctx.onProgress(p),
          signal: ctx.signal,
        });
        throwIfAborted(ctx.signal);
        const out = takeOutput(files, io.outputName, log);
        const notices = copy
          ? [`直接抽取音轨（${source.codec}），不重编码，零损失`, '元数据不保留']
          : [
              format === 'flac' || format === 'wav'
                ? `解码为 ${fmt.label}（不提升原音质）`
                : `音轨重编码为 ${fmt.label}${format === 'mp3' || format === 'ogg' ? ` ${bitrate} kbps` : ''}（有损）`,
              '元数据不保留',
            ];
        const name = convertedName(ctx.file.name, fmt.ext, new Set());
        return {
          outputs: [{ blob: new Blob([out], { type: fmt.mime }), name }],
          mime: fmt.mime,
          ext: fmt.ext,
          inputSize: ctx.file.size,
          outputSize: out.byteLength,
          notices,
          previewKind: 'audio',
        } satisfies ConvertResultData;
      },
      status: 'live',
      group: '提取',
    },
    {
      id: 'video:extract-subtitle',
      label: '提取字幕（SRT 文本）',
      from: [...VIDEO_KINDS],
      to: 'srt',
      method: 'extract',
      notices: ['转换为 SRT 文本，原字幕的字体、定位、特效样式不保留'],
      params: [{ key: 'track', label: '字幕轨', type: 'select', options: subtitleTrackOptions, defaultValue: 'auto' }],
      match: (info) => !info.streams || info.streams.some((s) => s.type === 'subtitle'),
      requires: ['worker', 'ffmpeg'],
      run: async (ctx) => {
        const { eng, bytes, ext, probe } = await prepareMedia(ctx, { requireVideo: false });
        const subs = probe.streams.filter((s) => s.type === 'subtitle');
        if (!subs.length) throw unsupported('该文件没有字幕轨');
        const ordinal = trackOrdinal(ctx.params.track, subs.length);
        const chosen = subs[ordinal];
        if (!TEXT_SUBTITLE_CODECS.includes(chosen.codec)) {
          throw unsupported(`字幕编码 ${chosen.codec} 是图形字幕，无法转换为文本（需要 OCR，暂不支持）`);
        }
        const io: IoNames = { inputName: `input.${ext}`, outputName: 'output.srt' };
        const args = buildExtractSubtitle({ ...io, subtitleMap: subtitleMapOf(ordinal) });
        ctx.onPhase('converting');
        const { files, log } = await eng.exec(args, [{ name: io.inputName, data: bytes }], [io.outputName], {
          timeoutMs: LIMITS.timeouts.transcodeAudioMs,
          onProgress: (p) => ctx.onProgress(p),
          signal: ctx.signal,
        });
        throwIfAborted(ctx.signal);
        const out = takeOutput(files, io.outputName, log);
        const notices =
          chosen.codec === 'subrip'
            ? ['仅更换封装，字幕内容不变']
            : [`从 ${chosen.codec} 转换为 SRT 文本，原样式（字体、颜色、定位、特效）不保留`];
        const name = convertedName(ctx.file.name, 'srt', new Set());
        return {
          outputs: [{ blob: new Blob([out], { type: FORMATS.srt.mime }), name }],
          mime: FORMATS.srt.mime,
          ext: 'srt',
          inputSize: ctx.file.size,
          outputSize: out.byteLength,
          notices,
          previewKind: 'text',
        } satisfies ConvertResultData;
      },
      status: 'live',
      group: '提取',
    },
    {
      id: 'video:to-frames',
      label: '抽出帧序列（打包 ZIP）',
      from: [...VIDEO_KINDS],
      to: 'zip',
      method: 'extract',
      notices: ['只保留按帧率采样到的画面，声音与字幕不保留'],
      params: [
        { key: 'fps', label: '每秒抽几帧', type: 'number', min: 1, max: 30, step: 1, defaultValue: 1, unit: 'fps' },
        {
          key: 'format',
          label: '图片格式',
          type: 'select',
          options: [
            { value: 'png', label: 'PNG（无损截图）' },
            { value: 'jpg', label: 'JPG（体积小，有损）' },
          ],
          defaultValue: 'png',
        },
      ],
      requires: ['worker', 'ffmpeg'],
      estimateOutput: () => null, // 帧体积随画面内容波动极大，估不出来就老实说估不出
      run: async (ctx) => {
        const { eng, bytes, ext, probe } = await prepareMedia(ctx, { requireVideo: true });
        const fps = numParam(ctx.params, 'fps', 1, 1, 30);
        const format = strParam(ctx.params, 'format', ['png', 'jpg'], 'png') as 'png' | 'jpg';
        const duration = probe.durationSec ?? 0;
        const expected = Math.max(1, Math.ceil(duration * fps));
        const capped = expected > MAX_FRAMES;
        const planned = Math.min(expected, MAX_FRAMES);
        // 输出预算的提前拒绝：帧序列打包后必超单文件上限的，不烧几分钟再被队列丢弃。
        // （粗估：png ≈ 2 字节 / 像素，jpg ≈ 0.2；宁可早拒，不侥幸放行。）
        const v = pickFirstVideo(probe.streams);
        const px = (v?.width ?? 1280) * (v?.height ?? 720);
        const estBytes = planned * px * (format === 'png' ? 2 : 0.2);
        if (estBytes > LIMITS.queue.maxOutputEach) {
          throw oversize(
            `预计帧序列约 ${Math.round(estBytes / 1024 / 1024)} MiB，超过单文件输出上限；请降低每秒帧数或改用 JPG`
          );
        }
        const inputName = `input.${ext}`;
        const pattern = `frame-%04d.${format}`;
        ctx.onPhase('converting');
        const { files: outFiles, log } = await eng.exec(
          buildVideoToFrames({ inputName, outputPattern: pattern, fps, format, maxFrames: MAX_FRAMES }),
          [{ name: inputName, data: bytes }],
          [pattern],
          {
            timeoutMs: LIMITS.timeouts.transcodeVideoMs,
            onProgress: (p) => ctx.onProgress(p),
            signal: ctx.signal,
          }
        );
        throwIfAborted(ctx.signal);
        // 模式串输出：从返回的文件表里按名收集（编号排序），一个都没有 = 失败
        const frameRe = new RegExp(`^frame-\\d{4}\\.${format}$`);
        const frames = [...outFiles.entries()]
          .filter(([n]) => frameRe.test(n))
          .sort(([a], [b]) => a.localeCompare(b));
        if (frames.length === 0) {
          throw { kind: 'corrupt', message: '抽帧未产生任何图片', detail: log.slice(-1500) } satisfies ConvertError;
        }
        throwIfAborted(ctx.signal);
        // 打包 ZIP（level 0 仅存储：png / jpg 本身已压缩，再压一遍只烧 CPU）
        const { zipSync } = await import('fflate');
        const base = sanitizeBase(ctx.file.name);
        const members: Record<string, Uint8Array> = {};
        frames.forEach(([, data], i) => {
          members[`${base}-${String(i + 1).padStart(4, '0')}.${format}`] = data;
        });
        const zipped = zipSync(members, { level: 0 }) as Uint8Array<ArrayBuffer>;
        const name = convertedName(ctx.file.name, 'zip', new Set());
        const notices = [
          `按每秒 ${fps} 帧采样，导出 ${frames.length} 帧`,
          ...(capped ? [`已达单次 ${MAX_FRAMES} 帧上限，之后的画面未导出`] : []),
          format === 'png' ? 'PNG 为无损截图' : 'JPG 为有损压缩，体积更小',
          '只保留采样到的画面：声音、字幕与未采样的帧均不保留',
        ];
        return {
          outputs: [{ blob: new Blob([zipped], { type: FORMATS.zip.mime }), name }],
          mime: FORMATS.zip.mime,
          ext: 'zip',
          inputSize: ctx.file.size,
          outputSize: zipped.byteLength,
          notices,
          previewKind: 'none',
        } satisfies ConvertResultData;
      },
      status: 'live',
      group: '提取',
    },
    {
      id: 'video:to-gif',
      label: 'GIF 动图（无声音）',
      from: [...VIDEO_KINDS],
      to: 'gif',
      method: 'reencode',
      notices: ['GIF 不含声音', '256 色调色板，颜色可能有失真', '体积可能明显大于原视频'],
      params: [
        { key: 'fps', label: '帧率', type: 'number', min: 1, max: 30, step: 1, defaultValue: 10, unit: 'fps' },
        { key: 'maxWidth', label: '最大宽度', type: 'number', min: 120, max: 1280, step: 10, defaultValue: 480, unit: 'px' },
      ],
      requires: ['worker', 'ffmpeg'],
      estimateOutput: () => null,
      run: async (ctx) => {
        const { eng, bytes, ext, probe } = await prepareMedia(ctx, { requireVideo: true });
        const fps = numParam(ctx.params, 'fps', 10, 1, 30);
        const maxWidth = numParam(ctx.params, 'maxWidth', 480, 120, 1280);
        const width = evenScaleWidth(pickFirstVideo(probe.streams)?.width, maxWidth);
        const inputName = `input.${ext}`;
        const paletteName = 'palette.png';
        const outputName = 'output.gif';
        // 双遍：先按同一条滤镜链生成专用调色板，再用它渲染
        // （单遍是通用 256 色，渐变必花 —— 调色板必须来自这条视频自己）
        ctx.onPhase('converting');
        const pass1 = await eng.exec(
          buildGifPaletteArgs({ inputName, paletteName, fps, width }),
          [{ name: inputName, data: bytes }],
          [paletteName],
          {
            timeoutMs: LIMITS.timeouts.transcodeVideoMs,
            onProgress: (p) => ctx.onProgress(p === null ? null : p * 0.5),
            signal: ctx.signal,
          }
        );
        throwIfAborted(ctx.signal);
        const paletteBytes = takeOutput(pass1.files, paletteName, pass1.log);
        const pass2 = await eng.exec(
          buildGifRenderArgs({ inputName, paletteName, outputName, fps, width }),
          [
            { name: inputName, data: bytes },
            { name: paletteName, data: paletteBytes },
          ],
          [outputName],
          {
            timeoutMs: LIMITS.timeouts.transcodeVideoMs,
            onProgress: (p) => ctx.onProgress(p === null ? null : 0.5 + p * 0.5),
            signal: ctx.signal,
          }
        );
        throwIfAborted(ctx.signal);
        const out = takeOutput(pass2.files, outputName, pass2.log);
        return videoResult(ctx, out, 'gif', [
          `已降为 ${fps} fps、宽 ${width}px`,
          'GIF 不含声音',
          '256 色调色板，颜色可能有失真',
          '体积可能明显大于原视频',
          ...extraVideoTrackNotice(probe.streams),
        ]);
      },
      status: 'live',
      group: '动图',
    },
    {
      id: 'video:to-webp-anim',
      label: '动画 WebP（比 GIF 小，网页用）',
      from: [...VIDEO_KINDS],
      to: 'webp',
      method: 'reencode',
      notices: ['有损重编码为动画 WebP，不含声音', '元数据不保留'],
      params: [
        { key: 'fps', label: '帧率', type: 'number', min: 1, max: 30, step: 1, defaultValue: 10, unit: 'fps' },
        { key: 'maxWidth', label: '最大宽度', type: 'number', min: 120, max: 1280, step: 10, defaultValue: 480, unit: 'px' },
      ],
      requires: ['worker', 'ffmpeg', 'ffmpeg-enc:libwebp'],
      estimateOutput: () => null,
      run: async (ctx) => {
        const { eng, bytes, ext, probe } = await prepareMedia(ctx, { requireVideo: true });
        assertEncoderAvailable(ctx.capabilities, 'libwebp');
        const fps = numParam(ctx.params, 'fps', 10, 1, 30);
        const maxWidth = numParam(ctx.params, 'maxWidth', 480, 120, 1280);
        const width = evenScaleWidth(pickFirstVideo(probe.streams)?.width, maxWidth);
        const io: IoNames = { inputName: `input.${ext}`, outputName: 'output.webp' };
        const out = await execToSingleOutput(ctx, eng, buildVideoToWebpAnim({ ...io, fps, width, quality: 80 }), io, bytes);
        return videoResult(ctx, out, 'webp', [
          `已降为 ${fps} fps、宽 ${width}px`,
          '有损重编码为动画 WebP（画质 80），不含声音',
          '元数据不保留',
          ...extraVideoTrackNotice(probe.streams),
        ]);
      },
      status: 'live',
      group: '动图',
    },
    {
      id: 'video:frames-to-video',
      label: '图片序列合成 MP4（按文件名排序）',
      from: ['png', 'jpeg'],
      to: 'mp4',
      method: 'reencode',
      notices: ['按文件名顺序逐帧合成', '重编码为 H.264（有损）', '不生成音轨'],
      params: [
        { key: 'fps', label: '帧率', type: 'number', min: 1, max: 60, step: 1, defaultValue: 10, unit: 'fps', help: '每秒播放几张图片' },
      ],
      requires: ['worker', 'ffmpeg', 'ffmpeg-enc:libx264'],
      estimateOutput: () => null,
      run: async (ctx) => {
        const files = ctx.files;
        if (files.length < 2) throw unsupported('图片序列合成至少需要 2 张图片');
        if (files.length > MAX_SEQUENCE_FILES) {
          throw oversize(`一次最多合成 ${MAX_SEQUENCE_FILES} 张图片（当前 ${files.length} 张）`);
        }
        let total = 0;
        for (const f of files) {
          if (f.size > LIMITS.image.maxBytes) {
            throw oversize(`「${f.name}」${formatBytes(f.size)} 超过单张 ${formatBytes(LIMITS.image.maxBytes)} 上限`);
          }
          total += f.size;
        }
        if (total > LIMITS.video.maxBytes) {
          throw oversize(`图片总量 ${formatBytes(total)} 超过 ${formatBytes(LIMITS.video.maxBytes)} 上限`);
        }
        const eng = await loadEngine(ctx);
        // 按文件名自然序排序（img2 排在 img10 前的常识顺序），再改名成连续序号喂 image2
        const sorted = [...files].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
        const raw: Uint8Array[] = [];
        for (const f of sorted) {
          throwIfAborted(ctx.signal);
          raw.push(new Uint8Array(await f.arrayBuffer()));
        }
        // 以字节验明正身（不信扩展名）；格式必须统一 —— image2 用单一模式串喂入，
        // 混合内容是否逐张重探测随版本而异，与其赌引擎行为，不如明确拒绝。
        const kinds = raw.map(sniffRasterKind);
        const badIdx = kinds.findIndex((k) => k === null);
        if (badIdx >= 0) {
          throw unsupported(`「${sorted[badIdx].name}」的字节不是 PNG / JPG 图片（以字节为准，不看扩展名）`);
        }
        if (new Set(kinds).size > 1) {
          throw unsupported('图片序列的格式必须统一（全 PNG 或全 JPG），当前混合格式；请先在「图片」标签页转成同一格式');
        }
        const seqExt = kinds[0] === 'png' ? 'png' : 'jpg';
        const inputs = raw.map((data, i) => ({ name: `in${String(i).padStart(3, '0')}.${seqExt}`, data }));
        const fps = numParam(ctx.params, 'fps', 10, 1, 60);
        assertEncoderAvailable(ctx.capabilities, 'libx264');
        const outputName = 'output.mp4';
        ctx.onPhase('converting');
        const { files: outFiles, log } = await eng.exec(
          buildFramesToVideo({ inputPattern: `in%03d.${seqExt}`, outputName, fps }),
          inputs,
          [outputName],
          {
            timeoutMs: LIMITS.timeouts.transcodeVideoMs,
            onProgress: (p) => ctx.onProgress(p),
            signal: ctx.signal,
          }
        );
        throwIfAborted(ctx.signal);
        const out = takeOutput(outFiles, outputName, log);
        return videoResult(ctx, out, 'mp4', [
          `按文件名顺序合成 ${sorted.length} 张图片（数字按自然序排列）`,
          `帧率 ${fps} fps，重编码为 H.264（有损）`,
          '画面尺寸归一到偶数（奇数边裁掉至多 1 像素）；透明通道不保留',
          '不生成音轨；源图的元数据不保留',
        ]);
      },
      status: 'live',
      group: '合成',
    },
  ],
  // probe：给「选音轨 / 字幕轨」与 remux 自适应边填轨清单。只对视频族嗅探结果触发；
  // 失败降级为 {}（没有轨信息只是退回「自动（第一条）」，不挡转换）。
  probe: async (file, info) => {
    try {
      if (!(VIDEO_KINDS as readonly string[]).includes(info.sniff.kind)) return {};
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
