// ─────────────────────────────────────────────────────────────────────────────
// datetime.ts —— 开发者工具「时间戳转换」的纯逻辑
//
// 【零依赖、零 React】要被 node 单测直接 import（也顺便说明它不碰客户端 API），
// 所以这里不 import 任何组件 / Next / prisma。唯一的 import 是 db-time 的
// `SITE_TZ_OFFSET_MS`（那个文件本身零依赖，见其文件头）。
//
// 【本站时区口径】本站把「站点时间」定义成 UTC+8 墙上时间（`SITE_TZ_OFFSET_MS`）。
// 工具页里所有「站点时间」的展示都按这个偏移算，与 db-time.ts 的库内时钟同口径。
//
// 【本文件的时间纪律】（`tests/unit/db-time-guard.test.ts` 静态强制）
//   · 不取「现在」——所有需要当前时刻的函数都把 nowMs 作为参数收下；
//   · 不用 toLocale*、不用本地 getter（getHours 等）；
//   · 「按某个时区展示」一律走 Intl.DateTimeFormat + formatToParts，
//     「按 UTC+8 展示」走「加偏移后 getUTC*」，两者都不依赖运行机器的时区。
//
// 【为什么不用 `new Date()` 读当前时刻】本工具处理的是真实 Unix 时间戳（与
// `Date.now()` 同一把尺子），在这个文件里 `new Date(ms)` 只作为「构造」使用，
// 不参与取「现在」——取「现在」发生在调用方（客户端组件），并通过 nowMs 传进来，
// 这样单测能冻住时间。
// ─────────────────────────────────────────────────────────────────────────────

import { SITE_TZ_OFFSET_MS } from '../db-time';

export { SITE_TZ_OFFSET_MS };

/** 站点时区名（Intl 用的 IANA 名）。 */
export const SITE_TZ_NAME = 'Asia/Shanghai';

/** 输入时间戳时按「整数位数」判定的单位。 */
export type TimestampUnit = 'seconds' | 'milliseconds' | 'microseconds' | 'nanoseconds';

/** 输入是时间戳还是日期字符串。 */
export type TimestampInputKind = TimestampUnit | 'date-string';

export interface TimestampParsed {
  ok: true;
  /** 解析出的真实 Unix 毫秒（与 Date.now() 同一把尺子）。 */
  epochMs: number;
  /** 判定出的单位 / 输入形态。 */
  inputKind: TimestampInputKind;
  /** 给用户看的一句「它是怎么被理解的」。 */
  note: string;
  /** 相对当前时刻的中文描述（如「3 天前」）。 */
  relative: string;
}

export interface TimestampParseError {
  ok: false;
  error: string;
}

export type TimestampParseResult = TimestampParsed | TimestampParseError;

/** 按某个时区展示的时间（`YYYY-MM-DD HH:mm:ss` + 该时区当时的偏移标签）。 */
export interface ZonedTimeText {
  time: string;
  offset: string;
}

export interface TimeZoneRow extends ZonedTimeText {
  zone: string;
  label: string;
}

/** 常用时区表（工具的「常用时区」表格；顺序即展示顺序）。 */
export const COMMON_TIME_ZONES: ReadonlyArray<{ zone: string; label: string }> = [
  { zone: 'UTC', label: '协调世界时（UTC）' },
  { zone: SITE_TZ_NAME, label: '北京时间（UTC+8，本站口径）' },
  { zone: 'Asia/Tokyo', label: '东京（UTC+9）' },
  { zone: 'Europe/London', label: '伦敦（UTC+0 / 夏令时 UTC+1）' },
  { zone: 'America/New_York', label: '纽约（UTC-5 / 夏令时 UTC-4）' },
];

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function pad3(n: number): string {
  return n < 10 ? `00${n}` : n < 100 ? `0${n}` : String(n);
}

/** JS Date 能表示的毫秒上下界（±100,000,000 天）。 */
const MAX_DATE_MS = 8.64e15;

/**
 * 按「整数位数」判定时间戳单位。
 *
 * 10 位及以内按秒（到 2286 年）、11–13 位按毫秒、14–16 位按微秒、
 * 17–19 位按纳秒 —— 这是 Unix 时间戳在现实中最常见的长度分布。
 * 超过 19 位直接报错：再乘下去就超出 Number 安全整数范围，猜也猜不准。
 */
