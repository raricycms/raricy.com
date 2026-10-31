// ─────────────────────────────────────────────────────────────────────────────
// dev-tools/diff.ts —— 文本逐行 Diff 的纯逻辑（零依赖、零 React、node 可直接 import）
//
// 【算法】按行 LCS（最长公共子序列）的 DP，回溯出一份「最小增删脚本」。
//   为什么不是 Myers：Myers 的 trace 最坏情况是 O(D²) 的整数内存（5000 行全不同时
//   D≈10000，几十 MB 只是起点）；而本工具每侧硬上限 5000 行，DP 的方向矩阵
//   `(n+1)*(m+1)` 个字节最多 ~25 MB、25M 次迭代，浏览器一次点击完全扛得住，
//   代码也短得多、可测。**先剥公共前后缀**，所以「大文件只改中间几行」的常见输入
//   根本走不到最坏情况。
//   真超过 `MAX_DP_CELLS`（只可能来自直接调用本模块、绕过 5000 行上限的场景）时
//   退化成「整块删除 + 整块插入」，并在结果上标 `simplified: true`，页面会说明。
//
// 【末尾换行】
//   `splitLines` 把末尾的换行序列当行终止符而不是「最后还有一个空行」：
//   `"a\nb\n"` 与 `"a\nb"` 都得到 2 行。这是行 diff 的常规口径，页面上也写了。
//
// 【忽略选项只影响「比较」，不影响「展示」】
//   `ignoreCase` / `ignoreTrailingWhitespace` 作用在比较用的 key 上；输出的
//   每一行仍然是原文，否则用户看到的是被改过的文本，等于偷偷改内容。
// ─────────────────────────────────────────────────────────────────────────────

/** 每侧行数上限（页面文案与校验读同一个数）。 */
export const DIFF_MAX_LINES = 5000;

/** unified diff 的默认上下文行数（改动前后各显示几行）。 */
export const DIFF_CONTEXT_LINES = 3;

/** DP 方向矩阵的单元格上限；超过就退化为整块替换。 */
const MAX_DP_CELLS = 30_000_000;

export type DiffLineType = 'equal' | 'add' | 'remove';

export interface DiffLine {
  type: DiffLineType;
  /** 原文（不因忽略大小写 / 行尾空白而改变）。 */
  text: string;
  /** 该行在左侧文本里的行号（1 基）；新增行为 null。 */
  oldLine: number | null;
  /** 该行在右侧文本里的行号（1 基）；删除行为 null。 */
  newLine: number | null;
}

export interface DiffOptions {
  ignoreCase?: boolean;
  ignoreTrailingWhitespace?: boolean;
  /** 上下文行数，默认 3，夹在 0–20。 */
  context?: number;
}

export interface DiffStats {
  added: number;
  removed: number;
  unchanged: number;
}

export interface DiffHunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: DiffLine[];
}

export interface DiffResult {
  /** 完整逐行结果（页面列表直接渲染它）。 */
  lines: DiffLine[];
  /** unified diff 的分块（复制那一段用它）。 */
  hunks: DiffHunk[];
  stats: DiffStats;
  identical: boolean;
  leftLines: number;
  rightLines: number;
  /** true 表示差异过大、退化成整块替换（只在绕过 5000 行上限时可能发生）。 */
  simplified: boolean;
}

/** 单侧超过 5000 行时抛它（页面会先自行检查，这里兜底）。 */
export class DiffLimitError extends Error {
  constructor(readonly side: 'left' | 'right', readonly lineCount: number) {
    super(
      `${side === 'left' ? '左侧' : '右侧'}有 ${lineCount} 行，超过 ${DIFF_MAX_LINES} 行上限`,
    );
    this.name = 'DiffLimitError';
  }
}

// ── 行切分 ───────────────────────────────────────────────────────────────────

