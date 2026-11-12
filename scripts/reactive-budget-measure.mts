// ─────────────────────────────────────────────────────────────────────────────
// reactive-budget-measure.mts — 节点 / 解析预算的**逐场景**实测入口（离线）
//
// 用法：
//   npm run reactive:measure -- --list
//   npm run reactive:measure -- --scenario poem-200k --budget 40000 --samples 5
//   npm run reactive:measure -- --run-all --out %TEMP%/reactive-measure.ndjson
//
// ⚠️ **一次进程只跑一个场景 / 一个预算**。这不是洁癖：200k 诗文 × 5 个预算 ×
// 多次采样放在一个进程里连续跑，实测会把 CPU 占满数分钟且不输出中间结果 ——
// 看起来像「卡死」，也拿不到任何可用数据。`--run-all` 由父进程逐个 spawn 子进程、
// 每个带超时，并把成功 / 拒绝 / 超时立即写进 NDJSON。
//
// 只生成匿名合成正文；不读数据库、不读 .env、不发网络请求。输出不含正文。
// ─────────────────────────────────────────────────────────────────────────────

import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { compileLocal, type LocalCompileOptions } from 'reactive-md';
import { REACTIVE_COMPILE_OPTIONS } from '../src/lib/reactive/host-components';
import { applyLegacyHtmlCompat } from '../src/lib/reactive/legacy-compat';

interface Scenario {
  name: string;
  source: string;
}

function paragraphs(chars: number): string {
  const out: string[] = [];
  let size = 0;
  let index = 0;
  while (size < chars) {
    const line = `第 ${index} 段，山风从远处吹来，灯笼在檐下轻轻晃动。`;
    out.push(line);
    size += line.length + 2;
    index += 1;
  }
  return out.join('\n\n');
}

function poem(chars: number): string {
  const stanzas: string[] = [];
  let size = 0;
  let index = 0;
  while (size < chars) {
    const stanza = [
      `## 第 ${index + 1} 节`,
      '',
      `> 夜色落在旧屋檐上，第 ${index} 次`,
      '',
      '**山风**吹过 _石阶_，一盏灯晃了又晃；',
      '',
      '- 远处的水声',
      '  - 更远处是雾',
      '  - 雾里有人归家',
      '',
      '```text',
      `夜里第 ${index} 次醒来`,
      '```',
      '',
    ].join('\n');
    stanzas.push(stanza);
    size += stanza.length;
    index += 1;
  }
  return stanzas.join('\n');
}

function denseInline(chars: number): string {
  const unit = '**加粗** _斜体_ ~~删除~~ [链接](https://example.com) `行内代码` $x+y$ ';
  return unit.repeat(Math.ceil(chars / unit.length)).slice(0, chars);
}

function table(rows: number): string {
  const lines = ['| 序号 | 名称 | 数量 | 备注 |', '| --- | --- | ---: | --- |'];
  for (let index = 0; index < rows; index += 1) {
    lines.push(`| ${index} | 条目 ${index} | ${index * 3} | 说明文字 ${index % 17} |`);
  }
  return lines.join('\n');
}

function nestedLists(depth: number): string {
  const lines: string[] = [];
  for (let level = 0; level < depth; level += 1) {
    lines.push(`${'  '.repeat(level)}- 第 ${level} 层`);
  }
  return lines.join('\n');
}

function components(count: number): string {
  const out: string[] = [];
  for (let index = 0; index < count; index += 1) {
    out.push(`<input bind="v${index}" label="参数 ${index}" initial="1" />`);
  }
  return out.join('\n\n');
}

function mixedLong(chars: number): string {
  const units = [
    '普通正文，带有 $x_1$ 公式与 [链接](https://example.com)。',
    '<div class="legacy" style="color:red">旧 HTML 正文</div>',
    '<TAB>教程占位</TAB>',
    '第二行紧接上一行。',
    '',
  ];
  const out: string[] = [];
  let size = 0;
  let index = 0;
  while (size < chars) {
    const unit = units[index % units.length];
    out.push(unit);
    size += unit.length + 1;
    index += 1;
  }
  return out.join('\n');
}

const SCENARIOS: readonly Scenario[] = [
  { name: 'mixed-200k', source: mixedLong(200_000) },
  { name: 'paragraphs-200k', source: paragraphs(200_000) },
  { name: 'poem-200k', source: poem(200_000) },
  { name: 'dense-inline-50k', source: denseInline(50_000) },
  { name: 'table-5000', source: table(5_000) },
  { name: 'nested-lists-300', source: nestedLists(300) },
  { name: 'components-2000', source: components(2_000) },
];

const CANDIDATE_BUDGETS = [15_000, 30_000, 40_000, 50_000] as const;

function findScenario(name: string): Scenario | undefined {
  return SCENARIOS.find((scenario) => scenario.name === name);
}

function optionsFor(budget: number): LocalCompileOptions {
  const base = REACTIVE_COMPILE_OPTIONS;
  return { ...base, limits: { ...base.limits, maxSyntaxNodes: budget } };
}

function median(values: number[]): number {
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.floor(ordered.length / 2)];
}

interface Row {
  scenario: string;
  characters: number;
  budget: number;
  status: 'ok' | 'rejected' | 'timeout' | 'error';
  nodes: number | null;
  codes: string[];
  firstMs: number | null;
  medianMs: number | null;
}