function unitOfDigits(digits: number): TimestampUnit | null {
  if (digits <= 10) return 'seconds';
  if (digits <= 13) return 'milliseconds';
  if (digits <= 16) return 'microseconds';
  if (digits <= 19) return 'nanoseconds';
  return null;
}

const NUMERIC_RE = /^([+-]?)(\d+)(?:\.(\d+))?$/;

/** 时间戳（数字）→ 毫秒。字符串切片保证微秒 / 纳秒也不丢精度。 */
function numericToMs(
  sign: string,
  intDigits: string,
  fraction: string,
  unit: TimestampUnit
): number | null {
  const negative = sign === '-';
  // 去掉前导零后再判位数（`001700000000` 与 `1700000000` 是同一个秒级时间戳）。
  const digits = intDigits.replace(/^0+(?=\d)/, '');
  let ms: number;
  if (unit === 'seconds') {
    const whole = Number(digits);
    const fracMs = fraction ? Math.min(999, Math.floor(Number(`0.${fraction}`) * 1000)) : 0;
    ms = whole * 1000 + fracMs;
  } else {
    const drop = unit === 'milliseconds' ? 0 : unit === 'microseconds' ? 3 : 6;
    const kept = drop === 0 ? digits : digits.length > drop ? digits.slice(0, -drop) : '0';
    ms = Number(kept);
  }
  if (!Number.isFinite(ms)) return null;
  return negative ? -Math.trunc(ms) : Math.trunc(ms);
}

const DATE_RE =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?)?\s*(Z|[+-]\d{2}:?\d{2})?$/i;

interface DateStringParsed {
  ok: true;
  epochMs: number;
  note: string;
}

/** 无时区的日期字符串按站点时区（UTC+8）解释 —— 页面提示里明确写了这条。 */
function dateStringToMs(input: string): DateStringParsed | TimestampParseError {
  const m = DATE_RE.exec(input);
  if (!m) {
    return {
      ok: false,
      error: '无法识别：既不是整数时间戳，也不是 ISO 8601 / YYYY-MM-DD HH:mm:ss 形式的日期。',
    };
  }

  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const hour = m[4] === undefined ? 0 : Number(m[4]);
  const minute = m[5] === undefined ? 0 : Number(m[5]);
  const second = m[6] === undefined ? 0 : Number(m[6]);
  const fraction = m[7] ?? '';
  const zone = m[8] ?? '';

  if (year < 1000) return { ok: false, error: '年份需在 1000–9999 之间。' };
  if (month < 1 || month > 12) return { ok: false, error: `月份 ${m[2]} 超出 01–12。` };
  if (day < 1 || day > 31) return { ok: false, error: `日期 ${m[3]} 超出 01–31。` };
  if (hour > 23) return { ok: false, error: `小时 ${m[4]} 超出 00–23。` };
  if (minute > 59) return { ok: false, error: `分钟 ${m[5]} 超出 00–59。` };
  if (second > 59) return { ok: false, error: `秒 ${m[6]} 超出 00–59。` };

  const millis = fraction ? Math.min(999, Math.floor(Number(`0.${fraction}`) * 1000)) : 0;
  const wallMs = Date.UTC(year, month - 1, day, hour, minute, second, millis);

  // 回读校验：2 月 30 日、13 月这类会被 Date 静默滚到下个月，必须显式拒绝。
  const check = new Date(wallMs);
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day ||
    check.getUTCHours() !== hour ||
    check.getUTCMinutes() !== minute ||
    check.getUTCSeconds() !== second
  ) {
    return { ok: false, error: '这个日期不存在（例如 2 月 30 日）。' };
  }

  let offsetMs = SITE_TZ_OFFSET_MS;
  if (zone !== '') {
    if (zone.toUpperCase() === 'Z') {
      offsetMs = 0;
    } else {
      const zm = /^([+-])(\d{2}):?(\d{2})$/.exec(zone);
      if (!zm) return { ok: false, error: `时区偏移无法识别：${zone}。` };
      const oh = Number(zm[2]);
      const om = Number(zm[3]);
      if (oh > 23 || om > 59) return { ok: false, error: `时区偏移超出范围：${zone}。` };
      offsetMs = (zm[1] === '-' ? -1 : 1) * (oh * 3600 + om * 60) * 1000;
    }
  }

  const epochMs = wallMs - offsetMs;
  if (!Number.isFinite(epochMs) || Math.abs(epochMs) > MAX_DATE_MS) {
    return { ok: false, error: '换算结果超出 JavaScript 可表示的日期范围。' };
  }

  const zoneNote = zone === '' ? '未写时区，按站点时区 UTC+8 解释' : `时区 ${zone}`;
  return {
    ok: true,
    epochMs,
    note: `按日期字符串解析（${zoneNote}）`,
  };
}

