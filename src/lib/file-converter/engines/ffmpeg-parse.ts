// ─────────────────────────────────────────────────────────────────────────────
// file-converter/engines/ffmpeg-parse.ts —— ffmpeg 文本输出（-encoders /
// -decoders / -i）的**零依赖**解析器。
//
// 【它是什么】ffmpeg.wasm 没有结构化查询接口：能力清单与媒体信息只能从 CLI
//   打印的文本里解析。本模块把三类文本解析成结构化数据，供 ffmpeg.ts 填
//   能力登记表（encoders / decoders）与 probe 结果（轨道 / 时长 / 容器名）。
//
// 【纪律】
//   · 零运行时依赖、零引擎调用 —— node 单测直接驱动
//     （tests/unit/file-converter-ffmpeg-parse.test.ts，样本内嵌在测试里）。
//   · 解析必须**宽容**：ffmpeg 各版本行格式有变体（`#0:1`、`#0:1[0x2]`、
//     `#0:1(eng)`、`#0:1[0x2](chi)`），字段缺失一律给 null / 缺省，**绝不抛**。
//     输出文本是上游数据，不是契约。
// ─────────────────────────────────────────────────────────────────────────────

/** 一条媒体轨（与 types.ts 的 StreamInfo 同构；本模块零依赖所以自带定义）。 */
export interface ParsedProbeStream {
  index: number;
  type: 'video' | 'audio' | 'subtitle' | 'other';
  codec: string;
  channels?: number;
  sampleRate?: number;
  width?: number;
  height?: number;
  language?: string;
}

export interface ParsedProbeResult {
  /** 秒；ffmpeg 报 N/A 或行缺失时为 null。 */
  durationSec: number | null;
  streams: ParsedProbeStream[];
  /** demuxer 名单，如 'mov,mp4,m4a,3gp,3g2,mj2'；认不出容器时为空串。 */
  formatName: string;
}

function splitLines(text: string): string[] {
  return text.split(/\r\n|\r|\n/);
}

// ─── -encoders / -decoders ─────────────────────────────────────────────────────
//
// 行形（-hide_banner 之后）：
//   Encoders:
//    V..... = Video              ← 图例行：flags 后紧跟 '='，被名字字符类挡掉
//    ------
//    V....D libx264              libx264 H.264 ... (codec h264)
//    A....D libmp3lame           libmp3lame MP3 (MPEG audio layer 3) (codec mp3)
// flags 恰 6 个字符、首字符是流类型（V/A/S；'.' 兜底），其后才是编码器名。
// banner / 缩进两格以上的杂项行都不会匹配「一个空格 + 6 非空格字符」这个形状。

const CODEC_LINE = /^ ([VAS.]\S{5}) +([A-Za-z0-9_][\w.+-]*)(?:\s|$)/;

function parseCodecList(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const line of splitLines(text)) {
    const m = CODEC_LINE.exec(line);
    if (!m) continue;
    const name = m[2];
    if (seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

/** 解析 `ffmpeg -encoders` 的输出，返回编码器名清单（保持输出顺序）。 */
export function parseEncoders(text: string): string[] {
  return parseCodecList(text);
}

/** 解析 `ffmpeg -decoders` 的输出，返回解码器名清单（保持输出顺序）。 */
export function parseDecoders(text: string): string[] {
  return parseCodecList(text);
}

// ─── -i（探测）─────────────────────────────────────────────────────────────────
//
// 行形：
//   Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'in.mp4':
//     Duration: 00:01:23.45, start: 0.000000, bitrate: 1200 kb/s
//     Stream #0:0[0x1](und): Video: h264 (High) (avc1 / 0x31637661), yuv420p, 1920x1080, 25 fps (default)
//       Metadata:
//         language        : chi
// 语言有两处来源：流号后的括号（`(chi)`；`und` = 未定，当作没有），以及该流
// Metadata 块里的 `language : xxx` 行（缩进更深）。括号在前先填，元数据行只
// 补空缺 / 覆盖 und —— 两侧都以 ffmpeg 实际打印为准，拿不到就不填。

const INPUT_LINE = /Input #\d+,\s*(.+?),\s*from\s*'/;
const DURATION_LINE = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/;
const STREAM_LINE = /^\s*Stream #(\d+)[:.](\d+)((?:\[[^\]]*\]|\([^)]*\))*)\s*:\s*(\w+)\s*:\s*(.*)$/;
const LANGUAGE_META = /^\s+language\s*:\s*(\S+)\s*$/;
const DIMS = /\b(\d{2,5})x(\d{2,5})\b/;
const SAMPLE_RATE = /(\d+)\s*Hz/;
const PAREN_GROUP = /\(([^()]*)\)/g;

/** 声道布局词 → 声道数。`5.1(side)` 这类带后缀的先剥括号再查表。 */
const CHANNEL_LAYOUTS: Record<string, number> = {
  mono: 1,
  stereo: 2,
  '2.1': 3,
  '3.0': 3,
  '4.0': 4,
  '5.0': 5,
  '5.1': 6,
  '6.0': 6,
  '6.1': 7,
  '7.0': 7,
  '7.1': 8,
};

function normalizeLang(v: string | undefined): string | undefined {
  if (!v) return undefined;
  const t = v.trim();
  // und = undetermined，ffmpeg 对无语言轨道一律打这个，当作「没有」
  return t && t !== 'und' ? t : undefined;
}

/** 流号后缀（`[0x1](chi)` / `(eng)` / `[0x100]`）里取最后一组括号内容作语言。 */
function langFromSuffix(suffix: string): string | undefined {
  let lang: string | undefined;
  PAREN_GROUP.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PAREN_GROUP.exec(suffix)) !== null) {
    const v = m[1].trim();
    if (v) lang = v;
  }
  return normalizeLang(lang);
}

