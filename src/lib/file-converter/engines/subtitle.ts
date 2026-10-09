// ─────────────────────────────────────────────────────────────────────────────
// file-converter/engines/subtitle.ts —— SRT / WebVTT / ASS 的解析与序列化（**零依赖**）
//
// 【它是什么】roadmap §9.2 的受限解析器 / writer。三种格式都先归一到统一 cue
//   （{ startMs, endMs, text }，text 内保留换行），再由目标 writer 写出。
//
// 【纪律】
//   · 零 import：服务端与客户端共用，node 单测直接驱动。
//   · 解析必须**鲁棒**：坏行跳过并计数（返回 skipped），不因为一行坏了整体失败；
//     时间倒置（end < start）**保留原样**但计入 inverted，由调用方出 notice。
//   · ASS：Dialogue 文本剥掉 {\...} 特效覆盖块；\N / \n 转真换行；\h 转空格。
//     反向（写 ASS）时只做最小合法头 + Default 样式，**不重建**任何特效 / 定位 /
//     字体 / 卡拉 OK 标签 —— 这是刻意取舍，调用方以 notice 如实说明。
//   · SRT / VTT 序列化时把 HTML 态标签（<i> 等）原样保留（两者都支持有限子集）；
//     ASS 来的 <i> 不重建为覆盖标签，仍按字面输出并在 notice 里说明。
//   · 时间戳：SRT 用 `,`，VTT 用 `.`，ASS 用厘秒 `.cc`。四舍五入到毫秒 / 厘秒。
// ─────────────────────────────────────────────────────────────────────────────

export interface Cue {
  startMs: number;
  endMs: number;
  /** 原文，内部换行保留为 '\n'。 */
  text: string;
}

export type SubtitleFormat = 'srt' | 'vtt' | 'ass';

export interface SubtitleParseResult {
  cues: Cue[];
  /** 无法解析而被跳过的行 / 块数。 */
  skipped: number;
  /** 时间倒置（end < start）的 cue 数（原样保留）。 */
  inverted: number;
}

// ─── 时间戳解析 ──────────────────────────────────────────────────────────────

const TS_RE = /^(?:(\d{1,3}):)?(\d{1,2}):(\d{2})[.,](\d{1,3})$/;

function fracToMs(frac: string): number {
  // '5' → 500, '00' → 0, '000' → 0, '123' → 123
  return parseInt(frac.padEnd(3, '0').slice(0, 3), 10);
}

/** SRT / VTT 时间戳（HH:MM:SS[.,]mmm 或 MM:SS[.,]mmm）。非法返回 null。 */
export function parseTimestamp(raw: string): number | null {
  const m = TS_RE.exec(raw.trim());
  if (!m) return null;
  const h = m[1] ? parseInt(m[1], 10) : 0;
  const mi = parseInt(m[2], 10);
  const s = parseInt(m[3], 10);
  if (mi > 59 || s > 59) return null;
  return ((h * 60 + mi) * 60 + s) * 1000 + fracToMs(m[4]);
}

/** ASS 时间戳 H:MM:SS.cc（厘秒）。非法返回 null。 */
export function parseAssTimestamp(raw: string): number | null {
  const m = /^(\d{1,3}):(\d{2}):(\d{2})[.](\d{1,2})$/.exec(raw.trim());
  if (!m) return null;
  const h = parseInt(m[1], 10);
  const mi = parseInt(m[2], 10);
  const s = parseInt(m[3], 10);
  const cc = parseInt(m[4].padEnd(2, '0').slice(0, 2), 10);
  if (mi > 59 || s > 59) return null;
  return ((h * 60 + mi) * 60 + s) * 1000 + cc * 10;
}

// ─── 时间戳序列化 ────────────────────────────────────────────────────────────

function pad(n: number, width: number): string {
  return String(n).padStart(width, '0');
}

function msToHms(ms: number): { h: number; m: number; s: number; ms: number } {
  const v = Math.max(0, Math.round(ms));
  return {
    h: Math.floor(v / 3_600_000),
    m: Math.floor((v % 3_600_000) / 60_000),
    s: Math.floor((v % 60_000) / 1000),
    ms: v % 1000,
  };
}

