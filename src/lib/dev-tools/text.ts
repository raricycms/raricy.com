// ─────────────────────────────────────────────────────────────────────────────
// text.ts —— 「文本工具」的纯逻辑（统计 / 大小写转换 / 行操作）
//
// 【为什么是零依赖纯函数】页面是客户端组件，统计与转换要实时、本地完成；单测又要在
// node 里直接 import。这里不碰 React、不读环境、不取「现在」，输入输出都是字符串。
//
// 【几条口径，写清楚免得页面和测试各说各话】
//   · 「字符数」按 **Unicode 码点** 数（`Array.from`），不是 UTF-16 码元 —— emoji 与
//     少数字符在码元层面会算成 2，用户会以为统计错了。
//   · 「行数」= 物理行数，与编辑器行号一致：空串 0、`"a"` 1、`"a\n"` 2（末尾换行
//     开启了最后一个空行）、`"\n"` 2。空行（含只有空白的行）从「非空行数」里排除。
//   · 行操作**不走这个口径**：内部按 splitText 切开、丢掉末尾换行产生的空行，否则
//     「排序」会把那个空行排到最前面、「去空行」的结果又凭空多一行。
//   · 「段落数」= 被**空行**（只含空白的行）分隔的非空文本块数，与 Markdown 的段落
//     口径一致；单换行不分段。
//   · 行操作保留原文本的换行风格（CRLF 输入仍输出 CRLF），不悄悄改成 LF。
//   · 排序按**字符编码顺序**（`<` 比较），不是 `localeCompare` —— 后者随运行环境
//     ICU 数据变化，同一段文本在不同机器上会得到不同顺序，单测也没法钉死。
// ─────────────────────────────────────────────────────────────────────────────

export interface TextStats {
  /** Unicode 码点数（含空白与换行）。 */
  chars: number;
  /** 去掉所有空白字符（空格 / 制表 / 换行 / 全角空格等）后的码点数。 */
  charsNoWhitespace: number;
  /** 行数：与编辑器行号一致，空串为 0、`"a\n"` 为 2。 */
  lines: number;
  /** 非空行数（只含空白字符的行不算）。 */
  nonEmptyLines: number;
  /** 段落数：被空行分隔的非空块数。 */
  paragraphs: number;
}

export type TextTransform = 'upper' | 'lower' | 'title' | 'reverse-lines';

export type LineOp =
  | 'sort-asc'
  | 'sort-desc'
  | 'dedupe'
  | 'drop-empty'
  | 'trim'
  | 'number'
  | 'unnumber';

/** 表达「这个操作是做什么的」的文案表，页面与文档共用一份。 */
export const TEXT_TRANSFORMS: ReadonlyArray<{ value: TextTransform; label: string }> = [
  { value: 'upper', label: '全部大写' },
  { value: 'lower', label: '全部小写' },
  { value: 'title', label: '每个单词首字母大写' },
  { value: 'reverse-lines', label: '反转行序' },
];

export const TEXT_LINE_OPS: ReadonlyArray<{ value: LineOp; label: string }> = [
  { value: 'sort-asc', label: '按行升序排序' },
  { value: 'sort-desc', label: '按行降序排序' },
  { value: 'dedupe', label: '去除重复行' },
  { value: 'drop-empty', label: '去除空行' },
  { value: 'trim', label: '去除每行首尾空白' },
  { value: 'number', label: '添加行号' },
  { value: 'unnumber', label: '去除行号' },
];

interface SplitText {
  /** 不含末尾换行符产生的空行。 */
  lines: string[];
  /** 原文使用的换行符（CRLF / LF）。 */
  eol: string;
  /** 原文是否以换行符结尾。 */
  trailing: boolean;
}

/** 统一换行符后按行切开；末尾换行单独记成 trailing，避免多出一个「空行」。 */
function splitText(text: string): SplitText {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const normalized = text.replace(/\r\n?/g, '\n');
  const trailing = normalized.endsWith('\n');
  const body = trailing ? normalized.slice(0, -1) : normalized;
  return { lines: body === '' ? [] : body.split('\n'), eol, trailing };
}

function joinText(lines: string[], eol: string, trailing: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(eol) + (trailing ? eol : '');
}

