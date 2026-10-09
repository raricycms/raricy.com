// file-converter/engines/ffmpeg-parse.ts —— ffmpeg 文本输出的解析。
//
// 【这组用例钉的是什么】
//   · -encoders / -decoders 清单：名字列的提取（图例行 / 分隔线 / banner 不得混入）；
//   · -i 探测：Duration、容器名、三类流（视频 / 音频 / 字幕）的 codec / 分辨率 /
//     采样率 / 声道数、语言标签的两处来源（流号括号 + 流级 Metadata）；
//   · 宽容性：损坏流缺 Duration、完全认不出的输入、行格式变体 —— 一律不抛，
//     给 null / 缺省。解析器的输入是上游打印文本，不是契约，绷得太紧才会出事故。
//
// 样本按 ffmpeg 6.x/7.x 的真实输出形态内嵌（ffmpeg.wasm 0.12 核心是 6.x/7.x 系）。

import { describe, it, expect } from 'vitest';
import { parseDecoders, parseEncoders, parseProbe } from '@/lib/file-converter/engines/ffmpeg-parse';

// ─── parseEncoders / parseDecoders ─────────────────────────────────────────────

const ENCODERS_SAMPLE = `Encoders:
 V..... = Video
 A..... = Audio
 S..... = Subtitle
 .F.... = Frame-level multithreading
 ..S... = Slice-level multithreading
 ...X.. = Codec is experimental
 ....B. = Supports draw_horiz_band
 .....D = Supports direct rendering method 1
 ------
 V....D a64multi             Multicolor charset for Commodore 64 (codec a64multi)
 V....D libx264              libx264 H.264 / AVC / MPEG-4 AVC / MPEG-4 part 10 (codec h264)
 V....D libvpx-vp9           libvpx VP9 (codec vp9)
 A....D aac                  AAC (Advanced Audio Coding)
 A....D libmp3lame           libmp3lame MP3 (MPEG audio layer 3) (codec mp3)
 A....D pcm_s16le            PCM signed 16-bit little-endian
 S....D srt                  SubRip subtitle (codec subrip)
`;

const DECODERS_SAMPLE = `ffmpeg version 6.1.1 Copyright (c) 2000-2023 the FFmpeg developers
  built with emscripten 3.1.51
  configuration: --enable-cross-compile
Decoders:
 V..... = Video
 A..... = Audio
 S..... = Subtitle
 .F.... = Frame-level multithreading
 ..S... = Slice-level multithreading
 ...X.. = Codec is experimental
 ....B. = Supports draw_horiz_band
 .....D = Supports direct rendering method 1
 ------
 V....D h264                 H.264 / AVC / MPEG-4 AVC / MPEG-4 part 10
 V....D hevc                 HEVC (High Efficiency Video Coding)
 A....D aac                  AAC (Advanced Audio Coding)
 A....D mp3                  MP3 (MPEG audio layer 3)
 A....D flac                 FLAC (Free Lossless Audio Codec)
 S....D subrip               SubRip subtitle
`;

describe('parseEncoders', () => {
  it('提取编码器名，跳过表头 / 图例 / 分隔线', () => {
    expect(parseEncoders(ENCODERS_SAMPLE)).toEqual([
      'a64multi',
      'libx264',
      'libvpx-vp9',
      'aac',
      'libmp3lame',
      'pcm_s16le',
      'srt',
    ]);
  });

  it('空输入与纯 banner 给空数组（不抛）', () => {
    expect(parseEncoders('')).toEqual([]);
    expect(parseEncoders('ffmpeg version 6.1.1\n  built with emscripten\n')).toEqual([]);
  });
});

describe('parseDecoders', () => {
  it('提取解码器名；banner 行不混入', () => {
    // banner 里有两格缩进的 configuration 行 —— 形状与清单一格缩进不同，不得误入
    expect(parseDecoders(DECODERS_SAMPLE)).toEqual(['h264', 'hevc', 'aac', 'mp3', 'flac', 'subrip']);
  });

  it('去重（同名重复行只留一个）', () => {
    const dup = `Decoders:
 A....D aac                  AAC (Advanced Audio Coding)
 A....D aac                  AAC (Advanced Audio Coding)
`;
    expect(parseDecoders(dup)).toEqual(['aac']);
  });
});

// ─── parseProbe ────────────────────────────────────────────────────────────────

const PROBE_MP3 = `Input #0, mp3, from 'in.mp3':
  Metadata:
    title           : Sample Tone
  Duration: 00:03:02.50, start: 0.025056, bitrate: 128 kb/s
  Stream #0:0: Audio: mp3, 44100 Hz, stereo, fltp, 128 kb/s
    Metadata:
      encoder         : LAME3.100
`;

const PROBE_MKV = `Input #0, matroska,webm, from 'in.mkv':
  Metadata:
    encoder         : libebml v1.4.2 + libmatroska v1.6.4
  Duration: 00:01:23.45, start: 0.000000, bitrate: 1200 kb/s
  Stream #0:0[0x1](und): Video: h264 (High) (avc1 / 0x31637661), yuv420p, 1920x1080 [SAR 1:1 DAR 16:9], 25 fps, 25 tbr, 1k tbn (default)
    Metadata:
      handler_name    : VideoHandler
      vendor_id       : [0][0][0][0]
  Stream #0:1[0x2](chi): Audio: aac (LC) (mp4a / 0x6134706D), 44100 Hz, stereo, fltp, 128 kb/s (default)
    Metadata:
      language        : chi
  Stream #0:2[0x3](eng): Audio: ac3, 48000 Hz, 5.1(side), fltp, 384 kb/s
    Metadata:
      title           : Surround
  Stream #0:3[0x4](und): Subtitle: subrip (default)
    Metadata:
      language        : eng
At least one output file must be specified
`;

