// ─────────────────────────────────────────────────────────────────────────────
// file-converter/engines/ffmpeg-args.ts —— 全部 FFmpeg argv 拼装的**唯一**实现
// （零依赖纯函数，node 单测逐数组钉死）。
//
// 【它是什么】音频 / 视频两个能力区所有转换边的命令行参数构造。输入是结构化参数
//   （引擎内部输入 / 输出名、码率、轨道映射、滤镜参数），输出是精确的 argv 数组。
//
// 【为什么独立】参数拼装是纯逻辑 —— 拖进 node 单测（tests/unit/file-converter-
//   ffmpeg-args.test.ts）不必启动 wasm 核心就能钉住每一个 flag。category 模块只
//   负责探测、限额、调用引擎与组装说明，**不在本文件之外拼任何一个 flag**。
//
// 【纪律】
//   · 零运行时依赖（type import 除外）。不许出现 DOM / fetch / 引擎调用。
//   · 轨道选择一律用**类型相对序号**（0:a:N = 第 N+1 条音频轨、0:s:N = 第 N+1 条
//     字幕轨），不用容器内的绝对流序号 —— 页面上「音轨 1」就是音频列表里的第一条，
//     与它前面有没有视频轨无关。
//   · 用户输入不直接进 argv：码率 / 采样率 / 预设名在调用前已按白名单解析，
//     这里的入参一律是结构化值（字面量联合 / number）。
// ─────────────────────────────────────────────────────────────────────────────

import type { StreamInfo } from '../types';

/** 所有调用的公共头：不打印 banner、不从 stdin 读交互命令（wasm 环境没有 stdin）。 */
const HEAD = ['-hide_banner', '-nostdin'] as const;

export interface IoNames {
  /** 引擎内部输入名（如 input.mp4）—— 不是用户文件名。 */
  inputName: string;
  /** 引擎内部输出名（如 output.mp3）。 */
  outputName: string;
}

// ─── 轨道映射（类型相对序号，见文件头纪律）────────────────────────────────────

/** 第 ordinal 条音频轨的 -map 值（ordinal 从 0 起）。 */
export function audioMapOf(ordinal: number): string {
  return `0:a:${ordinal}`;
}

/** 第 ordinal 条字幕轨的 -map 值（ordinal 从 0 起）。 */
export function subtitleMapOf(ordinal: number): string {
  return `0:s:${ordinal}`;
}

// ─── 流筛选与路线决策（纯判断，category 的 runner 与 estimateOutput 共用）──────

export function pickFirstVideo(streams: readonly StreamInfo[]): StreamInfo | null {
  return streams.find((s) => s.type === 'video') ?? null;
}

export function pickAudioStreams(streams: readonly StreamInfo[]): StreamInfo[] {
  return streams.filter((s) => s.type === 'audio');
}

/**
 * video:remux-to-mp4 的自适应判据（roadmap §6.3 例 1/2）：
 * 第一条视频轨是 H.264，且第一条音频轨是 AAC / MP3 / 不存在 → 整条 copy 进 MP4；
 * 否则需要重编码（调用方据此在 requires 里声明 libx264 / aac）。
 * 注意：**调用方必须先确认存在视频轨** —— 没有视频轨时本函数返回 'reencode'，
 * 但那只是「没有可 copy 的东西」，不是「应该转码」。
 */
export function decideMp4Route(streams: readonly StreamInfo[]): 'copy' | 'reencode' {
  const v = pickFirstVideo(streams);
  if (!v || v.codec !== 'h264') return 'reencode';
  const a = pickAudioStreams(streams)[0];
  if (a && a.codec !== 'aac' && a.codec !== 'mp3') return 'reencode';
  return 'copy';
}

/** 缩放宽度归一：不超过 maxWidth、不超过源宽（不放大的源不放大）、取偶数（编码器要求）。 */
export function evenScaleWidth(srcWidth: number | null | undefined, maxWidth: number): number {
  const cap = Math.max(2, Math.floor(maxWidth));
  const raw = srcWidth && srcWidth > 0 ? Math.min(Math.floor(srcWidth), cap) : cap;
  const even = raw % 2 === 0 ? raw : raw - 1;
  return Math.max(2, even);
}

// ─── 音频编码参数（audio 各边与 video:extract-audio 共用一份）─────────────────

/** 视频提取音频 / 音频重编码的目标格式。 */
export type ExtractAudioFormat = 'mp3' | 'm4a' | 'ogg' | 'flac' | 'wav';

export const EXTRACT_AUDIO_FORMATS: readonly ExtractAudioFormat[] = ['mp3', 'm4a', 'ogg', 'flac', 'wav'];

/**
 * 「能 copy 就 copy」矩阵：目标格式 → 源编码白名单。
 * 命中即可 `-c:a copy`（零损失抽取）；不在表内必须重编码（**不许偷偷转码却宣称换封装**）。
 */
export const AUDIO_COPY_OK: Record<ExtractAudioFormat, readonly string[]> = {
  mp3: ['mp3'],
  m4a: ['aac'],
  ogg: ['vorbis', 'opus'],
  flac: ['flac'],
  wav: ['pcm_s16le', 'pcm_s16be', 'pcm_s24le', 'pcm_s32le', 'pcm_u8', 'pcm_f32le', 'pcm_f64le'],
};

