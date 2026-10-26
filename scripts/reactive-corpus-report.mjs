#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// reactive-corpus-report.mjs — 存量语料静态风险报告的 CLI（P6）
//
// 只读、无网络、无默认数据源。必须显式给输入（`--input` / `--db`）与输出
// （`--out`），不会自己去读 `.env`、生产库或 `instance/`。
//
// 输入：
//   --input <file.json>    文档数组，或 `{ "documents": [...] }`
//   --input <file.jsonl>   每行一个文档（也接受 `{ "documents": [...] }` 行）
//   --db <sqlite path>     以 **只读** 方式打开，读 blogs/blog_contents 与
//                          clipboards/clip_text；按 `ignore` 过滤软删行。
//                          依赖 Node 内置 `node:sqlite`（Node >= 22.5，旧版本可能需要
//                          `--experimental-sqlite`）；不可用时明确报错，不退回 Prisma。
//   --out <file.json>      必填。报告只含 ID 与计数，不含正文 / 标题。
//
// 运行：`npm run reactive:corpus -- --input ... --out ...`
//       （脚本通过 tsx 直接 import TypeScript 扫描器，不要用裸 node 跑）。
// 退出码：0 成功；1 输入文档有校验错误（报告仍写出）；2 用法 / 读取 / 环境错误。
// ─────────────────────────────────────────────────────────────────────────────

