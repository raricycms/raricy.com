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
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { dirname, resolve } from 'node:path';

const USAGE = `用法：
  npm run reactive:corpus -- --input <file.json|file.jsonl> [--input ...] [--db <sqlite>] --out <report.json> [--compile] [--limit N] [--chunk-size N] [--chunk-timeout-ms N]

说明：
  · 至少需要一个 --input 或 --db；--out 必填；输出不能覆盖输入 / 数据库。
  · 报告只包含文档 ID、种类与风险/编译计数，不含正文、标题或作者。
  · --db 以 node:sqlite 的 readOnly:true 打开；不使用 Prisma，避免写 WAL。
  · --compile 用站点统一 compat + 生产预算（50k）实际编译每篇，统计失败 / 回退 / 字面量降级；
    不展开业务引用（剪贴板 / 投票 / 收藏夹），引用边界另由静态扫描统计。
  · --limit N 只扫描前 N 篇（试跑用；报告 totals.limited=true）。
  · --compile 时默认按 --chunk-size 50 分批、每批 --chunk-timeout-ms 120000 独立子进程；
    单批超时会二分定位到单篇并以 site.scan.timeout 记失败，不把超时记成功。`;

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
  const options = {
    inputs: [], db: null, out: null, help: false, compile: false, limit: 0,
    chunkSize: 50, chunkTimeoutMs: 120_000, internalChild: false, stdin: false, scannedAt: null,
  };

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
    } else if (arg === '--compile') {
      options.compile = true;
    } else if (arg === '--limit') {
      options.limit = Number(valueOf(index, arg));
      index += 1;
    } else if (arg === '--chunk-size') {
      options.chunkSize = Number(valueOf(index, arg));
      index += 1;
    } else if (arg === '--chunk-timeout-ms') {
      options.chunkTimeoutMs = Number(valueOf(index, arg));
      index += 1;
    } else if (arg === '--internal-child') {
      options.internalChild = true;
    } else if (arg === '--stdin') {
      options.stdin = true;
    } else if (arg === '--scanned-at') {
      options.scannedAt = valueOf(index, arg);
      index += 1;
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

  if (options.help || options.internalChild) return options;
  if (options.inputs.length === 0 && !options.db) {
    throw new UsageError('必须显式提供 --input 或 --db（不会默认读取生产库）');
  }
  if (!options.out) throw new UsageError('必须显式提供 --out');
  if (!Number.isSafeInteger(options.chunkSize) || options.chunkSize < 1) {
    throw new UsageError('--chunk-size 必须是正整数');
  }
  if (!Number.isSafeInteger(options.chunkTimeoutMs) || options.chunkTimeoutMs < 1000) {
    throw new UsageError('--chunk-timeout-ms 必须 >= 1000');
  }
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
    // 用 createRequire 而不是动态 import：vite-node 会拦截 import('node:sqlite')，
    // 在已带 --experimental-sqlite 的进程里也报「无法加载」。
    sqlite = createRequire(import.meta.url)('node:sqlite');
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


const PROGRESS = (info) => {
  // 只写 ID / 类别 / 序号 / 耗时；不写正文、标题、作者。
  process.stderr.write(
    `[corpus] ${info.index}/${info.total} ${info.kind} ${info.id} ${info.elapsedMs}ms\n`
  );
};

async function loadCorpus() {
  try {
    return await import('../src/lib/reactive/corpus.ts');
  } catch (error) {
    throw new InputError(
      `无法加载 TypeScript 扫描器（请用 npm run reactive:corpus，它会经 vite-node 运行）：${error?.message ?? error}`
    );
  }
}

async function siteClock() {
  const { nowForDb, isoWithOffset } = await import('../src/lib/db-time.ts');
  const value = isoWithOffset(nowForDb());
  if (!value) throw new InputError('无法取得站点时钟时间。');
  return value;
}

/** 子进程：stdin 收一批文档，stdout 只输出报告，stderr 逐篇进度。 */
function runChild(chunk, scannedAt, timeoutMs) {
  const root = resolve('.');
  const script = resolve('scripts/reactive-corpus-report.mjs');
  const viteNode = resolve('node_modules/vite-node/vite-node.mjs');
  const args = [
    '--experimental-sqlite',
    viteNode,
    '--config',
    'vitest.config.ts',
    script,
    '--internal-child',
    '--stdin',
    '--scanned-at',
    scannedAt,
    '--compile',
  ];
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, args, {
      cwd: root,
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let timedOut = false;
    let finished = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 2000).unref?.();
    }, timeoutMs);
    child.stdout.on('data', (data) => { stdout += data.toString(); });
    child.stderr.on('data', (data) => { process.stderr.write(data); });
    child.on('error', () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolvePromise({ report: null, timedOut, code: null });
    });
    child.on('close', (code) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      let report = null;
      if (!timedOut && stdout.trim()) {
        try {
          report = JSON.parse(stdout.slice(stdout.indexOf('{')));
        } catch {
          report = null;
        }
      }
      resolvePromise({ report, timedOut, code });
    });
    child.stdin.end(JSON.stringify({ documents: chunk, errors: [] }));
  });
}