export function canCopyAudio(sourceCodec: string, target: ExtractAudioFormat): boolean {
  return AUDIO_COPY_OK[target].includes(sourceCodec);
}

/** 各目标格式重编码所需的 ffmpeg 编码器名（null = 原生 PCM，无需外部编码器）。 */
export const EXTRACT_ENCODER: Record<ExtractAudioFormat, string | null> = {
  mp3: 'libmp3lame',
  m4a: 'aac',
  ogg: 'libvorbis',
  flac: null,
  wav: null,
};

/**
 * 重编码音频段参数（extract-audio 与音频互转共用口径）。
 * bitrate 是已按白名单校验的字符串（如 '192'）。m4a 固定 192k；flac / wav 无码率概念；
 * wav 重采样与否由调用方决定（这里不重采样，保留源采样率）。
 */
export function audioEncodeArgsFor(format: ExtractAudioFormat, bitrate: string): string[] {
  switch (format) {
    case 'mp3':
      return ['-c:a', 'libmp3lame', '-b:a', `${bitrate}k`];
    case 'm4a':
      return ['-c:a', 'aac', '-b:a', '192k'];
    case 'ogg':
      return ['-c:a', 'libvorbis', '-b:a', `${bitrate}k`];
    case 'flac':
      return ['-c:a', 'flac'];
    case 'wav':
      return ['-c:a', 'pcm_s16le'];
  }
}

// ─── 容器 / 编码白名单 ─────────────────────────────────────────────────────────

/** OGG → WebM 换封装：WebM 容器只装这两种音频编码。 */
export const REPACKAGE_WEBM_CODECS: readonly string[] = ['vorbis', 'opus'];

/** 可转 SRT 文本的字幕编码；图形字幕（dvd_subtitle 等）不在其列 —— 转了就是空文件。 */
export const TEXT_SUBTITLE_CODECS: readonly string[] = ['subrip', 'ass', 'ssa', 'webvtt', 'mov_text'];

// ─── 音频边 argv ───────────────────────────────────────────────────────────────
//
// 公共形状：-i 输入 → -vn（丢弃封面 / 视频轨）→ -map_metadata -1（不复制标签与封面，
// plan §3.3「元数据不保留」）→ 编码参数 → -y 输出。

export function buildAudioToMp3(io: IoNames & { bitrate: string }): string[] {
  return [...HEAD, '-i', io.inputName, '-vn', '-map_metadata', '-1', '-c:a', 'libmp3lame', '-b:a', `${io.bitrate}k`, '-y', io.outputName];
}

export function buildAudioToWav(io: IoNames & { sampleRate: string }): string[] {
  return [...HEAD, '-i', io.inputName, '-vn', '-map_metadata', '-1', '-c:a', 'pcm_s16le', '-ar', io.sampleRate, '-y', io.outputName];
}

export function buildAudioToFlac(io: IoNames): string[] {
  return [...HEAD, '-i', io.inputName, '-vn', '-map_metadata', '-1', '-c:a', 'flac', '-y', io.outputName];
}

export function buildAudioToOgg(io: IoNames & { codec: 'libvorbis' | 'libopus' }): string[] {
  const codecArgs = io.codec === 'libvorbis' ? ['-c:a', 'libvorbis', '-q:a', '4'] : ['-c:a', 'libopus', '-b:a', '128k'];
  return [...HEAD, '-i', io.inputName, '-vn', '-map_metadata', '-1', ...codecArgs, '-y', io.outputName];
}

export function buildAudioToM4a(io: IoNames): string[] {
  return [...HEAD, '-i', io.inputName, '-vn', '-map_metadata', '-1', '-c:a', 'aac', '-b:a', '192k', '-y', io.outputName];
}

export function buildAudioToAiff(io: IoNames & { sampleRate: string }): string[] {
  return [...HEAD, '-i', io.inputName, '-vn', '-map_metadata', '-1', '-c:a', 'pcm_s16be', '-ar', io.sampleRate, '-y', io.outputName];
}

/** 同编码换封装：整条 copy，不接触 PCM。调用方必须先验证编码在目标容器白名单内。 */
export function buildAudioRemux(io: IoNames): string[] {
  return [...HEAD, '-i', io.inputName, '-vn', '-map_metadata', '-1', '-c:a', 'copy', '-y', io.outputName];
}

// ─── 视频边 argv ───────────────────────────────────────────────────────────────
//
// MP4 / WebM 输出只带入第一条视频轨与第一条音频轨（字幕 / 多余轨道由调用方写进
// notices，不静默丢弃）；MKV 换封装带入全部轨道（matroska 什么都能装）。

/** 换封装进 MP4（前提：decideMp4Route 判过 copy）。faststart 让 moov 前置，网页可流式播。 */
export function buildVideoRemuxMp4(io: IoNames): string[] {
  return [...HEAD, '-i', io.inputName, '-map', '0:v:0', '-map', '0:a:0?', '-map_metadata', '-1', '-c', 'copy', '-movflags', '+faststart', '-y', io.outputName];
}

