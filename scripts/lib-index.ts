// ─────────────────────────────────────────────────────────────────────────────
// lib-index.ts —— 生成 docs/src-lib-index.md（src/lib 根目录文件索引）
//
// 【为什么要有】docs/architecture.md §5 的人肉文件清单自己承认「漏过两次」。根目录
// 一百多个文件靠手抄维护必然漂：加了文件没人补表、头注释改了表里还是旧说法。
// 这里直接从文件头注释生成，漂了就由守卫 tests/unit/lib-index-guard.test.ts 报红。
//
// 用法（npm scripts 见 package.json）：
//   npm run lib:index         生成并写盘（UTF-8 无 BOM、LF）
//   npm run lib:index:check   只比较，与磁盘不一致时打印前 20 行差异并 exit 1
//   npm run lib:headers       只读报告：头注释超过 30 行的文件（抽取背景用）
//
// 取「一句话职责」的次序（头注释格式以 docs/source-header-style.md 为准）：
//   1. 头注释块里的 `// <文件名> — <职责>`（全角「—」「——」与半角「-」都认）；
//   2. 否则取头注释块里第一个有内容的注释行（跳过分隔线与 import 说明）；
//   3. 都没有则写「（文件头未注明职责）」。
//
// 本文件只做生成：不 import 任何 src/ 运行时依赖，方便被测试直接 import 纯函数。
// ─────────────────────────────────────────────────────────────────────────────

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 仓库根（本文件位于 scripts/ 下）。 */
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** 被索引的目录：src/lib 根目录，**不递归**子目录。 */
export const LIB_DIR = path.join(ROOT, 'src', 'lib');
/** 生成物路径。 */
export const INDEX_PATH = path.join(ROOT, 'docs', 'src-lib-index.md');
/** 文档 H1；必须与 docs-catalog.ts 登记的 title 一致。 */
export const INDEX_H1 = '# src/lib 根目录索引';
/** 头注释超过这个行数就进 `--headers` 报告。 */
export const HEADER_LINE_THRESHOLD = 30;
/** 职责列的字符上限（超出补「…」）。 */
export const RESPONSIBILITY_MAX = 80;
/** `--headers` 报告末尾的提示语。 */
export const HEADER_REPORT_HINT = '按 docs/source-header-style.md 抽取背景到 docs/，改完 npm run lib:index';

/** 头注释里没写职责时的占位文案。 */
const MISSING_RESPONSIBILITY = '（文件头未注明职责）';

/** 一个根目录 TS 文件在索引里的全部信息。 */
export interface LibFileEntry {
  /** 文件名（含 `.ts`）。 */
  name: string;
  /** 物理行数（含空行；UTF-8 解码后按 `\n` 计，末尾换行不额外算一行）。 */
  lines: number;
  /** 行首 export 声明数（后接 function / const / type / interface / class / enum / let / default / {）。 */
  exports: number;
  /** 一句话职责（已截断、已压成一行）。 */
  summary: string;
  /** 文件开头连续注释块的行数，`--headers` 用来挑长头。 */
  headerLines: number;
}

/** `--headers` 报告的一行。 */
export interface HeaderReportEntry {
  /** 文件名（含 `.ts`）。 */
  name: string;
  /** 文件开头连续注释块行数。 */
  lines: number;
}

// ── 基础读取 ────────────────────────────────────────────────────────────────

/**
 * 把文件全文切成行：保留空行，但末尾的换行符不算额外一行。
 * 与 `Get-Content` 的「全行数」口径一致（PSt 下对 UTF-8 文件会按 ANSI 解码出错，这里按 UTF-8）。
 */
function toLines(text: string): string[] {
  if (text === '') return [];
  const raw = text.split('\n');
  if (raw[raw.length - 1] === '') raw.pop();
  return raw.map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));
}