/**
 * 解析用户输入：Unix 秒 / 毫秒 / 微秒 / 纳秒，或常见日期字符串。
 *
 * 【「现在」从参数来】相对时间必须基于调用方给的 nowMs —— 单测能冻住它，
 * 也保证同一个页面上多个展示用的是同一个基准。
 */
export function parseTimestamp(input: string, nowMs: number): TimestampParseResult {
  const text = input.trim();
  if (text === '') return { ok: false, error: '请输入时间戳或日期字符串。' };

  const numeric = NUMERIC_RE.exec(text);
  if (numeric) {
    const sign = numeric[1];
    const rawInt = numeric[2];
    const fraction = numeric[3] ?? '';
    const digits = rawInt.replace(/^0+(?=\d)/, '').length;
    const unit = unitOfDigits(digits);
    if (!unit) {
      return { ok: false, error: '时间戳位数过多（超过 19 位），无法判断单位。' };
    }
    const epochMs = numericToMs(sign, rawInt, fraction, unit);
    if (epochMs === null || !Number.isFinite(epochMs)) {
      return { ok: false, error: '时间戳数值无效。' };
    }
    if (Math.abs(epochMs) > MAX_DATE_MS) {
      return { ok: false, error: '换算结果超出 JavaScript 可表示的日期范围。' };
    }
    return {
      ok: true,
      epochMs,
      inputKind: unit,
      note: `按 ${digits} 位数字判为${unitLabel(unit)}${fraction ? '（小数部分取到毫秒）' : ''}`,
      relative: relativeTime(epochMs, nowMs),
    };
  }

  const parsed = dateStringToMs(text);
  if (!parsed.ok) return parsed;
  return {
    ok: true,
    epochMs: parsed.epochMs,
    inputKind: 'date-string',
    note: parsed.note,
    relative: relativeTime(parsed.epochMs, nowMs),
  };
}

const UNIT_LABELS: Record<TimestampUnit, string> = {
  seconds: ' Unix 秒',
  milliseconds: ' Unix 毫秒',
  microseconds: ' Unix 微秒（截断到毫秒）',
  nanoseconds: ' Unix 纳秒（截断到毫秒）',
};

function unitLabel(unit: TimestampUnit): string {
  return UNIT_LABELS[unit];
}

/** 毫秒 → Unix 秒（向下取整，负值亦取更小的整数）。 */
export function toUnixSeconds(epochMs: number): number {
  return Math.floor(epochMs / 1000);
}

/** 毫秒 → 整数毫秒（截断小数）。 */
export function toUnixMillis(epochMs: number): number {
  return Math.trunc(epochMs);
}

/** ISO 8601（UTC，带 Z）。 */
export function formatIsoUtc(epochMs: number): string {
  return new Date(epochMs).toISOString();
}

/** 站点时间（UTC+8 墙上时间，`YYYY-MM-DD HH:mm:ss`）。 */
export function formatSiteTime(epochMs: number): string {
  const d = new Date(epochMs + SITE_TZ_OFFSET_MS);
  return (
    `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ` +
    `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`
  );
}

/** 站点时间带毫秒（`YYYY-MM-DD HH:mm:ss.SSS`）。 */
export function formatSiteTimeMs(epochMs: number): string {
  const d = new Date(epochMs + SITE_TZ_OFFSET_MS);
  return `${formatSiteTime(epochMs)}.${pad3(d.getUTCMilliseconds())}`;
}

/** UTC+8 的星期几（`周一` 这类）。 */
export function weekdayUtc8(epochMs: number): string {
  return weekdayInTimeZone(epochMs, SITE_TZ_NAME);
}

/** 指定时区的星期几（`周一` 这类）。 */
export function weekdayInTimeZone(epochMs: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone,
    weekday: 'short',
  }).formatToParts(new Date(epochMs));
  return parts.find((p) => p.type === 'weekday')?.value ?? '';
}

function zonedFormatter(timeZone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
}