/** 换封装进 MKV：整容器所有轨道原样复制。 */
export function buildVideoRemuxMkv(io: IoNames): string[] {
  return [...HEAD, '-i', io.inputName, '-map', '0', '-map_metadata', '-1', '-c', 'copy', '-y', io.outputName];
}

/** 显式重编码 H.264 + AAC（pix_fmt yuv420p：10bit / HDR 源落到通用 8bit，保证可播）。 */
export function buildVideoReencodeMp4(io: IoNames & { crf: number; preset: string }): string[] {
  return [
    ...HEAD, '-i', io.inputName, '-map', '0:v:0', '-map', '0:a:0?', '-map_metadata', '-1',
    '-c:v', 'libx264', '-crf', String(io.crf), '-preset', io.preset, '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', '-y', io.outputName,
  ];
}

export function buildVideoToWebm(io: IoNames & { crf: number }): string[] {
  return [
    ...HEAD, '-i', io.inputName, '-map', '0:v:0', '-map', '0:a:0?', '-map_metadata', '-1',
    '-c:v', 'libvpx-vp9', '-crf', String(io.crf), '-b:v', '0',
    '-c:a', 'libopus', '-b:a', '128k', '-y', io.outputName,
  ];
}

/** 提取音频：audioMap 由 audioMapOf 生成；codecArgs 是 ['-c:a','copy'] 或 audioEncodeArgsFor。 */
export function buildVideoExtractAudio(io: IoNames & { audioMap: string; codecArgs: string[] }): string[] {
  return [...HEAD, '-i', io.inputName, '-map', io.audioMap, '-vn', '-map_metadata', '-1', ...io.codecArgs, '-y', io.outputName];
}

// ─── GIF 双遍（先调色板再渲染 —— 单遍 palette 是通用 256 色，渐变必花）─────────

export function buildGifPaletteArgs(p: { inputName: string; paletteName: string; fps: number; width: number }): string[] {
  return [...HEAD, '-i', p.inputName, '-vf', `fps=${p.fps},scale=${p.width}:-2:flags=lanczos,palettegen`, '-y', p.paletteName];
}

export function buildGifRenderArgs(p: { inputName: string; paletteName: string; outputName: string; fps: number; width: number }): string[] {
  return [
    ...HEAD, '-i', p.inputName, '-i', p.paletteName,
    '-filter_complex', `fps=${p.fps},scale=${p.width}:-2:flags=lanczos[x];[x][1:v]paletteuse`,
    '-y', p.outputName,
  ];
}

// ─── 动图 / 帧序列 / 字幕 ──────────────────────────────────────────────────────

export function buildVideoToWebpAnim(io: IoNames & { fps: number; width: number; quality: number }): string[] {
  return [
    ...HEAD, '-i', io.inputName, '-map', '0:v:0', '-map_metadata', '-1',
    '-vf', `fps=${io.fps},scale=${io.width}:-2:flags=lanczos`, '-an',
    '-c:v', 'libwebp', '-q:v', String(io.quality), '-loop', '0', '-y', io.outputName,
  ];
}

/**
 * 抽帧：输出名是 image2 模式串（如 frame-%04d.png）。jpg 时给固定质量 -q:v 3。
 * maxFrames 是帧数硬上限（-frames:v）—— MEMFS 装不下无界序列，调用方必须先算好
 * 「时长 × 帧率」并在超限时把它传进来（配合 notices 如实说明截断）。
 */
export function buildVideoToFrames(p: {
  inputName: string;
  outputPattern: string;
  fps: number;
  format: 'png' | 'jpg';
  maxFrames?: number;
}): string[] {
  const args = [...HEAD, '-i', p.inputName, '-map', '0:v:0', '-vf', `fps=${p.fps}`];
  if (p.format === 'jpg') args.push('-q:v', '3');
  if (p.maxFrames !== undefined && p.maxFrames > 0) args.push('-frames:v', String(Math.floor(p.maxFrames)));
  args.push('-y', p.outputPattern);
  return args;
}

/**
 * 图片序列合成 MP4（image2 模式串 + 显式 -start_number 0：不同版本默认值不一致，
 * 不显式写死就会出现「改个版本就少第一帧」的静默错）。文件必须已按序号改名喂入。
 * scale 归一为偶数尺寸：libx264 + yuv420p 要求宽高可被 2 整除，奇数边裁至多 1px。
 */
export function buildFramesToVideo(p: { inputPattern: string; outputName: string; fps: number }): string[] {
  return [
    ...HEAD, '-framerate', String(p.fps), '-start_number', '0', '-i', p.inputPattern,
    '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-y', p.outputName,
  ];
}

/** 提取文本字幕轨为 SRT。调用方必须先验证编码在 TEXT_SUBTITLE_CODECS 内。 */
export function buildExtractSubtitle(io: IoNames & { subtitleMap: string }): string[] {
  return [...HEAD, '-i', io.inputName, '-map', io.subtitleMap, '-c:s', 'srt', '-y', io.outputName];
}