/** `HH:MM:SS,mmm`（SRT）。 */
export function formatSrtTime(ms: number): string {
  const t = msToHms(ms);
  return `${pad(t.h, 2)}:${pad(t.m, 2)}:${pad(t.s, 2)},${pad(t.ms, 3)}`;
}

/** `HH:MM:SS.mmm`（VTT）。 */
export function formatVttTime(ms: number): string {
  const t = msToHms(ms);
  return `${pad(t.h, 2)}:${pad(t.m, 2)}:${pad(t.s, 2)}.${pad(t.ms, 3)}`;
}

/** `H:MM:SS.cc`（ASS，厘秒）。 */
export function formatAssTime(ms: number): string {
  const totalCs = Math.max(0, Math.round(ms / 10));
  const h = Math.floor(totalCs / 360_000);
  const m = Math.floor((totalCs % 360_000) / 6000);
  const s = Math.floor((totalCs % 6000) / 100);
  const cs = totalCs % 100;
  return `${h}:${pad(m, 2)}:${pad(s, 2)}.${pad(cs, 2)}`;
}

// ─── 解析 ────────────────────────────────────────────────────────────────────

/** 去掉 WEBVTT 头（第一行到其后第一个空行）。 */
function stripVttHeader(body: string): string {
  const lines = body.split('\n');
  const i = lines.findIndex((l) => /^WEBVTT/.test(l.trim()));
  if (i < 0) return body;
  let j = i + 1;
  while (j < lines.length && lines[j].trim() !== '') j++;
  return lines.slice(j + 1).join('\n');
}

function parseTextCues(norm: string, format: 'srt' | 'vtt'): SubtitleParseResult {
  const body = format === 'vtt' ? stripVttHeader(norm) : norm;
  const blocks = body.split(/\n{2,}/);
  const cues: Cue[] = [];
  let skipped = 0;
  let inverted = 0;

  for (const block of blocks) {
    if (!block.trim()) continue;
    const lines = block.split('\n');
    // VTT 的 NOTE / STYLE / REGION 块不是 cue，静默跳过（不计入 skipped）。
    if (format === 'vtt' && /^(NOTE|STYLE|REGION)\b/.test(lines[0].trim())) continue;

    let timeIdx = -1;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes('-->')) {
        timeIdx = i;
        break;
      }
    }
    if (timeIdx < 0) {
      skipped++;
      continue;
    }
    const tl = lines[timeIdx];
    const arrow = tl.indexOf('-->');
    const left = tl.slice(0, arrow).trim();
    // 右半可能带 cue 设置（VTT 的 align:start position:10%），只取第一个空白段。
    const right = tl.slice(arrow + 3).trim().split(/\s+/)[0];
    const startMs = parseTimestamp(left);
    const endMs = parseTimestamp(right);
    if (startMs === null || endMs === null) {
      skipped++;
      continue;
    }
    if (endMs < startMs) inverted++;
    // 块的边界空行会落进正文末尾，去掉首尾空行（cue 内部换行保留）。
    const cueText = lines.slice(timeIdx + 1).join('\n').replace(/^\n+|\n+$/g, '');
    cues.push({ startMs, endMs, text: cueText });
  }
  return { cues, skipped, inverted };
}

const DEFAULT_ASS_COLS = ['layer', 'start', 'end', 'style', 'name', 'marginl', 'marginr', 'marginv', 'effect', 'text'];

/** 剥特效覆盖块 + 硬换行 / 硬空格还原。 */
function cleanAssText(raw: string): string {
  return raw
    .replace(/\{[^}]*\}/g, '') // {\pos(...)} {\i1} 等覆盖块
    .replace(/\\[Nn]/g, '\n') // 硬换行
    .replace(/\\h/g, ' ') // 硬空格
    .replace(/\r/g, '')
    .trim();
}

