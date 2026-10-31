// ─────────────────────────────────────────────────────────────────────────────
// cron.ts —— 开发者工具「Cron 表达式解析」的纯逻辑
//
// 【零依赖、零 React】与 datetime.ts 同一纪律：要被 node 单测直接 import。
//
// 【时区口径：一律按站点时区 UTC+8】cron 表达式本身不带时区，服务器 / 用户的时区
// 不同就会算出不同的执行时刻。本工具把口径钉死成站点时区，做法与 db-time.ts 同源：
//
//   「UTC+8 墙上时间」= 真实 UTC 毫秒 + 8 小时，然后用 getUTC* 读出来的那组数字。
//
// 于是匹配（月 / 日 / 星期 / 时 / 分）全在 `shifted` 上做 getUTC*，算完再把 8 小时
// 减回去得到真实毫秒。**不要**改成 getHours() 之类的本地 getter —— 那会按运行机器
// 的时区再平移一次（db-time-guard 规则 5 静态禁止）。
//
// 【日 / 星期的组合语义】与 Vixie cron 一致：日与星期**都**被限定时取「或」，
// 任一为通配时取「与」（即另一字段说了算）。这条不写清就会出现「周五和 13 号都算」
// 那种只对一半的表达式的误解，所以页面里也复述一遍。
// ─────────────────────────────────────────────────────────────────────────────

import { SITE_TZ_OFFSET_MS } from './datetime';

export type CronFieldName = 'minute' | 'hour' | 'dayOfMonth' | 'month' | 'dayOfWeek';

export interface CronField {
  name: CronFieldName;
  /** 中文字段名（表格第一列）。 */
  label: string;
  /** 用户写的原始段（宏展开之后的）。 */
  raw: string;
  /** 展开后的全部取值（升序、去重）。 */
  values: number[];
  /** 是否覆盖了整段范围（通配符、全区间，以及步长为 1 的写法都算）。 */
  wildcard: boolean;
  /** 带步长写法（星号斜杠 n 那种）时的步长；没有就是 null。 */
  step: number | null;
  /** 中文解释（表格第三列）。 */
  description: string;
}

export interface CronParsed {
  ok: true;
  /** 宏展开后的 5 字段表达式（输入不是宏时与输入等价）。 */
  expanded: string;
  /** 输入用的宏（如 `@daily`）；没用宏则为 null。 */
  macro: string | null;
  fields: CronField[];
}

export interface CronParseError {
  ok: false;
  errors: string[];
}

export type CronParseResult = CronParsed | CronParseError;

export interface CronNextRuns {
  ok: true;
  parsed: CronParsed;
  /** 接下来 N 次执行的真实 Unix 毫秒（升序）。 */
  runs: number[];
  /** 搜索上限内没凑满 count 时为 true（例如 2 月 30 日这种永远不会执行）。 */
  exhausted: boolean;
}

export type CronNextRunsResult = CronNextRuns | CronParseError;

interface FieldSpec {
  name: CronFieldName;
  label: string;
  min: number;
  max: number;
  /** 月份 / 星期的英文别名（大小写不敏感）。 */
  names?: Readonly<Record<string, number>>;
  /** 该字段是否允许 `?`（本工具对任何字段都宽容地当作 `*`，但表里只给日 / 星期提示）。 */
  questionHint?: boolean;
  /** 描述里用的量词（如 `分` / `点` / `号` / `月`）。 */
  unit: string;
}

const MONTH_NAMES: Readonly<Record<string, number>> = {
  JAN: 1,
  FEB: 2,
  MAR: 3,
  APR: 4,
  MAY: 5,
  JUN: 6,
  JUL: 7,
  AUG: 8,
  SEP: 9,
  OCT: 10,
  NOV: 11,
  DEC: 12,
};

const DOW_NAMES: Readonly<Record<string, number>> = {
  SUN: 0,
  MON: 1,
  TUE: 2,
  WED: 3,
  THU: 4,
  FRI: 5,
  SAT: 6,
};

const FIELD_SPECS: readonly FieldSpec[] = [
  { name: 'minute', label: '分钟', min: 0, max: 59, unit: '分' },
  { name: 'hour', label: '小时', min: 0, max: 23, unit: '点' },
  { name: 'dayOfMonth', label: '日', min: 1, max: 31, unit: '号', questionHint: true },
  {
    name: 'month',
    label: '月',
    min: 1,
    max: 12,
    unit: '月',
    names: MONTH_NAMES,
  },
  {
    name: 'dayOfWeek',
    label: '星期',
    min: 0,
    max: 6,
    unit: '星期',
    names: DOW_NAMES,
    questionHint: true,
  },
];

