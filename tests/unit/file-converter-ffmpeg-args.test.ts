// ─────────────────────────────────────────────────────────────────────────────
// file-converter-ffmpeg-args.test.ts —— FFmpeg argv 拼装的逐数组钉死（node 环境）。
//
// 【为什么逐数组钉】argv 是纯逻辑，错一个 flag 就是「转换静默走错路」：
//   · 轨道映射必须是**类型相对序号**（0:a:N），写成容器绝对序号会随轨序漂移；
//   · GIF 必须是双遍（palettegen → paletteuse），单遍是通用 256 色、渐变必花；
//   · 「能 copy 就 copy」矩阵错了 = 宣称零损失实际重编码（或反过来）。
// 引擎本体（wasm）起不进单测，这里钉的是喂给它的每一个字节。
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from 'vitest';
import type { StreamInfo } from '@/lib/file-converter/types';
import {
  audioEncodeArgsFor,
  audioMapOf,
  buildAudioRemux,
  buildAudioToAiff,
  buildAudioToFlac,
  buildAudioToM4a,
  buildAudioToMp3,
  buildAudioToOgg,
  buildAudioToWav,
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
  AUDIO_COPY_OK,
  EXTRACT_AUDIO_FORMATS,
  EXTRACT_ENCODER,
  REPACKAGE_WEBM_CODECS,
  TEXT_SUBTITLE_CODECS,
} from '@/lib/file-converter/engines/ffmpeg-args';

const HEAD = ['-hide_banner', '-nostdin'];

// ─── 轨道映射（类型相对序号，与容器内绝对序号无关）────────────────────────────

describe('轨道映射（0:a:N / 0:s:N）', () => {
  it('audioMapOf / subtitleMapOf 生成类型相对序号', () => {
    expect(audioMapOf(0)).toBe('0:a:0');
    expect(audioMapOf(2)).toBe('0:a:2');
    expect(subtitleMapOf(0)).toBe('0:s:0');
    expect(subtitleMapOf(3)).toBe('0:s:3');
  });
});

// ─── 流筛选与 remux-to-mp4 路线决策 ──────────────────────────────────────────

const v = (codec: string, extra?: Partial<StreamInfo>): StreamInfo => ({ index: 0, type: 'video', codec, ...extra });
const a = (codec: string, extra?: Partial<StreamInfo>): StreamInfo => ({ index: 1, type: 'audio', codec, ...extra });
const s = (codec: string): StreamInfo => ({ index: 2, type: 'subtitle', codec });

describe('pickFirstVideo / pickAudioStreams', () => {
  it('只取第一条视频轨；音频轨保持原顺序', () => {
    const streams = [a('aac'), v('h264'), v('vp9'), a('opus'), s('subrip')];
    expect(pickFirstVideo(streams)?.codec).toBe('h264');
    expect(pickAudioStreams(streams).map((x) => x.codec)).toEqual(['aac', 'opus']);
    expect(pickFirstVideo([a('aac')])).toBeNull();
    expect(pickAudioStreams([v('h264')])).toEqual([]);
  });
});

describe('decideMp4Route（自适应换封装判据）', () => {
  it('h264 + aac / mp3 / 无音轨 → copy', () => {
    expect(decideMp4Route([v('h264'), a('aac')])).toBe('copy');
    expect(decideMp4Route([v('h264'), a('mp3')])).toBe('copy');
    expect(decideMp4Route([v('h264')])).toBe('copy');
  });

  it('视频非 h264 或首条音频不兼容 → reencode', () => {
    expect(decideMp4Route([v('h264'), a('opus')])).toBe('reencode');
    expect(decideMp4Route([v('vp9'), a('aac')])).toBe('reencode');
    expect(decideMp4Route([v('hevc')])).toBe('reencode');
  });

  it('判据只看第一条视频与第一条音频；无视频轨也回 reencode（调用方另行拦截）', () => {
    expect(decideMp4Route([v('vp9'), v('h264'), a('aac')])).toBe('reencode');
    expect(decideMp4Route([v('h264'), a('vorbis'), a('aac')])).toBe('reencode');
    expect(decideMp4Route([a('aac')])).toBe('reencode');
  });
});

