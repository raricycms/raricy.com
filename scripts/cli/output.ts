// ─────────────────────────────────────────────────────────────────────────────
// output.ts —— 颜色 / 表格 / 键值渲染 / `--json`
//
// 【为什么表格要自己算宽度】本站是中文站，用 `String.length` 补空格必然错位：
// '中文标题'.length === 4，但它占 8 列。所有宽度一律走 displayWidth()（按码点累加，
// CJK / 全角 / emoji 计 2，组合符计 0），并且在量之前先剥掉 ANSI 转义 ——
// 否则颜色码会被算进列宽。
//
// 【颜色开关】今天 `npm run cli -- fish balance alice | cat` 会打出转义序列
// （cli.mjs 时代无条件上色）。这一版按 NO_COLOR / TERM=dumb / 非 TTY / --no-color /
// --json 任一命中即关闭；FORCE_COLOR=1 可强制保留（CI 日志要看颜色时用）。
// ─────────────────────────────────────────────────────────────────────────────

import type { ColumnSpec, Output } from './types';

// ── 颜色 ─────────────────────────────────────────────────────────────────────

const CODES = { red: 31, green: 32, yellow: 33, dim: 90 } as const;

export interface OutputOptions {
  color: boolean;
  /** --json：stdout 只允许出现一个 JSON 对象，人读输出一律抑制。 */
  json: boolean;
}

/** 按开关决定是否真的上色。关掉时是恒等函数，不产生任何转义字节。 */
export function paint(color: boolean, name: keyof typeof CODES, s: string): string {
  return color ? `\x1b[${CODES[name]}m${s}\x1b[0m` : s;
}

/**
 * 颜色开关。关掉的场合：--json（stdout 必须是纯 JSON）、--no-color、
 * NO_COLOR 环境变量、TERM=dumb、以及**非 TTY**（管道/重定向）。
 * FORCE_COLOR=1 可强行打开（CI 日志里想看颜色时用）。
 */
export function shouldUseColor(flags: { json: boolean; noColor: boolean }): boolean {
  if (flags.json || flags.noColor) return false;
  if (process.env.NO_COLOR !== undefined) return false;
  if (process.env.TERM === 'dumb') return false;
  if (process.env.FORCE_COLOR === '1') return true;
  return process.stdout.isTTY === true;
}

export function createOutput(opts: OutputOptions): Output {
  const { color } = opts;
  return {
    // --json 下 stdout 只出 JSON，人读行全部丢弃（见 printResult）。
    line: (s) => {
      if (!opts.json) process.stdout.write(s + '\n');
    },
    // 警告与错误始终走 stderr：--json 下这保证了 `| jq` 的干净。
    error: (s) => process.stderr.write(s + '\n'),
    red: (s) => paint(color, 'red', s),
    green: (s) => paint(color, 'green', s),
    yellow: (s) => paint(color, 'yellow', s),
    dim: (s) => paint(color, 'dim', s),
    width: () => process.stdout.columns ?? 80,
  };
}

// ── 显示宽度 ─────────────────────────────────────────────────────────────────

const ANSI_RE = /\x1b\[[0-9;]*m/g;

/** 剥掉 ANSI 转义后再算宽度（否则颜色码会被算进列宽）。 */
export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '');
}

/** 单个码点的显示宽度：2 = 东亚宽 / 全角 / emoji，0 = 组合符 / 零宽连接符。 */
function cpWidth(cp: number): 0 | 1 | 2 {
  if (cp === 0x200d) return 0; // ZWJ
  if (cp >= 0x0300 && cp <= 0x036f) return 0; // 组合附加符
  if (
    (cp >= 0x1100 && cp <= 0x115f) || // 谚文字母
    (cp >= 0x2e80 && cp <= 0x303e) || // CJK 部首 / 标点
    (cp >= 0x3041 && cp <= 0x33ff) || // 假名 / 注音 / 兼容
    (cp >= 0x3400 && cp <= 0x4dbf) || // CJK 扩展 A
    (cp >= 0x4e00 && cp <= 0x9fff) || // CJK 基本区
    (cp >= 0xa000 && cp <= 0xa4cf) || // 彝文
    (cp >= 0xac00 && cp <= 0xd7a3) || // 谚文音节
    (cp >= 0xf900 && cp <= 0xfaff) || // 兼容汉字
    (cp >= 0xfe10 && cp <= 0xfe19) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) || // 全角
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) || // emoji
    (cp >= 0x1f900 && cp <= 0x1f9ff) ||
    (cp >= 0x20000 && cp <= 0x3fffd) // CJK 扩展 B+
  ) {
    return 2;
  }
  return 1;
}