/** 行首 export 计数用的正则（只认行首，忽略缩进 = 缩进里的 export 不算模块出口）。 */
const EXPORT_LINE = /^export\s+(?:async\s+)?(?:function|const|type|interface|class|enum|let|default|\{)/;

/** 纯装饰分隔线（`// ────`、`// =====` 之类），不算「一句话职责」。 */
const DECORATIVE_LINE = /^[\s─━═╌╍╴╶╸╺╼╾┄┅┈┉·•*☆★—–\-=_~…]+$/u;

/** 这一行是否属于注释（`//` 行内注释，或 `/* … *\/` 块注释的任一行）。 */
function isCommentLine(line: string): boolean {
  const body = line.trim();
  return body.startsWith('//') || body.startsWith('/*') || body.startsWith('*');
}

/** 文件开头连续注释块（遇到第一行代码即停）。 */
function headerBlockOf(lines: string[]): string[] {
  let end = 0;
  while (end < lines.length && isCommentLine(lines[end])) end += 1;
  return lines.slice(0, end);
}

/** 去掉注释行的 `//` / `/**` / `*` / `*\/` 外壳，返回正文。 */
function commentBody(line: string): string {
  let body = line.trim();
  if (body.startsWith('//')) body = body.slice(2);
  else if (body.startsWith('/*')) body = body.slice(2);
  if (body.endsWith('*/')) body = body.slice(0, -2);
  if (body.startsWith('*')) body = body.slice(1);
  return body.trim();
}

// ── 职责抽取 ────────────────────────────────────────────────────────────────

/**
 * 优先格式：头注释块里的 `// <文件名> — <职责>`。
 * 全角破折号（「—」「——」）与半角 `-` / `--` 都认；文件名里的连字符按字面转义。
 */
function standardResponsibility(name: string, header: string[]): string | null {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`^//\\s*${escaped}\\s*(?:——|—|-{1,2})\\s*(.+)$`);
  for (const line of header) {
    const match = pattern.exec(line.trim());
    const body = match?.[1]?.trim();
    if (body) return body;
  }
  return null;
}

/** 兜底：头注释块里第一个有内容、非装饰分隔线、非 import 说明的注释行。 */
function fallbackResponsibility(header: string[]): string | null {
  for (const line of header) {
    const body = commentBody(line);
    if (!body) continue;
    if (DECORATIVE_LINE.test(body)) continue;
    if (/^import\b/.test(body)) continue;
    return body;
  }
  return null;
}

/** 压成一行并截到 `RESPONSIBILITY_MAX` 字符（超出补「…」，用码点切，不劈代理对）。 */
export function clampResponsibility(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  const chars = Array.from(oneLine);
  if (chars.length <= RESPONSIBILITY_MAX) return oneLine;
  return `${chars.slice(0, RESPONSIBILITY_MAX - 1).join('')}…`;
}

/** 表格单元格转义：`|` 会把表格切断。 */
function tableCell(text: string): string {
  return text.replace(/\|/g, '\\|');
}

/** 一个文件的职责：优先格式行 → 头注释第一句 → 占位文案。 */
function responsibilityOf(name: string, header: string[]): string {
  const raw = standardResponsibility(name, header) ?? fallbackResponsibility(header);
  return clampResponsibility(raw ?? MISSING_RESPONSIBILITY);
}

// ── 扫描与生成 ──────────────────────────────────────────────────────────────

