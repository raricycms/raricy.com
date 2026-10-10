// ─────────────────────────────────────────────────────────────────────────────
// file-converter-subtitle.test.ts —— SRT / WebVTT / ASS 解析与序列化（node 环境）。
//
// 【为什么逐个钉】时间戳换算错一位、ASS 覆盖块没剥干净，都是「页面上看着像字幕、
// 实际时间或文本已经错了」的静默错误。这里把三种格式 → 统一 cue → 各格式写回
// 的每一处时间戳、换行与标签处理都钉死。
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from 'vitest';
import {
  formatAssTime,
  formatSrtTime,
  formatVttTime,
  parseAssTimestamp,
  parseSubtitle,
  parseTimestamp,
  serializeAss,
  serializeSrt,
  serializeSubtitle,
  serializeVtt,
  type Cue,
} from '@/lib/file-converter/engines/subtitle';

// ─── 时间戳换算 ──────────────────────────────────────────────────────────────

describe('时间戳解析 / 格式化', () => {
  it('SRT / VTT 时间戳（都接受逗号或点）', () => {
    expect(parseTimestamp('00:00:01,000')).toBe(1000);
    expect(parseTimestamp('00:00:01.500')).toBe(1500);
    expect(parseTimestamp('01:02:03,004')).toBe(3_723_004);
    expect(parseTimestamp('12:00:00.000')).toBe(43_200_000);
    expect(parseTimestamp('bad')).toBeNull();
    expect(parseTimestamp('00:60:00,000')).toBeNull();
  });

  it('ASS 时间戳是厘秒', () => {
    expect(parseAssTimestamp('0:00:01.00')).toBe(1000);
    expect(parseAssTimestamp('0:00:03.90')).toBe(3900);
    expect(parseAssTimestamp('1:02:03.05')).toBe(3_723_050);
    expect(parseAssTimestamp('0:00:01')).toBeNull();
  });

  it('格式化回来逐个钉', () => {
    expect(formatSrtTime(1000)).toBe('00:00:01,000');
    expect(formatSrtTime(3_661_001)).toBe('01:01:01,001');
    expect(formatVttTime(1500)).toBe('00:00:01.500');
    expect(formatVttTime(43_200_000)).toBe('12:00:00.000');
    expect(formatAssTime(1000)).toBe('0:00:01.00');
    expect(formatAssTime(3900)).toBe('0:00:03.90');
    expect(formatAssTime(3_723_050)).toBe('1:02:03.05');
  });
});

// ─── SRT ─────────────────────────────────────────────────────────────────────

const SRT = [
  '1',
  '00:00:01,000 --> 00:00:02,500',
  'Hello',
  'world',
  '',
  '2',
  '00:00:03,000 --> 00:00:04,000',
  'Second cue',
  '',
].join('\n');

describe('SRT 解析 / 序列化', () => {
  it('解析出统一 cue（多行正文保留换行）', () => {
    const r = parseSubtitle(SRT, 'srt');
    expect(r.skipped).toBe(0);
    expect(r.inverted).toBe(0);
    expect(r.cues).toEqual([
      { startMs: 1000, endMs: 2500, text: 'Hello\nworld' },
      { startMs: 3000, endMs: 4000, text: 'Second cue' },
    ]);
  });

  it('序列化回 SRT 与原文逐字节一致', () => {
    const r = parseSubtitle(SRT, 'srt');
    expect(serializeSrt(r.cues)).toBe(SRT);
  });
});

// ─── WebVTT ──────────────────────────────────────────────────────────────────

const VTT = [
  'WEBVTT',
  '',
  '00:00:01.000 --> 00:00:02.500',
  'Hello',
  '',
  '2',
  '00:01:03.000 --> 00:01:04.000 align:start position:10%',
  'Second',
  '',
].join('\n');