const PROBE_MPEGTS_NO_DURATION = `Input #0, mpegts, from 'in.ts':
  Duration: N/A, start: 1.400000, bitrate: N/A
  Program 1
  Stream #0:0[0x100]: Video: mpeg2video (Main) ([2][0][0][0] / 0x0002), yuv420p(tv), 704x576 [SAR 12:11 DAR 4:3], 25 fps, 25 tbr, 90k tbn
  Stream #0:1[0x101]: Audio: mp2, 48000 Hz, 2 channels, s16p, 192 kb/s
`;

describe('parseProbe —— 纯音频 mp3', () => {
  it('容器名 / 时长 / 音频流三要素', () => {
    const r = parseProbe(PROBE_MP3);
    expect(r.formatName).toBe('mp3');
    expect(r.durationSec).toBeCloseTo(182.5, 5);
    expect(r.streams).toHaveLength(1);
    expect(r.streams[0]).toEqual({ index: 0, type: 'audio', codec: 'mp3', sampleRate: 44100, channels: 2 });
  });
});

describe('parseProbe —— 多轨 mkv（视频 + 双音轨 + 字幕）', () => {
  it('容器名取 demuxer 名单', () => {
    expect(parseProbe(PROBE_MKV).formatName).toBe('matroska,webm');
  });

  it('时长按 时:分:秒 换算', () => {
    expect(parseProbe(PROBE_MKV).durationSec).toBeCloseTo(83.45, 5);
  });

  it('视频流：codec / 分辨率；und 语言当作没有', () => {
    const v = parseProbe(PROBE_MKV).streams[0];
    expect(v.type).toBe('video');
    expect(v.codec).toBe('h264');
    expect(v.width).toBe(1920);
    expect(v.height).toBe(1080);
    // codec tag 的十六进制（0x31637661）与 SAR/DAR（16:9）不得被认成分辨率
    expect(v.language).toBeUndefined();
  });

  it('音轨 1：括号语言 chi；采样率与 stereo → 2 声道', () => {
    const a = parseProbe(PROBE_MKV).streams[1];
    expect(a).toMatchObject({ index: 1, type: 'audio', codec: 'aac', sampleRate: 44100, channels: 2, language: 'chi' });
  });

  it('音轨 2：5.1(side) → 6 声道；括号语言 eng', () => {
    const a = parseProbe(PROBE_MKV).streams[2];
    expect(a).toMatchObject({ index: 2, type: 'audio', codec: 'ac3', sampleRate: 48000, channels: 6, language: 'eng' });
  });

  it('字幕轨：类型 / codec；括号 und 由流级 Metadata 的 language 补上', () => {
    const s = parseProbe(PROBE_MKV).streams[3];
    expect(s).toMatchObject({ index: 3, type: 'subtitle', codec: 'subrip', language: 'eng' });
  });
});

describe('parseProbe —— 无 Duration 的损坏 / 直播形态流', () => {
  it('Duration: N/A → durationSec 为 null，其余照常解析', () => {
    const r = parseProbe(PROBE_MPEGTS_NO_DURATION);
    expect(r.formatName).toBe('mpegts');
    expect(r.durationSec).toBeNull();
    expect(r.streams).toHaveLength(2);
    expect(r.streams[0]).toMatchObject({ index: 0, type: 'video', codec: 'mpeg2video', width: 704, height: 576 });
  });

  it('`2 channels` 形态的声道数', () => {
    const a = parseProbe(PROBE_MPEGTS_NO_DURATION).streams[1];
    expect(a).toMatchObject({ type: 'audio', codec: 'mp2', sampleRate: 48000, channels: 2 });
    expect(a.language).toBeUndefined(); // 只有 [0x101] 没有括号语言
  });
});

describe('parseProbe —— 宽容性', () => {
  it('完全认不出的输入：空结果，不抛', () => {
    const r = parseProbe(`in.bin: Invalid data found when processing input\n`);
    expect(r).toEqual({ durationSec: null, streams: [], formatName: '' });
  });

  it('空串 / 杂项日志：空结果，不抛', () => {
    expect(parseProbe('')).toEqual({ durationSec: null, streams: [], formatName: '' });
    expect(parseProbe('frame=  100 fps= 25 q=28.0 size=     256kB time=00:00:04.00')).toEqual({
      durationSec: null,
      streams: [],
      formatName: '',
    });
  });

  it('Data / Attachment 流归为 other', () => {
    const text = `Input #0, matroska,webm, from 'in.mkv':
  Duration: 00:00:10.00, start: 0.000000, bitrate: 100 kb/s
  Stream #0:0: Video: vp9, yuv420p, 640x360, 25 fps, 25 tbr, 1k tbn
  Stream #0:1: Data: bin_data
  Stream #0:2: Attachment: ttf
`;
    const r = parseProbe(text);
    expect(r.streams.map((s) => s.type)).toEqual(['video', 'other', 'other']);
  });

  it('CRLF 换行同样解析', () => {
    const crlf = PROBE_MP3.replace(/\n/g, '\r\n');
    const r = parseProbe(crlf);
    expect(r.formatName).toBe('mp3');
    expect(r.durationSec).toBeCloseTo(182.5, 5);
    expect(r.streams[0]).toMatchObject({ codec: 'mp3', channels: 2 });
  });
});