describe('evenScaleWidth（不超上限、不放大、取偶）', () => {
  it('常规收敛', () => {
    expect(evenScaleWidth(1920, 1280)).toBe(1280);
    expect(evenScaleWidth(1000, 1280)).toBe(1000);
    expect(evenScaleWidth(719, 1280)).toBe(718);
    expect(evenScaleWidth(333, 480)).toBe(332);
  });

  it('未知源宽用上限；极端输入不塌成 0 / 奇数', () => {
    expect(evenScaleWidth(null, 480)).toBe(480);
    expect(evenScaleWidth(undefined, 300)).toBe(300);
    expect(evenScaleWidth(0, 480)).toBe(480);
    expect(evenScaleWidth(1, 480)).toBe(2);
  });
});

// ─── 「能 copy 就 copy」矩阵与编码器表 ────────────────────────────────────────

describe('AUDIO_COPY_OK / canCopyAudio', () => {
  it('逐格式白名单', () => {
    expect(canCopyAudio('mp3', 'mp3')).toBe(true);
    expect(canCopyAudio('aac', 'mp3')).toBe(false);
    expect(canCopyAudio('aac', 'm4a')).toBe(true);
    expect(canCopyAudio('vorbis', 'ogg')).toBe(true);
    expect(canCopyAudio('opus', 'ogg')).toBe(true);
    expect(canCopyAudio('mp3', 'ogg')).toBe(false);
    expect(canCopyAudio('flac', 'flac')).toBe(true);
    expect(canCopyAudio('pcm_s16le', 'wav')).toBe(true);
    expect(canCopyAudio('pcm_f64le', 'wav')).toBe(true);
    expect(canCopyAudio('aac', 'wav')).toBe(false);
  });

  it('白名单与格式表形状固定', () => {
    expect(EXTRACT_AUDIO_FORMATS).toEqual(['mp3', 'm4a', 'ogg', 'flac', 'wav']);
    expect(Object.keys(AUDIO_COPY_OK).sort()).toEqual([...EXTRACT_AUDIO_FORMATS].sort());
    expect(EXTRACT_ENCODER).toEqual({
      mp3: 'libmp3lame',
      m4a: 'aac',
      ogg: 'libvorbis',
      flac: null,
      wav: null,
    });
  });
});

describe('audioEncodeArgsFor（重编码音频段）', () => {
  it('五种目标的编码参数', () => {
    expect(audioEncodeArgsFor('mp3', '128')).toEqual(['-c:a', 'libmp3lame', '-b:a', '128k']);
    expect(audioEncodeArgsFor('m4a', '192')).toEqual(['-c:a', 'aac', '-b:a', '192k']);
    expect(audioEncodeArgsFor('ogg', '256')).toEqual(['-c:a', 'libvorbis', '-b:a', '256k']);
    expect(audioEncodeArgsFor('flac', '192')).toEqual(['-c:a', 'flac']);
    expect(audioEncodeArgsFor('wav', '192')).toEqual(['-c:a', 'pcm_s16le']);
  });
});

describe('容器 / 字幕编码白名单', () => {
  it('WebM 换封装只装 vorbis / opus', () => {
    expect(REPACKAGE_WEBM_CODECS).toEqual(['vorbis', 'opus']);
  });

  it('文本字幕编码白名单不含图形字幕', () => {
    for (const c of ['subrip', 'ass', 'ssa', 'webvtt', 'mov_text']) {
      expect(TEXT_SUBTITLE_CODECS).toContain(c);
    }
    expect(TEXT_SUBTITLE_CODECS).not.toContain('dvd_subtitle');
    expect(TEXT_SUBTITLE_CODECS).not.toContain('hdmv_pgs_subtitle');
  });
});

// ─── 音频边 argv ───────────────────────────────────────────────────────────────