/** 扫描 src/lib 根目录下全部 `*.ts`（不递归），按文件名排序。 */
export function collectLibFiles(): LibFileEntry[] {
  return fs
    .readdirSync(LIB_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .map((entry) => entry.name)
    .sort()
    .map((name) => {
      const text = fs.readFileSync(path.join(LIB_DIR, name), 'utf8');
      const lines = toLines(text);
      const header = headerBlockOf(lines);
      return {
        name,
        lines: lines.length,
        exports: lines.filter((line) => EXPORT_LINE.test(line)).length,
        summary: responsibilityOf(name, header),
        headerLines: header.length,
      };
    });
}

/** 生成 `docs/src-lib-index.md` 的全文（含末尾换行）。 */
export function buildLibIndexMarkdown(entries: LibFileEntry[] = collectLibFiles()): string {
  const totalLines = entries.reduce((sum, entry) => sum + entry.lines, 0);
  const table = entries.map(
    (entry) => `| \`${entry.name}\` | ${entry.lines} | ${entry.exports} | ${tableCell(entry.summary)} |`
  );
  return [
    INDEX_H1,
    '',
    '> 本文件由 `npm run lib:index` 生成（`scripts/lib-index.ts`），请勿手改；' +
      '守卫见 `tests/unit/lib-index-guard.test.ts`。',
    '',
    '范围：`src/lib` 根目录下全部 `*.ts`，不含 `md-editor/`、`reactive/` 等子目录。',
    '',
    `- 文件数：${entries.length}`,
    `- 合计行数：${totalLines}（含空行）`,
    '',
    '| 文件 | 行数 | 导出数 | 一句话职责 |',
    '| --- | ---: | ---: | --- |',
    ...table,
    '',
    '头注释约定见 `docs/source-header-style.md`。',
  ].join('\n') + '\n';
}

/** `--headers` 的数据部分：头注释超过阈值的文件，按行数倒序。 */
export function collectHeaderReport(entries: LibFileEntry[] = collectLibFiles()): HeaderReportEntry[] {
  return entries
    .filter((entry) => entry.headerLines > HEADER_LINE_THRESHOLD)
    .map((entry) => ({ name: entry.name, lines: entry.headerLines }))
    .sort((a, b) => b.lines - a.lines || a.name.localeCompare(b.name));
}

/** `--headers` 的完整报告文本：`行数\t文件名` 若干行 + 末尾提示。 */
export function buildHeaderReport(entries: LibFileEntry[] = collectLibFiles()): string {
  const rows = collectHeaderReport(entries).map((entry) => `${entry.lines}\t${entry.name}`);
  if (rows.length === 0) rows.push(`没有头注释超过 ${HEADER_LINE_THRESHOLD} 行的文件。`);
  return [...rows, '', HEADER_REPORT_HINT].join('\n') + '\n';
}

// ── CLI ─────────────────────────────────────────────────────────────────────

/** 截掉 split 出来的末尾空串，避免「文件末尾有没有换行」被当差异。 */
function trimTrailingEmpty(lines: string[]): string[] {
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/**
 * 行级最小差异（LCS），只用于 `--check` 的「前 N 行差异」。
 * `-` = 只存在于磁盘（生成结果里没有），`+` = 生成结果里有而磁盘没有。
 */
function diffLines(disk: string, generated: string, limit = 20): string[] {
  const a = trimTrailingEmpty(disk.split('\n'));
  const b = trimTrailingEmpty(generated.split('\n'));
  const width = b.length + 1;
  const lcs = Array.from({ length: a.length + 1 }, () => new Array<number>(width).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (out.length < limit) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      i += 1;
      j += 1;
    } else if (j >= b.length || (i < a.length && lcs[i + 1][j] >= lcs[i][j + 1])) {
      out.push(`- ${a[i]}`);
      i += 1;
    } else {
      out.push(`+ ${b[j]}`);
      j += 1;
    }
    if (i >= a.length && j >= b.length) break;
  }
  return out;
}

/** 生成并写盘。 */
function runGenerate(): number {
  const entries = collectLibFiles();
  const markdown = buildLibIndexMarkdown(entries);
  fs.writeFileSync(INDEX_PATH, markdown, 'utf8');
  const totalLines = entries.reduce((sum, entry) => sum + entry.lines, 0);
  const sizeKb = (Buffer.byteLength(markdown, 'utf8') / 1024).toFixed(1);
  console.log(
    `已生成 docs/src-lib-index.md：${entries.length} 个文件，合计 ${totalLines} 行，${sizeKb} KB。`
  );
  return 0;
}

/** 只比较，不写盘。 */
function runCheck(): number {
  const generated = buildLibIndexMarkdown();
  const exists = fs.existsSync(INDEX_PATH);
  const disk = exists ? fs.readFileSync(INDEX_PATH, 'utf8') : '';
  if (exists && disk === generated) {
    const sizeKb = (Buffer.byteLength(generated, 'utf8') / 1024).toFixed(1);
    console.log(`docs/src-lib-index.md 与 src/lib 当前状态一致（${sizeKb} KB）。`);
    return 0;
  }
  console.error('docs/src-lib-index.md 与生成结果不一致，跑 npm run lib:index 重新生成。');
  if (!exists) {
    console.error('（文件不存在）');
  } else {
    console.error('差异（- 磁盘 / + 生成，最多 20 行）：');
    for (const line of diffLines(disk, generated)) console.error(line);
  }
  return 1;
}

/** `--headers`：只读报告，不写盘。 */
function runHeaders(): number {
  process.stdout.write(buildHeaderReport());
  return 0;
}

/** 用法说明。 */
function usage(): void {
  console.error('用法：tsx scripts/lib-index.ts [--check | --headers]');
  console.error('  （无参数）  生成 docs/src-lib-index.md');
  console.error('  --check     对照磁盘，不一致 exit 1');
  console.error('  --headers   只读：报告头注释超过 30 行的文件');
}

/** CLI 入口：`node scripts/lib-index.ts` / tsx 直接运行时执行。 */
function main(argv: string[]): number {
  const flag = argv[0];
  if (flag === undefined) return runGenerate();
  if (flag === '--check') return runCheck();
  if (flag === '--headers') return runHeaders();
  usage();
  return 1;
}

/**
 * 是否作为脚本直接运行。
 * Windows 路径大小写不敏感（`tsx scripts/lib-index.ts` 与 import.meta.url 可能大小写不同），
 * 统一 resolve + lowercase 再比较。
 */
function invokedDirectly(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  const self = fileURLToPath(import.meta.url);
  const normalize = (target: string) => path.resolve(target).toLowerCase();
  return normalize(entry) === normalize(self);
}

if (invokedDirectly()) {
  process.exitCode = main(process.argv.slice(2));
}