import { readFile, writeFile, mkdir, realpath, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const USAGE = `用法：
  npm run reactive:corpus -- --input <file.json|file.jsonl> [--input ...] [--db <sqlite>] --out <report.json>

说明：
  · 至少需要一个 --input 或 --db；--out 必填。
  · 报告只包含文档 ID、种类与风险计数，不含正文或标题。
  · --db 以只读方式打开，不读取 .env，不使用 Prisma。`;

class UsageError extends Error {}
class InputError extends Error {}

async function existingIdentity(file) {
  try {
    return { real: await realpath(file), info: await stat(file) };
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

/** Output must never truncate any input, including an existing hard link or symlink. */
async function assertDistinctOutput(options) {
  const normalize = (file) => process.platform === 'win32' ? resolve(file).toLowerCase() : resolve(file);
  const output = await existingIdentity(options.out);
  for (const file of [...options.inputs, ...(options.db ? [options.db] : [])]) {
    const source = await existingIdentity(file);
    const samePath = normalize(file) === normalize(options.out);
    const sameRealPath = output && source && normalize(output.real) === normalize(source.real);
    const sameFile = output && source && output.info.dev === source.info.dev && output.info.ino === source.info.ino;
    if (samePath || sameRealPath || sameFile) throw new UsageError('--out 不能覆盖输入文件或数据库');
  }
}

function parseArgs(argv) {
  const options = { inputs: [], db: null, out: null, help: false };

  const valueOf = (index, flag) => {
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new UsageError(`${flag} 需要一个值`);
    }
    return value;
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg === '--input' || arg === '-i') {
      options.inputs.push(valueOf(index, arg));
      index += 1;
    } else if (arg.startsWith('--input=')) {
      const value = arg.slice('--input='.length);
      if (!value) throw new UsageError('--input 需要一个值');
      options.inputs.push(value);
    } else if (arg === '--db') {
      options.db = valueOf(index, arg);
      index += 1;
    } else if (arg.startsWith('--db=')) {
      options.db = arg.slice('--db='.length);
      if (!options.db) throw new UsageError('--db 需要一个值');
    } else if (arg === '--out' || arg === '-o') {
      options.out = valueOf(index, arg);
      index += 1;
    } else if (arg.startsWith('--out=')) {
      options.out = arg.slice('--out='.length);
      if (!options.out) throw new UsageError('--out 需要一个值');
    } else {
      throw new UsageError(`未知参数：${arg}`);
    }
  }

  if (options.help) return options;
  if (options.inputs.length === 0 && !options.db) {
    throw new UsageError('必须显式提供 --input 或 --db（不会默认读取生产库）');
  }
  if (!options.out) throw new UsageError('必须显式提供 --out');
  return options;
}

async function readInputFile(file) {
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    throw new InputError(`无法读取输入文件 ${file}：${error?.code ?? error?.message ?? error}`);
  }

  const lower = file.toLowerCase();
  if (lower.endsWith('.jsonl') || lower.endsWith('.ndjson')) {
    const documents = [];
    const errors = [];
    const lines = text.split(/\r?\n/);
    lines.forEach((line, lineIndex) => {
      if (line.trim().length === 0) return;
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch {
        errors.push({
          index: -1,
          code: 'invalid_json',
          detail: `第 ${lineIndex + 1} 行不是合法 JSON`,
        });
        return;
      }
      if (parsed && typeof parsed === 'object' && Array.isArray(parsed.documents)) {
        documents.push(...parsed.documents);
      } else {
        documents.push(parsed);
      }
    });
    return { documents, errors };
  }

  if (!lower.endsWith('.json')) {
    throw new InputError(`只支持 .json / .jsonl / .ndjson 输入：${file}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new InputError(`JSON 解析失败：${file}`);
  }
  if (Array.isArray(parsed)) return { documents: parsed, errors: [] };
  if (parsed && typeof parsed === 'object' && Array.isArray(parsed.documents)) {
    return { documents: parsed.documents, errors: [] };
  }
  throw new InputError(`JSON 输入必须是文档数组或 { documents: [...] }：${file}`);
}

function tableColumns(db, table) {
  try {
    return new Set(
      db.prepare(`PRAGMA table_info(${table})`).all().map((row) => String(row.name))
    );
  } catch {
    return new Set();
  }
}

function tableNames(db) {
  return new Set(
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => String(row.name))
  );
}

/**
 * 读 SQLite。只读、只碰 schema 里已有的正文表：
 *   blogs.blog_contents / clipboards.clip_text
 * 软删在现有实现里是 `ignore = 1`（这一列就是这两张表的删标记）；若库里有
 * `deleted_at` 列也一并过滤（不改表、不猜语义）。
 */
async function readDbDocuments(dbPath) {
  let sqlite;
  try {
    sqlite = await import('node:sqlite');
  } catch {
    throw new InputError(
      '当前 Node 无法加载 node:sqlite。需要 Node >= 22.5；若仍是实验阶段，请在启动时加 --experimental-sqlite。'
    );
  }
  const DatabaseSync = sqlite.DatabaseSync;
  if (typeof DatabaseSync !== 'function') {
    throw new InputError('node:sqlite 没有导出 DatabaseSync，无法只读扫描数据库。');
  }

  let db;
  try {
    db = new DatabaseSync(resolve(dbPath), { readOnly: true });
  } catch (error) {
    throw new InputError(
      `无法以只读方式打开数据库 ${dbPath}：${error?.message ?? error}`
    );
  }

  try {
    const tables = tableNames(db);
    const documents = [];

    const hasBlogs = tables.has('blog_contents') && tables.has('blogs');
    const hasClips = tables.has('clip_text') && tables.has('clipboards');
    const partialBlog = tables.has('blogs') !== tables.has('blog_contents');
    const partialClip = tables.has('clipboards') !== tables.has('clip_text');
    if (partialBlog || partialClip) {
      throw new InputError(
        '数据库里的正文表不完整（blogs/blog_contents 或 clipboards/clip_text 只缺一半），拒绝静默跳过。'
      );
    }
    if (!hasBlogs && !hasClips) {
      throw new InputError('数据库里没有 blogs/blog_contents 或 clipboards/clip_text 表。');
    }

    if (hasBlogs) {
      const contentColumns = tableColumns(db, 'blog_contents');
      const blogColumns = tableColumns(db, 'blogs');
      const formatExpr = contentColumns.has('format')
        ? 'bc.format AS format'
        : 'NULL AS format';
      const deletedFilter = blogColumns.has('deleted_at')
        ? ' AND b.deleted_at IS NULL'
        : '';
      const rows = db
        .prepare(
          `SELECT b.id AS id, ${formatExpr}, bc.content AS content
             FROM blogs b
             LEFT JOIN blog_contents bc ON bc.blog_id = b.id
            WHERE COALESCE(b.ignore, 0) = 0${deletedFilter}`
        )
        .all();
      for (const row of rows) {
        documents.push({
          id: row.id,
          kind: 'blog',
          content: row.content,
          ...(contentColumns.has('format') ? { format: row.format } : {}),
        });
      }
    }

    if (hasClips) {
      const contentColumns = tableColumns(db, 'clip_text');
      const clipColumns = tableColumns(db, 'clipboards');
      const formatExpr = contentColumns.has('format')
        ? 'ct.format AS format'
        : 'NULL AS format';
      const deletedFilter = clipColumns.has('deleted_at')
        ? ' AND c.deleted_at IS NULL'
        : '';
      const rows = db
        .prepare(
          `SELECT c.id AS id, ${formatExpr}, ct.content AS content
             FROM clipboards c
             LEFT JOIN clip_text ct ON ct.clip_id = c.id
            WHERE COALESCE(c.ignore, 0) = 0${deletedFilter}`
        )
        .all();
      for (const row of rows) {
        documents.push({
          id: row.id,
          kind: 'clipboard',
          content: row.content,
          ...(contentColumns.has('format') ? { format: row.format } : {}),
        });
      }
    }

    return documents;
  } finally {
    db.close();
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(USAGE);
    return;
  }
  await assertDistinctOutput(options);

  let corpus;
  try {
    corpus = await import('../src/lib/reactive/corpus.ts');
  } catch (error) {
    throw new InputError(
      `无法加载 TypeScript 扫描器（请用 npm run reactive:corpus，它会经 tsx 运行）：${error?.message ?? error}`
    );
  }
  const { nowForDb, isoWithOffset } = await import('../src/lib/db-time.ts');
  const scannedAt = isoWithOffset(nowForDb());
  if (!scannedAt) throw new InputError('无法取得站点时钟时间。');

  const rawDocuments = [];
  const inputErrors = [];
  for (const file of options.inputs) {
    const { documents, errors } = await readInputFile(file);
    rawDocuments.push(...documents);
    inputErrors.push(...errors);
  }
  if (options.db) {
    rawDocuments.push(...(await readDbDocuments(options.db)));
  }

  const { documents, errors } = corpus.validateCorpusDocuments(rawDocuments);
  const report = corpus.scanCorpusDocuments(documents, {
    scannedAt,
    errors: [...inputErrors, ...errors],
  });

  const outPath = resolve(options.out);
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

  const totals = report.totals;
  console.log(
    `已扫描 ${totals.documents} 篇（博客 ${totals.blogs} / 剪贴板 ${totals.clipboards}）。`
  );
  console.log(
    `需复核：软换行 ${totals.documentsWithSoftLineBreaks} / HTML ${totals.documentsWithHtml} / ` +
      `{{}} ${totals.documentsWithBraceExpressions} / 数学 ${totals.documentsWithMathReview} / ` +
      `引用 ${totals.documentsWithReferences} / 外链图 ${totals.documentsWithExternalImages}。`
  );
  console.log(`报告：${outPath}`);

  if (report.errors.length > 0) {
    console.error(`输入错误 ${report.errors.length} 条（详见报告 errors；没有静默丢文档）。`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[reactive:corpus] ${message}`);
  if (error instanceof UsageError) {
    console.error(USAGE);
    process.exitCode = 2;
  } else if (error instanceof InputError) {
    process.exitCode = 2;
  } else {
    process.exitCode = 1;
  }
});