/** 显示宽度。用 for…of 按码点遍历，不拆代理对。 */
export function displayWidth(s: string): number {
  let w = 0;
  for (const ch of stripAnsi(s)) w += cpWidth(ch.codePointAt(0)!);
  return w;
}

/** 截断到指定显示宽度，超出的部分用 '…' 收尾。 */
export function truncateTo(s: string, width: number): string {
  const plain = stripAnsi(s);
  if (displayWidth(plain) <= width) return s;
  if (width <= 1) return '…';
  let out = '';
  let w = 0;
  for (const ch of plain) {
    const cw = cpWidth(ch.codePointAt(0)!);
    if (w + cw > width - 1) break;
    out += ch;
    w += cw;
  }
  return out + '…';
}

/** 按显示宽度补空格到指定宽度。 */
export function padTo(s: string, width: number, align: 'left' | 'right' = 'left'): string {
  const gap = Math.max(0, width - displayWidth(s));
  return align === 'right' ? ' '.repeat(gap) + s : s + ' '.repeat(gap);
}

// ── 表格 / 键值 ──────────────────────────────────────────────────────────────

/** 单元格 → 一行文本：null/空 → '—'，换行折成空格（否则表格会被正文撑烂）。 */
function cellText(v: unknown): string {
  if (v === null || v === undefined || v === '') return '—';
  return String(v).replace(/\s*\n+\s*/g, ' ');
}

export interface TableOptions {
  /** 终端宽度上限；列宽总和超出时按比例压缩。 */
  maxWidth?: number;
  emptyText?: string;
}

/**
 * 渲染表格。返回行数组（不含颜色）—— 宽度算完再加色会破坏对齐，所以表内一律不上色。
 */
export function renderTable(
  columns: ColumnSpec[],
  rows: Record<string, unknown>[],
  opts: TableOptions = {}
): string[] {
  if (rows.length === 0) return [opts.emptyText ?? '（无结果）'];

  const maxWidth = opts.maxWidth ?? 80;
  const GUTTER = 2; // 列间两个空格
  const budget = Math.max(20, maxWidth - GUTTER * (columns.length - 1));

  // 每列的「自然宽度」= 表头与所有单元格里最宽的那个（受 maxWidth 限制）
  const natural = columns.map((col) => {
    const cells = rows.map((r) => cellText(r[col.key]));
    const widest = Math.max(displayWidth(col.title), ...cells.map((c) => displayWidth(c)));
    return col.maxWidth ? Math.min(widest, col.maxWidth) : widest;
  });

  // 总和超预算就按超出比例从「可压缩的列」里扣（每列至少留 4 列宽）
  const total = natural.reduce((a, b) => a + b, 0);
  let widths = natural;
  if (total > budget) {
    const over = total - budget;
    const slack = natural.reduce((a, w) => a + Math.max(0, w - 4), 0);
    widths = natural.map((w) => {
      const room = Math.max(0, w - 4);
      return slack > 0 ? Math.max(4, w - Math.floor((over * room) / slack)) : Math.max(4, w);
    });
  }

  const renderRow = (cells: string[]): string =>
    cells
      .map((c, i) => padTo(truncateTo(c, widths[i]), widths[i], columns[i].align ?? 'left'))
      .join(' '.repeat(GUTTER))
      .replace(/\s+$/, '');

  const header = renderRow(columns.map((c) => c.title));
  const rule = '─'.repeat(displayWidth(header));
  const body = rows.map((r) => renderRow(columns.map((c) => cellText(r[c.key]))));

  return [header, rule, ...body];
}

/** 渲染「键：值」块（单记录用，如 user show / stats overview）。 */
export function renderKv(pairs: [string, string | number | null | undefined][]): string[] {
  const labelWidth = Math.max(...pairs.map(([k]) => displayWidth(k)));
  return pairs.map(([k, v]) => `${padTo(k, labelWidth)}  ${cellText(v)}`.replace(/\s+$/, ''));
}