/**
 * 从音频流描述段（`aac (LC), 44100 Hz, stereo, fltp, 128 kb/s`）猜声道数。
 * 认得的布局词直接查表；`2 channels` 形态取数字；都不认得就不填。
 */
function parseChannels(rest: string): number | undefined {
  for (const token of rest.split(',')) {
    const t = token.trim().replace(/\([^)]*\)/g, '').trim().toLowerCase();
    if (!t) continue;
    if (Object.prototype.hasOwnProperty.call(CHANNEL_LAYOUTS, t)) return CHANNEL_LAYOUTS[t];
    const m = /^(\d{1,2})\s+channels?$/.exec(t);
    if (m) return parseInt(m[1], 10);
  }
  return undefined;
}

function mapStreamType(word: string): ParsedProbeStream['type'] {
  switch (word.toLowerCase()) {
    case 'video':
      return 'video';
    case 'audio':
      return 'audio';
    case 'subtitle':
      return 'subtitle';
    default:
      return 'other'; // Data / Attachment / Unknown 等
  }
}

/**
 * 解析 `ffmpeg -i <input>` 的 stderr。**宽容**：行格式变体、字段缺失不抛，
 * 给 null / 缺省。完全认不出容器时 formatName 为空串、streams 为空
 * （调用方据此判「损坏 / 不支持」）。
 */
export function parseProbe(stderr: string): ParsedProbeResult {
  let formatName = '';
  let durationSec: number | null = null;
  const streams: ParsedProbeStream[] = [];
  let lastStream: ParsedProbeStream | null = null;

  for (const line of splitLines(stderr)) {
    if (!formatName) {
      const im = INPUT_LINE.exec(line);
      if (im) formatName = im[1].trim();
    }
    if (durationSec === null) {
      const dm = DURATION_LINE.exec(line);
      if (dm) {
        durationSec = parseInt(dm[1], 10) * 3600 + parseInt(dm[2], 10) * 60 + parseFloat(dm[3]);
      }
    }

    const sm = STREAM_LINE.exec(line);
    if (sm) {
      const suffix = sm[3] ?? '';
      const type = mapStreamType(sm[4]);
      const rest = sm[5] ?? '';
      const codecM = /^([A-Za-z0-9_]+)/.exec(rest.trim());
      const stream: ParsedProbeStream = {
        index: parseInt(sm[2], 10),
        type,
        codec: codecM ? codecM[1].toLowerCase() : '',
      };
      const lang = langFromSuffix(suffix);
      if (lang) stream.language = lang;
      if (type === 'video') {
        // 首个 NxM 是分辨率。codec tag 的十六进制（0x31637661）与 SAR/DAR（1:1）
        // 都构不成 `\d{2,5}x\d{2,5}`：x 前是一位数或边界不匹配。
        const dim = DIMS.exec(rest);
        if (dim) {
          stream.width = parseInt(dim[1], 10);
          stream.height = parseInt(dim[2], 10);
        }
      } else if (type === 'audio') {
        const hz = SAMPLE_RATE.exec(rest);
        if (hz) stream.sampleRate = parseInt(hz[1], 10);
        const ch = parseChannels(rest);
        if (ch !== undefined) stream.channels = ch;
      }
      streams.push(stream);
      lastStream = stream;
      continue;
    }

    // 流级 Metadata 里的 language 行：补括号为 und / 缺失的情况。
    // 容器级 Metadata 出现在任何 Stream 行之前（lastStream 为 null），不会误填。
    if (lastStream) {
      const lm = LANGUAGE_META.exec(line);
      if (lm) {
        const lang = normalizeLang(lm[1]);
        if (lang && !lastStream.language) lastStream.language = lang;
      }
    }
  }

  return { durationSec, streams, formatName };
}