/** 统计字数、行数与段落数。输入为空时各项都是 0。 */
export function analyzeText(text: string): TextStats {
  const codePoints = Array.from(text);
  const chars = codePoints.length;
  const charsNoWhitespace = codePoints.filter((ch) => !/\s/u.test(ch)).length;
  const normalized = text.replace(/\r\n?/g, '\n');
  const lines = normalized === '' ? [] : normalized.split('\n');
  const nonEmptyLines = lines.filter((line) => line.trim() !== '').length;
  // 段落：按「至少一个只含空白的行」切块。空白口径与上面的非空行判定一致
  // （`trim()` 认全部 Unicode 空白，所以这里用 `[^\S\n]` 而不是只列空格 / 制表 /
  // 全角空格；否则「NBSP 空行」会让非空行数与段落数自相矛盾）。
  const paragraphs =
    normalized.trim() === ''
      ? 0
      : normalized
          .split(/\n[^\S\n]*\n/)
          .map((block) => block.trim())
          .filter((block) => block !== '').length;

  return {
    chars,
    charsNoWhitespace,
    lines: lines.length,
    nonEmptyLines,
    paragraphs,
  };
}

/**
 * 每个单词的首字母大写，其余字符不动。
 *
 * 用 Unicode 字母类 `\p{L}` 做词边界，所以英文、带重音的拉丁字母、希腊/西里尔都覆盖；
 * 中文没有「单词首字母大写」的概念，保持不变（不报错）。**连字符算词边界**
 * （`state-of-the-art` → `State-Of-The-Art`，与多数标题化工具的直觉一致），
 * 撇号留在词内（`it’s` → `It’s`），数字不单独成词。
 */
export function capitalizeWords(text: string): string {
  return text.replace(/\p{L}[\p{L}\p{N}'’]*/gu, (word) => word.charAt(0).toUpperCase() + word.slice(1));
}

/** 应用一次大小写 / 行序转换。 */
export function transformText(text: string, transform: TextTransform): string {
  switch (transform) {
    case 'upper':
      return text.toUpperCase();
    case 'lower':
      return text.toLowerCase();
    case 'title':
      return capitalizeWords(text);
    case 'reverse-lines': {
      const { lines, eol, trailing } = splitText(text);
      return joinText([...lines].reverse(), eol, trailing);
    }
    default: {
      // 联合类型穷尽后这里不可达；显式抛错防止将来加成员时静默返回 undefined。
      const unreachable: never = transform;
      throw new Error(`未知的文本转换：${String(unreachable)}`);
    }
  }
}

/** 按字符编码顺序比较（与 locale 无关，结果稳定可测）。 */
function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** 添加行号：`1. line`。空行也编号，保证「加行号 → 去行号」可逆。 */
export function addLineNumbers(text: string): string {
  const { lines, eol, trailing } = splitText(text);
  return joinText(
    lines.map((line, i) => `${i + 1}. ${line}`),
    eol,
    trailing
  );
}

/** 去除行首的「数字 + . / )」前缀（`addLineNumbers` 的逆操作）。 */
export function stripLineNumbers(text: string): string {
  const { lines, eol, trailing } = splitText(text);
  return joinText(
    lines.map((line) => line.replace(/^\s*\d+[.)]\s?/, '')),
    eol,
    trailing
  );
}

/** 应用一次行操作。 */
export function applyLineOp(text: string, op: LineOp): string {
  const { lines, eol, trailing } = splitText(text);
  switch (op) {
    case 'sort-asc':
      return joinText([...lines].sort(compareCodeUnits), eol, trailing);
    case 'sort-desc':
      return joinText([...lines].sort((a, b) => compareCodeUnits(b, a)), eol, trailing);
    case 'dedupe': {
      // 保留首次出现的顺序（不是排序后去重）—— 用户想「保持原顺序只删重复」。
      const seen = new Set<string>();
      return joinText(
        lines.filter((line) => {
          if (seen.has(line)) return false;
          seen.add(line);
          return true;
        }),
        eol,
        trailing
      );
    }
    case 'drop-empty':
      return joinText(
        lines.filter((line) => line.trim() !== ''),
        eol,
        trailing
      );
    case 'trim':
      return joinText(
        lines.map((line) => line.trim()),
        eol,
        trailing
      );
    case 'number':
      return addLineNumbers(text);
    case 'unnumber':
      return stripLineNumbers(text);
    default: {
      const unreachable: never = op;
      throw new Error(`未知的行操作：${String(unreachable)}`);
    }
  }
}