/** 常用宏（`@` 开头的写法）。键名大写后比对。 */
export const CRON_MACROS: Readonly<Record<string, string>> = {
  '@YEARLY': '0 0 1 1 *',
  '@ANNUALLY': '0 0 1 1 *',
  '@MONTHLY': '0 0 1 * *',
  '@WEEKLY': '0 0 * * 0',
  '@DAILY': '0 0 * * *',
  '@MIDNIGHT': '0 0 * * *',
  '@HOURLY': '0 * * * *',
};

/** 搜索上限：10 年。超过仍凑不满就判定「这个表达式实际上不会执行」。 */
const MAX_SEARCH_DAYS = 366 * 10;

const WEEKDAY_LABELS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

const MONTH_LABELS = [
  '1 月',
  '2 月',
  '3 月',
  '4 月',
  '5 月',
  '6 月',
  '7 月',
  '8 月',
  '9 月',
  '10 月',
  '11 月',
  '12 月',
];

/** 展开宏。不认识的 `@` 直接给错误（静默当普通表达式会算出莫名其妙的时刻）。 */
function expandMacro(input: string): { ok: true; expanded: string; macro: string | null } | CronParseError {
  const text = input.trim();
  if (!text.startsWith('@')) return { ok: true, expanded: text, macro: null };

  const body = text.split(/\s+/)[0];
  const key = body.toUpperCase();
  const expanded = CRON_MACROS[key];
  if (!expanded) {
    return {
      ok: false,
      errors: [
        `不认识的宏 ${body}。支持的宏：${Object.keys(CRON_MACROS).join('、')}（大小写不敏感）。`,
      ],
    };
  }
  if (text.split(/\s+/).length > 1) {
    return { ok: false, errors: [`宏 ${body} 后面不能再跟字段。`] };
  }
  return { ok: true, expanded, macro: body };
}

/** 把单个 token（数字或英文别名）转成数值。 */
function parseToken(
  token: string,
  spec: FieldSpec
): { ok: true; value: number } | { ok: false; reason: string } {
  const up = token.toUpperCase();
  if (spec.names && Object.prototype.hasOwnProperty.call(spec.names, up)) {
    return { ok: true, value: spec.names[up] };
  }
  if (!/^\d{1,3}$/.test(token)) {
    return { ok: false, reason: `「${token}」不是数字${spec.names ? '，也不是可识别的名称' : ''}` };
  }
  let value = Number(token);
  // 星期的 7 与 0 同义（两个星期名都指向周日），其余字段不允许越界。
  if (spec.name === 'dayOfWeek' && value === 7) value = 0;
  if (value < spec.min || value > spec.max) {
    return {
      ok: false,
      reason: `数值 ${token} 超出 ${spec.min}–${spec.max} 范围`,
    };
  }
  return { ok: true, value };
}

interface ParsedFieldValues {
  values: number[];
  step: number | null;
}

/**
 * 解析一个字段（通配符 / 区间 / 列表 / 步长写法 / 单值 / 名称）。
 * 返回全部取值（升序去重）与「整段步长」（仅当整个字段就是一个带步长的区间时）。
 */