/**
 * 按 IANA 时区展示时间 —— 一律 `Intl.DateTimeFormat` + `formatToParts`，
 * 不用 toLocale*，也不依赖运行机器时区。
 *
 * 非法时区名会让构造函数抛 RangeError，调用方要自己兜（页面里只传常量白名单）。
 */
export function formatInTimeZone(epochMs: number, timeZone: string): string {
  const parts = zonedFormatter(timeZone).formatToParts(new Date(epochMs));
  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? '';
  const year = get('year');
  const month = get('month');
  const day = get('day');
  const hour = get('hour');
  const minute = get('minute');
  const second = get('second');
  return `${year}-${month}-${day} ${hour}:${minute}:${second}`;
}

/** 某时区在该时刻相对 UTC 的偏移标签（如 `GMT+8`）。 */
export function timeZoneOffsetLabel(epochMs: number, timeZone: string): string {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZoneName: 'shortOffset',
  });
  const parts = dtf.formatToParts(new Date(epochMs));
  return parts.find((p) => p.type === 'timeZoneName')?.value ?? '';
}

/** 同时给出时间文本与偏移标签。 */
export function describeInTimeZone(epochMs: number, timeZone: string): ZonedTimeText {
  return {
    time: formatInTimeZone(epochMs, timeZone),
    offset: timeZoneOffsetLabel(epochMs, timeZone),
  };
}

/** 读者本地时区的 IANA 名（浏览器/运行时）。 */
export function localTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** 常用时区表：把同一个瞬间按五个时区展开。 */
export function timeZoneTable(epochMs: number): TimeZoneRow[] {
  return COMMON_TIME_ZONES.map(({ zone, label }) => ({
    zone,
    label,
    ...describeInTimeZone(epochMs, zone),
  }));
}

/** 这个瞬间的完整展示（页面结果区的一整组行）。 */
export interface TimestampDisplay {
  unixSeconds: string;
  unixMillis: string;
  isoUtc: string;
  siteTime: string;
  siteTimeMs: string;
  localTime: string;
  localZone: string;
  relative: string;
}

export function describeTimestamp(epochMs: number, nowMs: number): TimestampDisplay {
  const zone = localTimeZone();
  return {
    unixSeconds: String(toUnixSeconds(epochMs)),
    unixMillis: String(toUnixMillis(epochMs)),
    isoUtc: formatIsoUtc(epochMs),
    siteTime: formatSiteTime(epochMs),
    siteTimeMs: formatSiteTimeMs(epochMs),
    localTime: formatInTimeZone(epochMs, zone),
    localZone: zone,
    relative: relativeTime(epochMs, nowMs),
  };
}

/**
 * 相对当前时刻的中文描述：`3 天前` / `5 分钟后` / `刚刚`。
 *
 * 月 / 年用近似值（30.44 天 / 365.25 天）—— 这个数字只用来说「大概多久」，
 * 不参与任何计算，所以近似是刻意的。
 */
export function relativeTime(epochMs: number, nowMs: number): string {
  const diff = epochMs - nowMs;
  const abs = Math.abs(diff);
  if (abs < 1000) return '刚刚';
  const future = diff > 0;
  const suffix = future ? '后' : '前';
  const sec = Math.floor(abs / 1000);
  if (sec < 60) return `${sec} 秒${suffix}`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} 分钟${suffix}`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour} 小时${suffix}`;
  const day = Math.floor(hour / 24);
  if (day < 30) return `${day} 天${suffix}`;
  const month = Math.floor(day / 30.44);
  if (month < 12) return `${month} 个月${suffix}`;
  const year = Math.floor(day / 365.25);
  return `${year} 年${suffix}`;
}

/**
 * 一段时长（毫秒）拆成中文：`1 天 2 小时` / `3 分钟` / `20 秒`。
 *
 * 负数取绝对值 —— 调用方自己决定「已过期」这类前缀，这里只负责量。
 */
export function formatDuration(ms: number): string {
  const abs = Math.abs(Math.trunc(ms));
  if (abs < 1000) return '0 秒';
  const totalSec = Math.floor(abs / 1000);
  const day = Math.floor(totalSec / 86400);
  const hour = Math.floor((totalSec % 86400) / 3600);
  const minute = Math.floor((totalSec % 3600) / 60);
  const second = totalSec % 60;
  if (day > 0) return `${day} 天 ${hour} 小时`;
  if (hour > 0) return `${hour} 小时 ${minute} 分钟`;
  if (minute > 0) return `${minute} 分钟`;
  return `${second} 秒`;
}