describe('音频边 argv', () => {
  it('buildAudioToMp3（码率插值进 -b:a）', () => {
    expect(buildAudioToMp3({ inputName: 'input.ogg', outputName: 'output.mp3', bitrate: '192' })).toEqual([
      ...HEAD, '-i', 'input.ogg', '-vn', '-map_metadata', '-1',
      '-c:a', 'libmp3lame', '-b:a', '192k', '-y', 'output.mp3',
    ]);
    expect(buildAudioToMp3({ inputName: 'input.ogg', outputName: 'output.mp3', bitrate: '320' })).toContain('320k');
  });

  it('buildAudioToWav（pcm_s16le + 采样率）', () => {
    expect(buildAudioToWav({ inputName: 'input.mp3', outputName: 'output.wav', sampleRate: '48000' })).toEqual([
      ...HEAD, '-i', 'input.mp3', '-vn', '-map_metadata', '-1',
      '-c:a', 'pcm_s16le', '-ar', '48000', '-y', 'output.wav',
    ]);
  });

  it('buildAudioToFlac', () => {
    expect(buildAudioToFlac({ inputName: 'input.mp3', outputName: 'output.flac' })).toEqual([
      ...HEAD, '-i', 'input.mp3', '-vn', '-map_metadata', '-1',
      '-c:a', 'flac', '-y', 'output.flac',
    ]);
  });

  it('buildAudioToOgg（vorbis 与 opus 两条支路）', () => {
    expect(buildAudioToOgg({ inputName: 'input.mp3', outputName: 'output.ogg', codec: 'libvorbis' })).toEqual([
      ...HEAD, '-i', 'input.mp3', '-vn', '-map_metadata', '-1',
      '-c:a', 'libvorbis', '-q:a', '4', '-y', 'output.ogg',
    ]);
    expect(buildAudioToOgg({ inputName: 'input.mp3', outputName: 'output.ogg', codec: 'libopus' })).toEqual([
      ...HEAD, '-i', 'input.mp3', '-vn', '-map_metadata', '-1',
      '-c:a', 'libopus', '-b:a', '128k', '-y', 'output.ogg',
    ]);
  });

  it('buildAudioToM4a（固定 AAC 192k）', () => {
    expect(buildAudioToM4a({ inputName: 'input.wav', outputName: 'output.m4a' })).toEqual([
      ...HEAD, '-i', 'input.wav', '-vn', '-map_metadata', '-1',
      '-c:a', 'aac', '-b:a', '192k', '-y', 'output.m4a',
    ]);
  });

  it('buildAudioToAiff（pcm_s16be 大端）', () => {
    expect(buildAudioToAiff({ inputName: 'input.mp3', outputName: 'output.aiff', sampleRate: '44100' })).toEqual([
      ...HEAD, '-i', 'input.mp3', '-vn', '-map_metadata', '-1',
      '-c:a', 'pcm_s16be', '-ar', '44100', '-y', 'output.aiff',
    ]);
  });

  it('buildAudioRemux（整条 copy，绝不接触 PCM）', () => {
    expect(buildAudioRemux({ inputName: 'input.ogg', outputName: 'output.webm' })).toEqual([
      ...HEAD, '-i', 'input.ogg', '-vn', '-map_metadata', '-1',
      '-c:a', 'copy', '-y', 'output.webm',
    ]);
  });
});

// ─── 视频边 argv ───────────────────────────────────────────────────────────────

