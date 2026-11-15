// ─────────────────────────────────────────────────────────────────────────────
// lib-index-guard.test.ts —— 守住 docs/src-lib-index.md：它必须**正好是**脚本的当前输出
//
// 【为什么要有】索引是生成物，但生成物也会漂：改了文件头没重跑 `npm run lib:index`，
// 站上 /docs 的索引就变成旧说法。人肉审查「这份表和代码对不对得上」不现实（146 个文件），
// 所以这里直接用 fs 重算对账：
//
//   · 生成函数输出 === 磁盘上的文档（不一致 → 跑 npm run lib:index）；
//   · 表格文件名集合 === src/lib 根目录全部 *.ts（多一个、少一个都报）；
//   · 每行行数 === fs 重算的行数（行数口径与脚本一致：含空行、末尾换行不额外算一行）；
//   · H1 与 docs-catalog 登记的标题一致（docs-catalog.test.ts 也在另一边对账）。
//
// 注意：本文件只查「索引怪 vs 代码怪」，**不替人判断职责文案写得好不好** —— 那属于
// docs/source-header-style.md 的审查范围。
// ─────────────────────────────────────────────────────────────────────────────

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  HEADER_LINE_THRESHOLD,
  INDEX_H1,
  INDEX_PATH,
  LIB_DIR,
  RESPONSIBILITY_MAX,
  buildHeaderReport,
  buildLibIndexMarkdown,
  collectLibFiles,
} from '../../scripts/lib-index';