function parseAss(norm: string): SubtitleParseResult {
  const lines = norm.split('\n');
  const cues: Cue[] = [];
  let skipped = 0;
  let inverted = 0;
  let inEvents = false;
  let cols: string[] | null = null;

  for (const line of lines) {
    const t = line.trim();
    if (/^\[.*\]$/.test(t)) {
      inEvents = /^\[events\]$/i.test(t);
      if (inEvents) cols = null;
      continue;
    }
    if (!inEvents) continue;
    if (/^Format:/i.test(t)) {
      cols = t
        .slice(t.indexOf(':') + 1)
        .split(',')
        .map((s) => s.trim().toLowerCase());
      continue;
    }
    if (/^Comment:/i.test(t)) continue; // 注释行不算坏行
    if (!/^Dialogue:/i.test(t)) continue;

    const useCols = cols ?? DEFAULT_ASS_COLS;
    const body = line.slice(line.indexOf(':') + 1);
    const startIdx = useCols.indexOf('start');
    const endIdx = useCols.indexOf('end');
    const textIdx = useCols.indexOf('text');
    // ★ 注意：JS 的 `split(sep, limit)` 是**截断数组**（不像 Java 会把剩余塞进最后一格）。
    //   Text 是最后一列且本身含逗号（如 `{\pos(10,10)}`），必须先全量 split 再把
    //   Text 之后的各段重新用逗号拼回去，否则正文会在第一个逗号处被切断。
    const rawParts = body.split(',');
    const parts =
      textIdx === useCols.length - 1 && rawParts.length > useCols.length
        ? [...rawParts.slice(0, useCols.length - 1), rawParts.slice(useCols.length - 1).join(',')]
        : rawParts.slice(0, useCols.length);
    const needed = Math.max(startIdx, endIdx, textIdx);
    if (startIdx < 0 || endIdx < 0 || textIdx < 0 || parts.length <= needed) {
      skipped++;
      continue;
    }
    const startMs = parseAssTimestamp(parts[startIdx]);
    const endMs = parseAssTimestamp(parts[endIdx]);
    if (startMs === null || endMs === null) {
      skipped++;
      continue;
    }
    if (endMs < startMs) inverted++;
    cues.push({ startMs, endMs, text: cleanAssText(parts[textIdx]) });
  }
  return { cues, skipped, inverted };
}

/**
 * 解析字幕文本（先做 BOM 剥离与换行归一）。坏行跳过并计数，绝不抛。
 * 输入必须是已解码的文本（调用方负责字符编码，见 encoding.ts）。
 */
export function parseSubtitle(text: string, format: SubtitleFormat): SubtitleParseResult {
  const norm = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  return format === 'ass' ? parseAss(norm) : parseTextCues(norm, format);
}

// ─── 序列化 ──────────────────────────────────────────────────────────────────

export function serializeSrt(cues: Cue[]): string {
  const parts = cues.map((c, i) => `${i + 1}\n${formatSrtTime(c.startMs)} --> ${formatSrtTime(c.endMs)}\n${c.text}`);
  return parts.length ? parts.join('\n\n') + '\n' : '';
}

export function serializeVtt(cues: Cue[]): string {
  const parts = cues.map((c, i) => `${i + 1}\n${formatVttTime(c.startMs)} --> ${formatVttTime(c.endMs)}\n${c.text}`);
  return 'WEBVTT\n\n' + (parts.length ? parts.join('\n\n') + '\n' : '');
}

/** ASS 事件行里换行必须写成 `\N`（字面反斜杠 + N）。 */
function assEscapeText(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(/\n/g, '\\N');
}

const ASS_HEADER = [
  '[Script Info]',
  'ScriptType: v4.00+',
  'WrapStyle: 0',
  'ScaledBorderAndShadow: yes',
  'PlayResX: 640',
  'PlayResY: 360',
  '',
  '[V4+ Styles]',
  'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
  'Style: Default,Arial,20,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,2,2,10,10,10,1',
  '',
  '[Events]',
  'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
].join('\n');

export function serializeAss(cues: Cue[]): string {
  const events = cues.map(
    (c) =>
      `Dialogue: 0,${formatAssTime(c.startMs)},${formatAssTime(c.endMs)},Default,,0,0,0,,${assEscapeText(c.text)}`
  );
  return events.length ? `${ASS_HEADER}\n${events.join('\n')}\n` : `${ASS_HEADER}\n`;
}

export function serializeSubtitle(cues: Cue[], format: SubtitleFormat): string {
  switch (format) {
    case 'srt':
      return serializeSrt(cues);
    case 'vtt':
      return serializeVtt(cues);
    case 'ass':
      return serializeAss(cues);
  }
}