/**
 * 切行：CRLF / CR / LF 都认，末尾换行不额外产生空行。
 * `""` → `[]`；`"\n"` → `[""]`；`"a\n\nb"` → `["a", "", "b"]`。
 */
export function splitLines(text: string): string[] {
  if (text === '') return [];
  const normalized = text.replace(/\r\n?/g, '\n');
  const parts = normalized.split('\n');
  if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
  return parts;
}

/** 行数（与 `splitLines().length` 等价，但不需要真的切数组；输入框每次键入都用它）。 */
export function countLines(text: string): number {
  if (text === '') return 0;
  let count = 1;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === 13) {
      count++;
      if (text.charCodeAt(i + 1) === 10) i++;
    } else if (code === 10) {
      count++;
    }
  }
  if (text.endsWith('\n') || text.endsWith('\r')) count--;
  return count;
}

// ── 比较用的 key ─────────────────────────────────────────────────────────────

interface CompareOptions {
  ignoreCase: boolean;
  ignoreTrailingWhitespace: boolean;
}

function compareKey(line: string, options: CompareOptions): string {
  let key = line;
  if (options.ignoreTrailingWhitespace) key = key.replace(/[ \t]+$/, '');
  if (options.ignoreCase) key = key.toLowerCase();
  return key;
}

// ── 核心：带行号的 LCS 回溯 ──────────────────────────────────────────────────

/** 整块替换（DP 超限时的退化结果）。 */
function blockFallback(a: string[], b: string[], start: number): DiffLine[] {
  const out: DiffLine[] = [];
  a.forEach((text, index) => {
    out.push({ type: 'remove', text, oldLine: start + index + 1, newLine: null });
  });
  b.forEach((text, index) => {
    out.push({ type: 'add', text, oldLine: null, newLine: start + index + 1 });
  });
  return out;
}

/**
 * 对中间段（已剥掉公共前后缀）做 LCS，`start` 是公共前缀的行数（用来还原全局行号）。
 * 返回的结果按「左侧/右侧文本顺序」排列。
 */
function diffMiddle(
  a: string[],
  b: string[],
  keysA: string[],
  keysB: string[],
  start: number,
): { lines: DiffLine[]; simplified: boolean } {
  const n = a.length;
  const m = b.length;
  if (n === 0 && m === 0) return { lines: [], simplified: false };
  if (n === 0) {
    return {
      lines: b.map((text, index) => ({
        type: 'add' as const,
        text,
        oldLine: null,
        newLine: start + index + 1,
      })),
      simplified: false,
    };
  }
  if (m === 0) {
    return {
      lines: a.map((text, index) => ({
        type: 'remove' as const,
        text,
        oldLine: start + index + 1,
        newLine: null,
      })),
      simplified: false,
    };
  }
  if ((n + 1) * (m + 1) > MAX_DP_CELLS) {
    return { lines: blockFallback(a, b, start), simplified: true };
  }

  const width = m + 1;
  const dir = new Uint8Array((n + 1) * width);
  const prev = new Int32Array(width);
  const cur = new Int32Array(width);
  for (let i = 1; i <= n; i++) {
    const rowBase = i * width;
    cur[0] = 0;
    const keyA = keysA[i - 1];
    for (let j = 1; j <= m; j++) {
      if (keyA === keysB[j - 1]) {
        dir[rowBase + j] = 0; // 匹配：从左上角来
        cur[j] = prev[j - 1] + 1;
      } else if (prev[j] >= cur[j - 1]) {
        dir[rowBase + j] = 1; // 删左侧一行
        cur[j] = prev[j];
      } else {
        dir[rowBase + j] = 2; // 插右侧一行
        cur[j] = cur[j - 1];
      }
    }
    prev.set(cur);
  }

  const reversed: DiffLine[] = [];
  let i = n;
  let j = m;
  while (i > 0 && j > 0) {
    const direction = dir[i * width + j];
    if (direction === 0) {
      reversed.push({ type: 'equal', text: a[i - 1], oldLine: start + i, newLine: start + j });
      i--;
      j--;
    } else if (direction === 1) {
      reversed.push({ type: 'remove', text: a[i - 1], oldLine: start + i, newLine: null });
      i--;
    } else {
      reversed.push({ type: 'add', text: b[j - 1], oldLine: null, newLine: start + j });
      j--;
    }
  }
  // 回溯到一侧耗尽后，剩下的都是纯新增 / 纯删除。
  while (j > 0) {
    reversed.push({ type: 'add', text: b[j - 1], oldLine: null, newLine: start + j });
    j--;
  }
  while (i > 0) {
    reversed.push({ type: 'remove', text: a[i - 1], oldLine: start + i, newLine: null });
    i--;
  }
  // 回溯是反向的，先把整条中间段翻转。
  reversed.reverse();
  return { lines: reorderChangeRuns(reversed), simplified: false };
}