describe('视频边 argv', () => {
  it('buildVideoRemuxMp4（第一条视频 + 可选第一条音频，faststart）', () => {
    expect(buildVideoRemuxMp4({ inputName: 'input.mkv', outputName: 'output.mp4' })).toEqual([
      ...HEAD, '-i', 'input.mkv', '-map', '0:v:0', '-map', '0:a:0?', '-map_metadata', '-1',
      '-c', 'copy', '-movflags', '+faststart', '-y', 'output.mp4',
    ]);
  });

  it('buildVideoRemuxMkv（整容器 copy）', () => {
    expect(buildVideoRemuxMkv({ inputName: 'input.mp4', outputName: 'output.mkv' })).toEqual([
      ...HEAD, '-i', 'input.mp4', '-map', '0', '-map_metadata', '-1',
      '-c', 'copy', '-y', 'output.mkv',
    ]);
  });

  it('buildVideoReencodeMp4（libx264 + aac，yuv420p 兜底 10bit / HDR 源）', () => {
    expect(buildVideoReencodeMp4({ inputName: 'input.mkv', outputName: 'output.mp4', crf: 28, preset: 'veryfast' })).toEqual([
      ...HEAD, '-i', 'input.mkv', '-map', '0:v:0', '-map', '0:a:0?', '-map_metadata', '-1',
      '-c:v', 'libx264', '-crf', '28', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', '-y', 'output.mp4',
    ]);
  });

  it('buildVideoToWebm（VP9 CRF + 恒定质量 -b:v 0，Opus）', () => {
    expect(buildVideoToWebm({ inputName: 'input.mp4', outputName: 'output.webm', crf: 32 })).toEqual([
      ...HEAD, '-i', 'input.mp4', '-map', '0:v:0', '-map', '0:a:0?', '-map_metadata', '-1',
      '-c:v', 'libvpx-vp9', '-crf', '32', '-b:v', '0',
      '-c:a', 'libopus', '-b:a', '128k', '-y', 'output.webm',
    ]);
  });

  it('buildVideoExtractAudio（map 由调用方给；codecArgs 原样透传）', () => {
    expect(
      buildVideoExtractAudio({ inputName: 'input.mp4', outputName: 'output.mp3', audioMap: '0:a:1', codecArgs: ['-c:a', 'copy'] })
    ).toEqual([
      ...HEAD, '-i', 'input.mp4', '-map', '0:a:1', '-vn', '-map_metadata', '-1',
      '-c:a', 'copy', '-y', 'output.mp3',
    ]);
    expect(
      buildVideoExtractAudio({
        inputName: 'input.mkv',
        outputName: 'output.flac',
        audioMap: '0:a:0',
        codecArgs: audioEncodeArgsFor('flac', '192'),
      })
    ).toEqual([
      ...HEAD, '-i', 'input.mkv', '-map', '0:a:0', '-vn', '-map_metadata', '-1',
      '-c:a', 'flac', '-y', 'output.flac',
    ]);
  });

  it('buildExtractSubtitle（map 字幕轨 + 转 SRT）', () => {
    expect(buildExtractSubtitle({ inputName: 'input.mkv', outputName: 'output.srt', subtitleMap: '0:s:2' })).toEqual([
      ...HEAD, '-i', 'input.mkv', '-map', '0:s:2', '-c:s', 'srt', '-y', 'output.srt',
    ]);
  });
});

// ─── GIF 双遍 / 动图 / 帧序列 ─────────────────────────────────────────────────

describe('GIF 双遍（调色板与渲染必须用同一条滤镜链）', () => {
  it('第一遍：palettegen', () => {
    expect(buildGifPaletteArgs({ inputName: 'input.mp4', paletteName: 'palette.png', fps: 10, width: 480 })).toEqual([
      ...HEAD, '-i', 'input.mp4',
      '-vf', 'fps=10,scale=480:-2:flags=lanczos,palettegen', '-y', 'palette.png',
    ]);
  });

  it('第二遍：paletteuse（输入含调色板，filter_complex 拼接）', () => {
    expect(
      buildGifRenderArgs({ inputName: 'input.mp4', paletteName: 'palette.png', outputName: 'output.gif', fps: 12, width: 320 })
    ).toEqual([
      ...HEAD, '-i', 'input.mp4', '-i', 'palette.png',
      '-filter_complex', 'fps=12,scale=320:-2:flags=lanczos[x];[x][1:v]paletteuse',
      '-y', 'output.gif',
    ]);
  });
});

describe('动图 / 帧序列 argv', () => {
  it('buildVideoToWebpAnim（无声、循环、元数据剥离）', () => {
    expect(buildVideoToWebpAnim({ inputName: 'input.mp4', outputName: 'output.webp', fps: 10, width: 480, quality: 80 })).toEqual([
      ...HEAD, '-i', 'input.mp4', '-map', '0:v:0', '-map_metadata', '-1',
      '-vf', 'fps=10,scale=480:-2:flags=lanczos', '-an',
      '-c:v', 'libwebp', '-q:v', '80', '-loop', '0', '-y', 'output.webp',
    ]);
  });

  it('buildVideoToFrames（png 无质量档；jpg 固定 -q:v 3；maxFrames 给 -frames:v）', () => {
    expect(buildVideoToFrames({ inputName: 'input.mp4', outputPattern: 'frame-%04d.png', fps: 2, format: 'png' })).toEqual([
      ...HEAD, '-i', 'input.mp4', '-map', '0:v:0', '-vf', 'fps=2', '-y', 'frame-%04d.png',
    ]);
    expect(
      buildVideoToFrames({ inputName: 'input.mp4', outputPattern: 'frame-%04d.png', fps: 2, format: 'png', maxFrames: 150 })
    ).toEqual([
      ...HEAD, '-i', 'input.mp4', '-map', '0:v:0', '-vf', 'fps=2', '-frames:v', '150', '-y', 'frame-%04d.png',
    ]);
    expect(
      buildVideoToFrames({ inputName: 'input.mp4', outputPattern: 'frame-%04d.jpg', fps: 5, format: 'jpg', maxFrames: 150 })
    ).toEqual([
      ...HEAD, '-i', 'input.mp4', '-map', '0:v:0', '-vf', 'fps=5', '-q:v', '3', '-frames:v', '150', '-y', 'frame-%04d.jpg',
    ]);
  });

  it('buildFramesToVideo（显式 -start_number 0；偶数尺寸归一；无音轨）', () => {
    expect(buildFramesToVideo({ inputPattern: 'in%03d.png', outputName: 'output.mp4', fps: 10 })).toEqual([
      ...HEAD, '-framerate', '10', '-start_number', '0', '-i', 'in%03d.png',
      '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-y', 'output.mp4',
    ]);
  });
});