function parseFieldValues(
  raw: string,
  spec: FieldSpec
): { ok: true; parsed: ParsedFieldValues } | { ok: false; errors: string[] } {
  const normalizedRaw = raw === '?' ? '*' : raw;
  const parts = normalizedRaw.split(',');
  const values = new Set<number>();
  const errors: string[] = [];
  let wholeRangeStep: number | null = null;
  let wholeRangeStart: number | null = null;
  let wholeRangeEnd: number | null = null;
  let allPartsAreRanges = true;

  for (const partRaw of parts) {
    const part = partRaw.trim();
    if (part === '') {
      errors.push('存在空的分段（多余的逗号？）');
      allPartsAreRanges = false;
      continue;
    }

    let rangePart = part;
    let step: number | null = null;
    if (part.includes('/')) {
      const seg = part.split('/');
      if (seg.length !== 2) {
        errors.push(`「${part}」的步长写法不完整（应为 范围/步长）`);
        allPartsAreRanges = false;
        continue;
      }
      rangePart = seg[0].trim();
      const stepText = seg[1].trim();
      if (!/^\d{1,3}$/.test(stepText) || Number(stepText) < 1) {
        errors.push(`「${part}」的步长必须是正整数`);
        allPartsAreRanges = false;
        continue;
      }
      step = Number(stepText);
      if (step > spec.max - spec.min + 1) {
        errors.push(`「${part}」的步长超过字段范围，实际等价于单个值`);
      }
    }

    let start: number;
    let end: number;
    if (rangePart === '*') {
      start = spec.min;
      end = spec.max;
    } else if (rangePart.includes('-')) {
      const seg = rangePart.split('-');
      if (seg.length !== 2) {
        errors.push(`「${rangePart}」的区间写法不完整（应为 起点-终点）`);
        allPartsAreRanges = false;
        continue;
      }
      const lo = parseToken(seg[0].trim(), spec);
      const hi = parseToken(seg[1].trim(), spec);
      if (!lo.ok) {
        errors.push(`区间起点无法识别：${lo.reason}`);
        allPartsAreRanges = false;
        continue;
      }
      if (!hi.ok) {
        errors.push(`区间终点无法识别：${hi.reason}`);
        allPartsAreRanges = false;
        continue;
      }
      start = lo.value;
      end = hi.value;
      if (start > end) {
        errors.push(`区间 ${rangePart} 的起点大于终点`);
        allPartsAreRanges = false;
        continue;
      }
    } else {
      const single = parseToken(rangePart, spec);
      if (!single.ok) {
        errors.push(single.reason);
        allPartsAreRanges = false;
        continue;
      }
      start = single.value;
      end = step === null ? single.value : spec.max;
    }

    const stride = step ?? 1;
    for (let v = start; v <= end; v += stride) values.add(v);

    if (parts.length === 1 && step !== null) {
      wholeRangeStep = step;
      wholeRangeStart = start;
      wholeRangeEnd = end;
    } else if (step !== null) {
      allPartsAreRanges = false;
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  if (values.size === 0) return { ok: false, errors: ['展开后没有任何取值'] };

  // 只有「整个字段就是一个连续区间」时 step 才有描述意义；多个分段时置 null。
  const keepStep =
    allPartsAreRanges &&
    wholeRangeStep !== null &&
    wholeRangeStart !== null &&
    wholeRangeEnd !== null;

  return {
    ok: true,
    parsed: {
      values: [...values].sort((a, b) => a - b),
      step: keepStep ? wholeRangeStep : null,
    },
  };
}

/** 把取值列表用顿号连接；过长时只列前 16 个并注明总数。 */
function joinValues<T>(values: readonly T[], render: (v: T) => string, max = 16): string {
  if (values.length <= max) return values.map(render).join('、');
  const head = values.slice(0, max).map(render).join('、');
  return `${head}…（共 ${values.length} 个值）`;
}

function describeField(spec: FieldSpec, values: number[], wildcard: boolean, step: number | null): string {
  const first = values[0];
  const last = values[values.length - 1];
  const stepSuffix = first === spec.min ? '' : `（从 ${first} 起）`;

  // 带步长时先说步长：`*/15` 展开后只有 4 个值，逐值罗列会被读成「只在这几分钟执行」，
  // 而它真正的含义是「每 15 分钟一次」。
  if (step !== null) {
    if (spec.name === 'minute') return `每 ${step} 分钟${stepSuffix}`;
    if (spec.name === 'hour') return `每 ${step} 小时${stepSuffix}`;
    if (spec.name === 'dayOfMonth') return `每 ${step} 天${stepSuffix}`;
    if (spec.name === 'month') return `每 ${step} 个月${stepSuffix}`;
  }

  switch (spec.name) {
    case 'minute':
      if (wildcard) return '每分钟';
      if (values.length === 1) return `第 ${first} 分钟`;
      return `第 ${joinValues(values, (v) => `${v}`)} 分钟`;
    case 'hour':
      if (wildcard) return '每小时';
      if (values.length === 1) return `${first} 点`;
      return `${joinValues(values, (v) => `${v}`)} 点`;
    case 'dayOfMonth':
      if (wildcard) return '每天';
      if (values.length === 1) return `${first} 号`;
      return `${joinValues(values, (v) => `${v}`)} 号`;
    case 'month':
      if (wildcard) return '每月';
      return joinValues(values, (v) => MONTH_LABELS[v - 1]);
    case 'dayOfWeek':
      if (wildcard) return '每周的每一天';
      return `每${joinValues(values, (v) => WEEKDAY_LABELS[v])}`;
    default:
      return `${first} – ${last}`;
  }
}

/** 解析 5 字段 cron。错误按字段收集，页面逐条展示。 */
export function parseCron(expr: string): CronParseResult {
  const macro = expandMacro(expr);
  if (!macro.ok) return macro;

  const text = macro.expanded.replace(/\s+/g, ' ').trim();
  if (text === '') return { ok: false, errors: ['表达式为空。'] };

  const parts = text.split(' ');
  if (parts.length !== 5) {
    return {
      ok: false,
      errors: [
        `本工具只支持 5 字段 cron（分 时 日 月 周），当前输入是 ${parts.length} 个字段` +
          (parts.length === 6 ? '（是不是带秒的 6 字段写法？）' : '。'),
      ],
    };
  }

  const fields: CronField[] = [];
  const errors: string[] = [];

  for (let i = 0; i < FIELD_SPECS.length; i++) {
    const spec = FIELD_SPECS[i];
    const raw = parts[i];
    const parsed = parseFieldValues(raw, spec);
    if (!parsed.ok) {
      errors.push(...parsed.errors.map((e) => `[${spec.label}] ${e}`));
      continue;
    }
    const { values, step } = parsed.parsed;
    const fullSize = spec.max - spec.min + 1;
    const wildcard = values.length === fullSize;
    fields.push({
      name: spec.name,
      label: spec.label,
      raw,
      values,
      wildcard,
      step,
      description: describeField(spec, values, wildcard, step),
    });
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, expanded: text, macro: macro.macro, fields };
}

function fieldByName(parsed: CronParsed, name: CronFieldName): CronField {
  const found = parsed.fields.find((f) => f.name === name);
  if (!found) {
    // parseCron 保证五个字段都在；这里只是让类型收窄，正常不会走到。
    throw new Error(`cron 字段缺失：${name}`);
  }
  return found;
}

/**
 * 计算接下来 `count` 次执行时刻（真实 Unix 毫秒，升序）。
 *
 * 算法：把起点平移到「UTC+8 墙上时间」后按天推进 ——
 *   1. 逐天检查月 / 日 / 星期（日与星期都受限时取「或」）；
 *   2. 命中的那一天再按 hour × minute 的取值组合出候选时刻；
 *   3. 候选必须**严格晚于** fromMs（`fromMs` 本身就是执行时刻时不算「下一次」）。
 *
 * 逐天推进而不是逐分钟推进，是因为 `0 0 29 2 *`（闰年 2 月 29 日）这类表达式
 * 下一次执行可能在几年后 —— 逐分钟会扫上百万次。
 */
export function nextRuns(expr: string, fromMs: number, count: number): CronNextRunsResult {
  const parsed = parseCron(expr);
  if (!parsed.ok) return parsed;

  const wanted = Math.max(0, Math.trunc(count));
  if (wanted === 0) return { ok: true, parsed, runs: [], exhausted: false };

  const minutes = fieldByName(parsed, 'minute').values;
  const hours = fieldByName(parsed, 'hour').values;
  const domField = fieldByName(parsed, 'dayOfMonth');
  const monthField = fieldByName(parsed, 'month');
  const dowField = fieldByName(parsed, 'dayOfWeek');

  const monthSet = new Set(monthField.values);
  const domSet = new Set(domField.values);
  const dowSet = new Set(dowField.values);
  const domRestricted = !domField.wildcard;
  const dowRestricted = !dowField.wildcard;

  const runs: number[] = [];
  const fromShifted = fromMs + SITE_TZ_OFFSET_MS;
  const firstDayShifted = Math.floor(fromShifted / 86400000) * 86400000;

  for (let dayOffset = 0; dayOffset <= MAX_SEARCH_DAYS && runs.length < wanted; dayOffset++) {
    const dayShifted = firstDayShifted + dayOffset * 86400000;
    const day = new Date(dayShifted);
    const month = day.getUTCMonth() + 1;
    if (!monthSet.has(month)) continue;

    const dom = day.getUTCDate();
    const dow = day.getUTCDay();
    const dayMatches =
      domRestricted && dowRestricted ? domSet.has(dom) || dowSet.has(dow) : domSet.has(dom) && dowSet.has(dow);
    if (!dayMatches) continue;

    for (const hour of hours) {
      for (const minute of minutes) {
        const candidateShifted = dayShifted + hour * 3600000 + minute * 60000;
        const candidateMs = candidateShifted - SITE_TZ_OFFSET_MS;
        if (candidateMs <= fromMs) continue;
        runs.push(candidateMs);
        if (runs.length >= wanted) break;
      }
      if (runs.length >= wanted) break;
    }
  }

  return { ok: true, parsed, runs, exhausted: runs.length < wanted };
}