/** 从表格里取出 (文件名, 行数, 导出数)；表头与分隔行不会命中。 */
function tableRows(source: string): { file: string; lines: number; exports: number; summary: string }[] {
  const rows: { file: string; lines: number; exports: number; summary: string }[] = [];
  for (const line of source.split('\n')) {
    const match = /^\| `([^`]+\.ts)` \| (\d+) \| (\d+) \| (.+) \|$/.exec(line);
    if (!match) continue;
    rows.push({
      file: match[1],
      lines: Number(match[2]),
      exports: Number(match[3]),
      summary: match[4],
    });
  }
  return rows;
}

/** `buildHeaderReport()` 的数据行（`行数\t文件名`）。 */
function reportRows(report: string): { lines: number; name: string }[] {
  const rows: { lines: number; name: string }[] = [];
  for (const line of report.split('\n')) {
    const match = /^(\d+)\t(.+\.ts)$/.exec(line);
    if (match) rows.push({ lines: Number(match[1]), name: match[2] });
  }
  return rows;
}

/** fs 重算行数：与 scripts/lib-index.ts 同口径（UTF-8 物理行，末尾换行不额外算一行）。 */
function linesOnDisk(fileName: string): number {
  const text = fs.readFileSync(path.join(LIB_DIR, fileName), 'utf8');
  if (text === '') return 0;
  const parts = text.split('\n');
  return text.endsWith('\n') ? parts.length - 1 : parts.length;
}

/** src/lib 根目录下全部 `*.ts`（不递归），按文件名排序。 */
function filesOnDisk(): string[] {
  return fs
    .readdirSync(LIB_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .map((entry) => entry.name)
    .sort();
}

describe('docs/src-lib-index.md：生成物与磁盘对账', () => {
  it('磁盘上的索引就是脚本的当前输出（不一致 → 跑 npm run lib:index，勿手改）', () => {
    const generated = buildLibIndexMarkdown();
    const onDisk = fs.readFileSync(INDEX_PATH, 'utf8');
    expect(
      onDisk,
      'docs/src-lib-index.md 与 src/lib 当前状态不一致 —— 跑 npm run lib:index 重新生成（生成物不要手改）'
    ).toBe(generated);
  });

  it('H1 与 docs-catalog 登记的标题一致', () => {
    const firstLine = buildLibIndexMarkdown().split('\n')[0];
    expect(firstLine).toBe(INDEX_H1);
    expect(INDEX_H1).toBe('# src/lib 根目录索引');
  });

  it('生成物是 UTF-8 无 BOM、LF 换行、以换行结尾', () => {
    const onDisk = fs.readFileSync(INDEX_PATH, 'utf8');
    expect(onDisk.startsWith('\uFEFF'), '索引不能带 BOM').toBe(false);
    expect(onDisk.includes('\r'), '索引必须用 LF（避免 Windows 换行污染 diff）').toBe(false);
    expect(onDisk.endsWith('\n'), '索引末尾要有一个换行').toBe(true);
  });

  it('表格恰好覆盖 src/lib 根目录全部 *.ts（多一个少一个都报）', () => {
    const disk = filesOnDisk();
    // 根目录文件数基线：2026-11 时 146 个。真的增减文件时，这里和索引一起改。
    expect(disk.length, 'src/lib 根目录 .ts 数量变了（基线 146）').toBe(146);

    const rows = tableRows(buildLibIndexMarkdown());
    expect(
      rows.map((row) => row.file),
      '索引表格的文件名集合与 src/lib 根目录的 *.ts 不一致（不递归子目录）'
    ).toEqual(disk);
    expect(rows.length, '表格行数应等于根目录 .ts 数量').toBe(disk.length);
  });

  it('每行行数都与 fs 重算一致（含空行）', () => {
    const rows = tableRows(buildLibIndexMarkdown());
    const wrong = rows
      .filter((row) => row.lines !== linesOnDisk(row.file))
      .map((row) => `${row.file}: 表里 ${row.lines} / 磁盘 ${linesOnDisk(row.file)}`);
    expect(wrong, `索引行数与 fs 重算不一致：\n  ${wrong.join('\n  ')}`).toEqual([]);

    // 概览里的合计也要对得上
    const total = rows.reduce((sum, row) => sum + row.lines, 0);
    const markdown = buildLibIndexMarkdown();
    expect(markdown).toContain(`- 文件数：${rows.length}`);
    expect(markdown).toContain(`- 合计行数：${total}（含空行）`);
  });

  it('职责列都有内容且不超过上限（抽取逻辑不能产出空列/超长行）', () => {
    for (const entry of collectLibFiles()) {
      expect(entry.summary.trim().length, `${entry.name} 的职责为空`).toBeGreaterThan(0);
      expect(Array.from(entry.summary).length, `${entry.name} 的职责超过 ${RESPONSIBILITY_MAX} 字符`).toBeLessThanOrEqual(
        RESPONSIBILITY_MAX
      );
      expect(entry.summary.includes('\n'), `${entry.name} 的职责跨了多行，会切断表格`).toBe(false);
    }
  });
});

describe('--headers：长头注释报告', () => {
  it('非空、按头注释行数降序、覆盖当前头部最长的文件', () => {
    const entries = collectLibFiles();
    const report = buildHeaderReport(entries);
    expect(report.trim().length, '报告为空').toBeGreaterThan(0);

    const rows = reportRows(report);
    expect(rows.length, '报告里没有 `行数\\t文件名` 数据行').toBeGreaterThan(0);

    const counts = rows.map((row) => row.lines);
    expect(counts, '报告没有按头注释行数倒序').toEqual([...counts].sort((a, b) => b - a));
    expect(Math.min(...counts), '报告混进了未超过阈值的文件').toBeGreaterThan(HEADER_LINE_THRESHOLD);

    // 基线时最长的是 frame-service.ts（109 行）。头注释的背景被抽到 docs/ 后会自然变短，
    // 所以这里按**当前磁盘**重算最长项，不把文件名钉死（钉死会在抽取完成后制造假红）。
    const longest = [...entries].sort(
      (a, b) => b.headerLines - a.headerLines || a.name.localeCompare(b.name)
    )[0];
    expect(longest.headerLines).toBeGreaterThan(HEADER_LINE_THRESHOLD);
    expect(rows[0].name, '报告首行应是当前头注释最长的文件').toBe(longest.name);

    expect(report).toContain('按 docs/source-header-style.md 抽取背景到 docs/，改完 npm run lib:index');
  });
});

describe('职责抽取：规范行优先，没头注释的兜底', () => {
  it('有 `// <文件名> — <职责>` 时取规范行', () => {
    const sse = collectLibFiles().find((entry) => entry.name === 'sse.ts');
    expect(sse?.summary).toBe('SSE 传输契约的唯一出处（响应头 + 帧格式 + 重连/背压常量）');
  });

  it('头注释都没有时写占位文案（legacy-redirect.ts 就是这种）', () => {
    const legacy = collectLibFiles().find((entry) => entry.name === 'legacy-redirect.ts');
    expect(legacy?.summary).toBe('（文件头未注明职责）');
  });
});