// ─── 卫生检查（防插值事故：undefined / NaN / 空串漏进 argv）────────────────────

describe('argv 卫生', () => {
  const ALL: [string, string[]][] = [
    ['to-mp3', buildAudioToMp3({ inputName: 'i.m4a', outputName: 'o.mp3', bitrate: '192' })],
    ['to-wav', buildAudioToWav({ inputName: 'i.mp3', outputName: 'o.wav', sampleRate: '44100' })],
    ['to-flac', buildAudioToFlac({ inputName: 'i.mp3', outputName: 'o.flac' })],
    ['to-ogg', buildAudioToOgg({ inputName: 'i.mp3', outputName: 'o.ogg', codec: 'libopus' })],
    ['to-m4a', buildAudioToM4a({ inputName: 'i.wav', outputName: 'o.m4a' })],
    ['to-aiff', buildAudioToAiff({ inputName: 'i.mp3', outputName: 'o.aiff', sampleRate: '48000' })],
    ['remux-audio', buildAudioRemux({ inputName: 'i.ogg', outputName: 'o.webm' })],
    ['remux-mp4', buildVideoRemuxMp4({ inputName: 'i.mkv', outputName: 'o.mp4' })],
    ['remux-mkv', buildVideoRemuxMkv({ inputName: 'i.mp4', outputName: 'o.mkv' })],
    ['reencode-mp4', buildVideoReencodeMp4({ inputName: 'i.mkv', outputName: 'o.mp4', crf: 23, preset: 'slow' })],
    ['to-webm', buildVideoToWebm({ inputName: 'i.mp4', outputName: 'o.webm', crf: 32 })],
    ['extract-audio', buildVideoExtractAudio({ inputName: 'i.mp4', outputName: 'o.mp3', audioMap: '0:a:0', codecArgs: ['-c:a', 'copy'] })],
    ['extract-subtitle', buildExtractSubtitle({ inputName: 'i.mkv', outputName: 'o.srt', subtitleMap: '0:s:0' })],
    ['gif-palette', buildGifPaletteArgs({ inputName: 'i.mp4', paletteName: 'p.png', fps: 10, width: 480 })],
    ['gif-render', buildGifRenderArgs({ inputName: 'i.mp4', paletteName: 'p.png', outputName: 'o.gif', fps: 10, width: 480 })],
    ['webp-anim', buildVideoToWebpAnim({ inputName: 'i.mp4', outputName: 'o.webp', fps: 10, width: 480, quality: 80 })],
    ['to-frames', buildVideoToFrames({ inputName: 'i.mp4', outputPattern: 'f-%04d.jpg', fps: 1, format: 'jpg', maxFrames: 150 })],
    ['frames-to-video', buildFramesToVideo({ inputPattern: 'in%03d.jpg', outputName: 'o.mp4', fps: 24 })],
  ];

  it.each(ALL)('%s：公共头 + 覆盖写出 + 无脏插值', (_name, args) => {
    expect(args.slice(0, 2)).toEqual(HEAD);
    expect(args[args.length - 2]).toBe('-y');
    for (const tok of args) {
      expect(typeof tok).toBe('string');
      expect(tok.length).toBeGreaterThan(0);
      expect(tok).not.toContain('undefined');
      expect(tok).not.toContain('NaN');
    }
  });
});