function failedSingle(corpus, document, code) {
  return corpus.failedCorpusScan(document, new Error(code), true, code);
}

async function scanChunked(corpus, documents, scannedAt, errors, options) {
  const scans = [];
  const collectedErrors = [...errors];
  let compiler = null;
  const merge = (report) => {
    if (!report) return;
    compiler = report.compiler ?? compiler;
    scans.push(...report.documents);
    collectedErrors.push(...(report.errors ?? []));
  };

  const processChunk = async (chunk, depth) => {
    if (chunk.length === 0) return;
    const first = chunk[0].id;
    const last = chunk[chunk.length - 1].id;
    process.stderr.write(
      `[corpus] chunk n=${chunk.length} ${first}..${last}${depth > 0 ? ` split=${depth}` : ''}\n`
    );
    const { report, timedOut } = await runChild(chunk, scannedAt, options.chunkTimeoutMs);
    if (report) {
      merge(report);
      return;
    }
    if (chunk.length === 1) {
      // 不把超时 / 子进程崩溃记成功：单篇失败有 ID、类别与诊断码。
      // 也不再塞进 `errors` —— 那是输入错误的账，混进来会把单篇扫描失败
      // 误报成「输入有问题」。scanFailures 已经单独计数并以退出码 1 收口。
      scans.push(failedSingle(corpus, chunk[0], timedOut ? 'site.scan.timeout' : 'site.scan.child-failed'));
      return;
    }
    const mid = Math.ceil(chunk.length / 2);
    await processChunk(chunk.slice(0, mid), depth + 1);
    await processChunk(chunk.slice(mid), depth + 1);
  };

  for (let index = 0; index < documents.length; index += options.chunkSize) {
    await processChunk(documents.slice(index, index + options.chunkSize), 0);
  }

  const totals = corpus.buildCorpusTotals(scans, collectedErrors.length);
  return {
    schemaVersion: corpus.CORPUS_SCAN_SCHEMA_VERSION,
    generator: 'reactive-corpus-full-scan',
    provisional: false,
    compile: 'run',
    compiler,
    textDiff: 'not-run',
    scannedAt,
    totals,
    documents: scans,
    errors: collectedErrors,
  };
}

function summarizeCompile(report) {
  if (!report.compile) return;
  const results = report.documents.map((document) => document.compileResult);
  report.totals.compile = {
    ok: results.filter((item) => item?.status === 'ok').length,
    fallback: results.filter((item) => item?.status === 'fallback').length,
    failed: results.filter((item) => item?.status === 'failed').length,
    literalized: results.filter((item) => item?.literalized).length,
    formatMismatch: results.filter((item) => item?.formatMismatch).length,
    scanFailures: report.totals.scanFailures,
    byCode: Object.fromEntries(
      [...new Set(results.flatMap((item) => item?.codes ?? []))]
        .sort()
        .map((code) => [code, results.filter((item) => item?.codes.includes(code)).length])
    ),
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(USAGE);
    return;
  }
  const corpus = await loadCorpus();

  // ── 子进程模式：只扫一批，stdout 只放报告 ──────────────────────────────────
  if (options.internalChild) {
    if (!options.stdin) throw new InputError('子进程模式必须用 --stdin');
    const raw = readFileSync(0, 'utf8');
    const parsed = JSON.parse(raw);
    const { documents, errors } = corpus.validateCorpusDocuments(parsed.documents ?? []);
    const scannedAt = options.scannedAt ?? (await siteClock());
    const report = corpus.scanCorpusDocuments(documents, {
      scannedAt,
      errors: [...(parsed.errors ?? []), ...errors],
      compile: options.compile,
      onProgress: PROGRESS,
    });
    process.stdout.write(`${JSON.stringify(report)}\n`);
    if (report.totals.scanFailures > 0) process.exitCode = 1;
    return;
  }

  await assertDistinctOutput(options);
  const scannedAt = await siteClock();

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
  const limited = options.limit > 0 ? documents.slice(0, options.limit) : documents;
  const allErrors = [...inputErrors, ...errors];

  const report =
    options.compile && limited.length > 0
      ? await scanChunked(corpus, limited, scannedAt, allErrors, options)
      : corpus.scanCorpusDocuments(limited, {
          scannedAt,
          errors: allErrors,
          compile: options.compile,
          onProgress: options.compile ? PROGRESS : undefined,
        });
  report.totals.limited = options.limit > 0;
  if (options.compile) summarizeCompile(report);

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
  if (options.compile) {
    const compiled = report.totals.compile;
    console.log(
      `编译：成功 ${compiled.ok} / 语义回退 ${compiled.fallback} / 失败 ${compiled.failed} / ` +
        `字面量降级 ${compiled.literalized} / 格式不匹配 ${compiled.formatMismatch} / ` +
        `扫描异常 ${compiled.scanFailures}。`
    );
  }
  console.log(`报告：${outPath}`);

  if (totals.scanFailures > 0) {
    console.error(`逐篇扫描/编译失败 ${totals.scanFailures} 篇（见报告 scanError / codes；不含正文）。`);
    process.exitCode = 1;
  }
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