function parseArgs(argv: string[]) {
  const out = {
    scenario: '',
    budget: 0,
    samples: 3,
    runAll: false,
    out: '',
    list: false,
    timeoutMs: 45_000,
    compat: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = (): string => {
      const next = argv[index + 1];
      if (next === undefined) throw new Error(`${arg} 需要一个值`);
      index += 1;
      return next;
    };
    if (arg === '--list') out.list = true;
    else if (arg === '--run-all') out.runAll = true;
    else if (arg === '--compat') out.compat = true;
    else if (arg === '--scenario') out.scenario = value();
    else if (arg === '--budget') out.budget = Number(value());
    else if (arg === '--samples') out.samples = Math.max(1, Math.min(9, Number(value())));
    else if (arg === '--out') out.out = value();
    else if (arg === '--timeout-ms') out.timeoutMs = Number(value());
    else throw new Error(`未知参数：${arg}`);
  }
  return out;
}

function measureOne(scenario: Scenario, budget: number, samples: number): Row {
  const options = optionsFor(budget);
  const run = (): { ms: number; ok: boolean; nodes: number | null; codes: string[] } => {
    const start = performance.now();
    const result = compileLocal(scenario.source, options);
    return {
      ms: Math.round((performance.now() - start) * 100) / 100,
      ok: result.ok,
      nodes: result.ok ? result.document.nodes.length : null,
      codes: [...new Set(result.diagnostics.map((diagnostic) => diagnostic.code))].slice(0, 10),
    };
  };
  const first = run();
  if (!first.ok) {
    return {
      scenario: scenario.name,
      characters: scenario.source.length,
      budget,
      status: 'rejected',
      nodes: null,
      codes: first.codes,
      firstMs: first.ms,
      medianMs: null,
    };
  }
  // 预热一次，再取中位数；不重复跑被预算直接拒绝的输入。
  run();
  const times: number[] = [];
  for (let index = 0; index < samples; index += 1) times.push(run().ms);
  return {
    scenario: scenario.name,
    characters: scenario.source.length,
    budget,
    status: 'ok',
    nodes: first.nodes,
    codes: first.codes,
    firstMs: first.ms,
    medianMs: median(times),
  };
}

function runChild(args: string[]): Row {
  const script = resolve(import.meta.dirname, 'reactive-budget-measure.mts');
  const result = spawnSync(
    process.platform === 'win32' ? 'npx.cmd' : 'npx',
    ['vite-node', '--config', 'vitest.config.ts', script, ...args],
    {
      cwd: resolve(import.meta.dirname, '..'),
      encoding: 'utf8',
      timeout: Number(args[args.indexOf('--timeout-ms') + 1]) || 45_000,
      shell: process.platform === 'win32',
      windowsHide: true,
    }
  );
  if (result.error && (result.error as NodeJS.ErrnoException).code === 'ETIMEDOUT') {
    return {
      scenario: args[args.indexOf('--scenario') + 1] ?? 'unknown',
      characters: 0,
      budget: Number(args[args.indexOf('--budget') + 1]) || 0,
      status: 'timeout',
      nodes: null,
      codes: [],
      firstMs: null,
      medianMs: null,
    };
  }
  const lines = (result.stdout ?? '').trim().split(/\r?\n/).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      return JSON.parse(lines[index]) as Row;
    } catch {
      // 继续找上一行（tsx 偶尔会打 warnings）。
    }
  }
  return {
    scenario: args[args.indexOf('--scenario') + 1] ?? 'unknown',
    characters: 0,
    budget: Number(args[args.indexOf('--budget') + 1]) || 0,
    status: 'error',
    nodes: null,
    codes: [(result.stderr ?? '').trim().slice(0, 300)],
    firstMs: null,
    medianMs: null,
  };
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (args.list) {
    for (const scenario of SCENARIOS) {
      console.log(`${scenario.name}\t${scenario.source.length} chars`);
    }
    return;
  }

  if (args.runAll) {
    if (!args.out) throw new Error('--run-all 需要 --out <ndjson>');
    mkdirSync(dirname(resolve(args.out)), { recursive: true });
    writeFileSync(args.out, '');
    for (const scenario of SCENARIOS) {
      for (const budget of CANDIDATE_BUDGETS) {
        const row = runChild([
          '--scenario', scenario.name,
          '--budget', String(budget),
          '--samples', String(args.samples),
          '--timeout-ms', String(args.timeoutMs),
        ]);
        appendFileSync(args.out, `${JSON.stringify(row)}\n`);
        console.log(JSON.stringify(row));
      }
    }
    return;
  }

  const scenario = findScenario(args.scenario);
  if (!scenario) throw new Error(`未知场景：${args.scenario}（用 --list 查看）`);
  if (args.compat) {
    const time = (): number => {
      const start = performance.now();
      applyLegacyHtmlCompat(scenario.source);
      return Math.round((performance.now() - start) * 100) / 100;
    };
    const first = time();
    const samples: number[] = [];
    for (let index = 0; index < Math.max(3, args.samples); index += 1) samples.push(time());
    console.log(JSON.stringify({
      scenario: scenario.name,
      characters: scenario.source.length,
      budget: 0,
      status: 'ok',
      nodes: null,
      codes: ['compat-main-thread'],
      firstMs: first,
      medianMs: median(samples),
    }));
    return;
  }
  if (!Number.isSafeInteger(args.budget) || args.budget < 1) {
    throw new Error('--budget 必须是正整数');
  }
  const row = measureOne(scenario, args.budget, args.samples);
  console.log(JSON.stringify(row));
}

main();