/**
 * 把每段连续改动整理成「先删除、后新增」。
 *
 * LCS 回溯出来的顺序本身是合法的（路径唯一），但可能是「先增加、后删除」。
 * unified diff 的惯例（`-` 在 `+` 前面）更符合阅读习惯，也让两个方向的输出稳定；
 * 行号不受影响（每行自带 oldLine / newLine）。
 */
function reorderChangeRuns(lines: DiffLine[]): DiffLine[] {
  const out: DiffLine[] = [];
  let removes: DiffLine[] = [];
  let adds: DiffLine[] = [];
  const flush = (): void => {
    if (removes.length > 0) out.push(...removes);
    if (adds.length > 0) out.push(...adds);
    removes = [];
    adds = [];
  };
  for (const line of lines) {
    if (line.type === 'remove') {
      removes.push(line);
    } else if (line.type === 'add') {
      adds.push(line);
    } else {
      flush();
      out.push(line);
    }
  }
  flush();
  return out;
}

// ── hunks（unified diff 的分块）──────────────────────────────────────────────

function buildHunks(lines: DiffLine[], context: number): DiffHunk[] {
  const changeIndexes: number[] = [];
  lines.forEach((line, index) => {
    if (line.type !== 'equal') changeIndexes.push(index);
  });
  if (changeIndexes.length === 0) return [];

  // 相邻改动之间隔了不超过 2×context 行就并进同一个 hunk（两个上下文窗口相接）。
  const groups: Array<[number, number]> = [];
  for (const index of changeIndexes) {
    const last = groups[groups.length - 1];
    if (last && index - last[1] - 1 <= context * 2) last[1] = index;
    else groups.push([index, index]);
  }

  return groups.map(([first, last]) => {
    const start = Math.max(0, first - context);
    const end = Math.min(lines.length - 1, last + context);
    const slice = lines.slice(start, end + 1);
    const oldNumbers = slice.map((line) => line.oldLine).filter((value): value is number => value !== null);
    const newNumbers = slice.map((line) => line.newLine).filter((value): value is number => value !== null);
    const previous = start > 0 ? lines[start - 1] : null;
    const oldStart =
      oldNumbers.length > 0
        ? oldNumbers[0]
        : previous !== null && previous.oldLine !== null
          ? previous.oldLine + 1
          : 0;
    const newStart =
      newNumbers.length > 0
        ? newNumbers[0]
        : previous !== null && previous.newLine !== null
          ? previous.newLine + 1
          : 0;
    return {
      oldStart,
      oldCount: oldNumbers.length,
      newStart,
      newCount: newNumbers.length,
      lines: slice,
    };
  });
}

// ── 对外入口 ─────────────────────────────────────────────────────────────────