describe('WebVTT 解析 / 序列化', () => {
  it('剥掉 WEBVTT 头、忽略 cue 设置行、MM:SS 也能解析', () => {
    const r = parseSubtitle(VTT, 'vtt');
    expect(r.skipped).toBe(0);
    expect(r.cues).toEqual([
      { startMs: 1000, endMs: 2500, text: 'Hello' },
      { startMs: 63_000, endMs: 64_000, text: 'Second' },
    ]);
  });

  it('序列化带 WEBVTT 头与数字编号', () => {
    const r = parseSubtitle(VTT, 'vtt');
    expect(serializeVtt(r.cues)).toBe(
      ['WEBVTT', '', '1', '00:00:01.000 --> 00:00:02.500', 'Hello', '', '2', '00:01:03.000 --> 00:01:04.000', 'Second', ''].join('\n')
    );
  });

  it('NOTE / STYLE 块静默跳过，不计入 skipped', () => {
    const withNote = ['WEBVTT', '', 'NOTE this is a comment', 'ignored line', '', '00:00:01.000 --> 00:00:02.000', 'Hi', ''].join('\n');
    const r = parseSubtitle(withNote, 'vtt');
    expect(r.skipped).toBe(0);
    expect(r.cues).toEqual([{ startMs: 1000, endMs: 2000, text: 'Hi' }]);
  });
});

// ─── ASS ─────────────────────────────────────────────────────────────────────

const ASS = [
  '[Script Info]',
  'ScriptType: v4.00+',
  '',
  '[V4+ Styles]',
  'Format: Name, Fontname, Fontsize',
  'Style: Default,Arial,20',
  '',
  '[Events]',
  'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  'Dialogue: 0,0:00:01.00,0:00:02.50,Default,,0,0,0,,{\\pos(10,10)}Hello\\Nworld',
  'Dialogue: 0,0:00:03.00,0:00:03.90,Default,,0,0,0,,{\\i1}Plain{\\i0}',
  'Comment: 0,0:00:05.00,0:00:06.00,Default,,0,0,0,,此注释不参与',
  '',
].join('\n');

describe('ASS 解析 / 序列化', () => {
  it('剥覆盖块、\\N 转换行、Comment 行忽略', () => {
    const r = parseSubtitle(ASS, 'ass');
    expect(r.skipped).toBe(0);
    expect(r.cues).toEqual([
      { startMs: 1000, endMs: 2500, text: 'Hello\nworld' },
      { startMs: 3000, endMs: 3900, text: 'Plain' },
    ]);
  });

  it('序列化生成最小合法头 + Default 样式 + 厘秒时间', () => {
    const cues: Cue[] = [{ startMs: 1000, endMs: 2500, text: 'Hello\nworld' }];
    const out = serializeAss(cues);
    expect(out).toContain('[Script Info]');
    expect(out).toContain('[V4+ Styles]');
    expect(out).toContain('Style: Default');
    expect(out).toContain('[Events]');
    expect(out).toContain('Dialogue: 0,0:00:01.00,0:00:02.50,Default,,0,0,0,,Hello\\Nworld');
  });

  it('ASS → SRT：时间与文本映射正确（特效丢失）', () => {
    const r = parseSubtitle(ASS, 'ass');
    expect(serializeSubtitle(r.cues, 'srt')).toBe(
      ['1', '00:00:01,000 --> 00:00:02,500', 'Hello', 'world', '', '2', '00:00:03,000 --> 00:00:03,900', 'Plain', ''].join('\n')
    );
  });
});

// ─── 鲁棒性 ──────────────────────────────────────────────────────────────────

describe('鲁棒性：坏行跳过、时间倒置保留', () => {
  it('无时间码的块计入 skipped，好块照常解析', () => {
    const text = ['1', '00:00:01,000 --> 00:00:02,000', 'ok', '', 'garbage without timecode', '', '2', '00:00:03,000 --> 00:00:04,000', 'ok2', ''].join('\n');
    const r = parseSubtitle(text, 'srt');
    expect(r.skipped).toBe(1);
    expect(r.cues.length).toBe(2);
  });

  it('时间倒置（end < start）原样保留并计数', () => {
    const text = ['1', '00:00:05,000 --> 00:00:02,000', 'reverse', ''].join('\n');
    const r = parseSubtitle(text, 'srt');
    expect(r.inverted).toBe(1);
    expect(r.cues).toEqual([{ startMs: 5000, endMs: 2000, text: 'reverse' }]);
  });

  it('SRT → VTT → SRT 往返内容稳定', () => {
    const first = parseSubtitle(SRT, 'srt').cues;
    const vtt = serializeVtt(first);
    const second = parseSubtitle(vtt, 'vtt').cues;
    expect(second).toEqual(first);
    expect(serializeSrt(second)).toBe(SRT);
  });

  it('SRT 的内联标签原样保留', () => {
    const text = ['1', '00:00:01,000 --> 00:00:02,000', '<i>italic</i>', ''].join('\n');
    const r = parseSubtitle(text, 'srt');
    expect(r.cues[0].text).toBe('<i>italic</i>');
  });
});