/** 逐行对比两段文本。单侧超过 5000 行时抛 `DiffLimitError`。 */
export function computeDiff(leftText: string, rightText: string, options: DiffOptions = {}): DiffResult {
  const left = splitLines(leftText);
  const right = splitLines(rightText);
  if (left.length > DIFF_MAX_LINES) throw new DiffLimitError('left', left.length);
  if (right.length > DIFF_MAX_LINES) throw new DiffLimitError('right', right.length);

  const context = Math.max(0, Math.min(options.context ?? DIFF_CONTEXT_LINES, 20));
  const compareOptions: CompareOptions = {
    ignoreCase: options.ignoreCase === true,
    ignoreTrailingWhitespace: options.ignoreTrailingWhitespace === true,
  };
  const keysA = left.map((line) => compareKey(line, compareOptions));
  const keysB = right.map((line) => compareKey(line, compareOptions));

  // 先剥公共前后缀：大多数真实输入（大文件改几行）会在这里被削到很小。
  let prefix = 0;
  while (prefix < left.length && prefix < right.length && keysA[prefix] === keysB[prefix]) prefix++;

  let suffix = 0;
  while (
    suffix < left.length - prefix &&
    suffix < right.length - prefix &&
    keysA[left.length - 1 - suffix] === keysB[right.length - 1 - suffix]
  ) {
    suffix++;
  }

  const midA = left.slice(prefix, left.length - suffix);
  const midB = right.slice(prefix, right.length - suffix);
  const middle = diffMiddle(
    midA,
    midB,
    keysA.slice(prefix, keysA.length - suffix),
    keysB.slice(prefix, keysB.length - suffix),
    prefix,
  );

  const lines: DiffLine[] = [];
  for (let k = 0; k < prefix; k++) {
    lines.push({ type: 'equal', text: left[k], oldLine: k + 1, newLine: k + 1 });
  }
  lines.push(...middle.lines);
  for (let k = 0; k < suffix; k++) {
    const oldIndex = left.length - suffix + k;
    const newIndex = right.length - suffix + k;
    lines.push({
      type: 'equal',
      text: left[oldIndex],
      oldLine: oldIndex + 1,
      newLine: newIndex + 1,
    });
  }

  const stats: DiffStats = { added: 0, removed: 0, unchanged: 0 };
  for (const line of lines) {
    if (line.type === 'add') stats.added++;
    else if (line.type === 'remove') stats.removed++;
    else stats.unchanged++;
  }

  return {
    lines,
    hunks: buildHunks(lines, context),
    stats,
    identical: stats.added === 0 && stats.removed === 0,
    leftLines: left.length,
    rightLines: right.length,
    simplified: middle.simplified,
  };
}

/** unified diff 的计数写法：0 → `start,0`，1 → 只写 start，其余 `start,count`。 */
function formatRange(start: number, count: number): string {
  if (count === 0) return `${start},0`;
  if (count === 1) return `${start}`;
  return `${start},${count}`;
}

export interface UnifiedDiffOptions {
  /** `---` 后面的名字，默认「原文本」。 */
  fromLabel?: string;
  /** `+++` 后面的名字，默认「新文本」。 */
  toLabel?: string;
}

/**
 * 生成 unified diff 文本（不含时间戳 —— 本站库内时间是另一把钟，diff 也不需要它）。
 * 两段完全一致时返回空串，页面据此给出「没有差异」。
 */
export function formatUnifiedDiff(result: DiffResult, options: UnifiedDiffOptions = {}): string {
  if (result.identical) return '';
  const fromLabel = options.fromLabel ?? '原文本';
  const toLabel = options.toLabel ?? '新文本';
  const out: string[] = [`--- ${fromLabel}`, `+++ ${toLabel}`];
  for (const hunk of result.hunks) {
    out.push(
      `@@ -${formatRange(hunk.oldStart, hunk.oldCount)} +${formatRange(hunk.newStart, hunk.newCount)} @@`,
    );
    for (const line of hunk.lines) {
      const sign = line.type === 'add' ? '+' : line.type === 'remove' ? '-' : ' ';
      out.push(sign + line.text);
    }
  }
  return `${out.join('\n')}\n`;
}
