#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// check-links.mjs —— 静态检查「代码里写的地址，后端/页面是否真的存在」
//
// 【为什么需要】这类错 tsc 完全不管（href 和 fetch 的 URL 都只是字符串字面量），
// 单测也不管（单测直接 import service 函数，压根不经过路由与页面）。迁移过程中
// 已经因此漏掉三处，全是用户可见的功能断裂：
//   · 工具菜单的 5 个工具用了写死主机名的绝对 URL，而它们在本站早就实现好了
//   · 博客列表的「创建文章」按钮指向 /blog/upload_blog（已废弃的老路径）→ 404
//   · /audit 列表的「详情」链接指向不存在的 /audit/[id] → 404，
//     连带让提交申诉的 API 成了没有入口的孤儿，用户根本无法申诉
//
// 三处都只有真点进去才会发现。这个脚本把「点一遍」变成 CI 能跑的东西。
//
// 用法：npm run check:links   （有问题时退出码 1）
//       node scripts/check-links.mjs --self-test   （黄金样本自测：该报的报、不该报的不报）
//
// 【它查什么】
//   1. src/**/*.tsx 里的 href="/..."       → 必须存在对应的 page.tsx
//   2. src/**/*.{ts,tsx} 里的 "/api/..."   → 必须存在对应的 route.ts
//   3. 代码里不得把 raricy.com 的老路径写成要请求的绝对 URL（会 404）
//
// 【它不查什么】动态拼出来的地址（`/blog/${slug}`）只能核对到路径形状，
// 拼错的 slug 值查不出来 —— 那是 E2E 的活。
//
// ── 2026-11 修掉的 5 类假阳性（修前实跑 17 条、全部是假阳）───────────────
//   ① 动态段：路由侧的 [id]/[...slug] 以前只归一成字面 <x>，字面候选
//      （href="/game/collections/test"）永远匹配不上 → 改成「候选段 vs 路由段」
//      双向匹配（任一侧是动态段即相容），catch-all 单独按「一段以上」处理。
//   ② 模板值：`/api/daily-quotes/${id}/${kind}` 归一成 <x>/<x>，而路由是
//      [id]/favorite → 段级匹配即可通过。
//   ③ 嵌套模板串：`/api/fish/tokens${beforeId ? `?before_id=${beforeId}` : ''}`
//      以前被正则截断成 `/api/fish/tokens${beforeId` → 改成真正的字符扫描器，
//      模板串里的 ${...} 一律替换成占位、嵌套反引号照常吞掉。
//   ④ 前缀常量：`'/api/avatar/'`（结尾斜杠）剥尾斜杠后变成不可达的父路径
//      → 原始字面量以 / 结尾时按「目录前缀」判定（命中任一更长的路由即通过）。
//   ⑤ §3 上下文：User-Agent 字符串里出现的 `https://raricy.com/tool/...` 被当成
//      回源老路径 → 只认「真实请求字面量」（href/src/fetch/open/redirect 等位置
//      上的字符串）与「本身就是绝对 URL 的常量」，不再扫任意字符串。
// ─────────────────────────────────────────────────────────────────────────────

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const red = (s) => `\x1b[31m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const bold = (s) => `\x1b[1m${s}\x1b[0m`;

/** Next 的约定式产物 / 静态资源 —— 没有 page.tsx 但确实可访问。 */
const SPECIAL = new Set(['/robots.txt', '/sitemap.xml']);
const IGNORED_PREFIXES = ['/static/', '/_next'];
/** 只跳过**不是本应用路由**的字符串（middleware matcher 与 robots disallow）。 */
const API_SKIP = [/^\/api\/:/, /^\/api$/];
/** 候选侧动态值的占位（源码里的 ${...} 归一成它）。 */
const DYNAMIC = '<x>';
/** §3 的请求位置：这些关键字后面的第一个字符串才是「会被请求的地址」。 */
const REQUEST_KEYWORDS = /\b(?:fetch|open|redirect|assign|replace|src|action|url|href)\s*[=:(]\s*/g;

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

// ── 路由模式 ────────────────────────────────────────────────────────────────
// 路由目录 → 段数组：路由组 `(x)` 丢掉；`[id]` → dyn；`[...slug]` → catch；
// `[[...slug]]` → opt-catch。保留原样而不是压成字面 <x>，这样字面候选也能匹配。
function routePattern(appDir, absDir) {
  const rel = path.relative(appDir, absDir).split(path.sep).join('/');
  return rel
    .split('/')
    .filter(Boolean)
    .filter((seg) => !/^\(.+\)$/.test(seg))
    .map((seg) => {
      if (/^\[\[\.\.\..+\]\]$/.test(seg)) return { kind: 'opt-catch' };
      if (/^\[\.\.\..+\]$/.test(seg)) return { kind: 'catch' };
      if (/^\[.+\]$/.test(seg)) return { kind: 'dyn' };
      return { kind: 'literal', value: seg };
    });
}

/** 候选路径 → 段数组（去掉首尾斜杠；保留空段以外的一切）。 */
function candidateSegments(routePath) {
  return routePath.split('/').filter(Boolean);
}

/** 候选段与路由段逐段匹配；catch / opt-catch 吃掉一段以上 / 零段以上。 */
function matchSegments(cand, route) {
  if (route.length === 0) return cand.length === 0;
  const [head, ...rest] = route;
  if (head.kind === 'catch' || head.kind === 'opt-catch') {
    const min = head.kind === 'catch' ? 1 : 0;
    for (let take = min; take <= cand.length; take++) {
      if (matchSegments(cand.slice(take), rest)) return true;
    }
    return false;
  }
  if (cand.length === 0) return false;
  const [first, ...candRest] = cand;
  if (head.kind === 'dyn') return matchSegments(candRest, rest);
  return (first === head.value || first === DYNAMIC) && matchSegments(candRest, rest);
}

function matchesAnyRoute(cand, patterns) {
  return patterns.some((route) => matchSegments(cand, route));
}

/**
 * 候选的等价写法：模板串里的插值既可能是路径段，也可能是「拼在段尾的查询串」
 * （`/api/fish/tokens${cond ? '?before_id=…' : ''}` → 归一后 `tokens<x>`）。
 * 静态上无法区分，所以两种解释都试：原样，以及去掉段尾的动态占位。
 */
function candidateVariants(u) {
  const segs = candidateSegments(u);
  const variants = [segs];
  const last = segs[segs.length - 1];
  if (last && last.length > DYNAMIC.length && last.endsWith(DYNAMIC)) {
    variants.push([...segs.slice(0, -1), last.slice(0, -DYNAMIC.length)]);
  }
  if (last === DYNAMIC && segs.length > 1) variants.push(segs.slice(0, -1));
  return variants;
}

function matchesCandidate(u, patterns, trailingSlash) {
  return candidateVariants(u).some((cand) =>
    trailingSlash ? matchesAsPrefix(cand, patterns) : matchesAnyRoute(cand, patterns)
  );
}

/**
 * 目录前缀判定：原始字面量以 `/` 结尾（如 '/api/avatar/'）时它表达的是「这个目录
 * 下的东西」，剥尾斜杠后不能当成一个必须存在的父路由。只要候选段是某条更长的路由
 * 模式的前缀就通过（`/api/avatar` 是 `/api/avatar/<x>` 的前缀）。
 */
function matchesAsPrefix(cand, patterns) {
  return patterns.some((route) => {
    if (route.length <= cand.length) return false;
    for (let i = 0; i < cand.length; i++) {
      const r = route[i];
      if (r.kind === 'dyn') continue;
      if (r.kind !== 'literal') return false;
      if (cand[i] !== r.value && cand[i] !== DYNAMIC) return false;
    }
    return true;
  });
}

// ── 源码扫描：剥注释 + 取字符串字面量 ───────────────────────────────────────
/**
 * 扫一遍源码，返回剥掉注释的文本。字符串与模板串**原样保留**（含内容），
 * 因为 href 正则还要在剥完注释的文本上跑。
 *
 * 为什么自己做状态机：行注释的两个斜杠也可能是 `https:` 的一半，块注释的起头
 * 也可能出现在字符串里。模板串的 `${...}` 里还能嵌套反引号与引号（本仓
 * FishApiClient 就有一处），所以模板模式要按花括号深度进「表达式模式」再回来。
 */
function stripComments(txt) {
  let out = '';
  let i = 0;
  const n = txt.length;
  const skipString = (quote) => {
    // 从开引号之后开始照抄，直到同种未转义引号；返回新的位置
    out += quote;
    i++;
    while (i < n) {
      const ch = txt[i];
      out += ch;
      if (ch === '\\') {
        out += txt[i + 1] ?? '';
        i += 2;
        continue;
      }
      i++;
      if (ch === quote) return;
    }
  };
  const skipTemplate = () => {
    out += '`';
    i++;
    while (i < n) {
      const ch = txt[i];
      if (ch === '\\') {
        out += ch + (txt[i + 1] ?? '');
        i += 2;
        continue;
      }
      if (ch === '`') {
        out += ch;
        i++;
        return;
      }
      if (ch === '$' && txt[i + 1] === '{') {
        // 表达式模式：按花括号深度照抄，期间允许字符串 / 嵌套模板 / 注释
        out += '${';
        i += 2;
        let depth = 1;
        while (i < n && depth > 0) {
          const c = txt[i];
          if (c === '{') {
            depth++;
            out += c;
            i++;
          } else if (c === '}') {
            depth--;
            out += c;
            i++;
          } else if (c === "'" || c === '"') {
            const q = txt[i];
            i++;
            out += q;
            while (i < n) {
              const cc = txt[i];
              out += cc;
              if (cc === '\\') {
                out += txt[i + 1] ?? '';
                i += 2;
                continue;
              }
              i++;
              if (cc === q) break;
            }
          } else if (c === '`') {
            // 嵌套模板串：为了不弄乱深度，整体跳过它的内容（其内部 ${} 不计入本层）
            i++;
            out += '`';
            while (i < n) {
              const cc = txt[i];
              if (cc === '\\') {
                out += cc + (txt[i + 1] ?? '');
                i += 2;
                continue;
              }
              out += cc;
              i++;
              if (cc === '`') break;
            }
          } else {
            out += c;
            i++;
          }
        }
        continue;
      }
      out += ch;
      i++;
    }
  };

  while (i < n) {
    const ch = txt[i];
    const next = txt[i + 1];
    if (ch === "'" || ch === '"') {
      skipString(ch);
      continue;
    }
    if (ch === '`') {
      skipTemplate();
      continue;
    }
    if (ch === '/' && next === '/') {
      while (i < n && txt[i] !== '\n') i++;
      continue; // 换行留给下一轮，保住行号对齐
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < n && !(txt[i] === '*' && txt[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/**
 * 从 pos 起读一个字符串 / 模板串，返回它的内容（${...} 已归成 `${}` 占位）。
 * 位置不是字符串时返回 null。模板串支持嵌套反引号。
 */
function readStringAt(txt, pos) {
  let i = pos;
  while (i < txt.length && /\s/.test(txt[i])) i++;
  const quote = txt[i];
  if (quote !== "'" && quote !== '"' && quote !== '`') return null;
  i++;
  let value = '';
  while (i < txt.length) {
    const ch = txt[i];
    if (ch === '\\') {
      value += ch + (txt[i + 1] ?? '');
      i += 2;
      continue;
    }
    if (ch === quote) return { value, end: i + 1 };
    if (quote === '`' && ch === '$' && txt[i + 1] === '{') {
      // 表达式整体替换成占位：路径形状不需要表达式内容。
      // 但「`/api/x${cond ? '?...' : ''}`」这类把查询串整段放进插值的写法，
      // 表达式以 ? / # 开头 —— 那一段不是路径段，替换成空串而不是 <x>。
      const exprStart = i + 2;
      i += 2;
      let depth = 1;
      while (i < txt.length && depth > 0) {
        const c = txt[i];
        if (c === '\\') {
          i += 2;
          continue;
        }
        if (c === "'" || c === '"' || c === '`') {
          const inner = readStringAt(txt, i);
          if (!inner) {
            i++;
            continue;
          }
          i = inner.end;
          continue;
        }
        if (c === '{') depth++;
        else if (c === '}') depth--;
        i++;
      }
      const expr = txt.slice(exprStart, Math.max(exprStart, i - 1)).trimStart();
      if (!/^[?#]/.test(expr)) value += '${}';
      continue;
    }
    value += ch;
    i++;
  }
  return null;
}

/**
 * 把 ${...} 归一成 <x>，剥掉查询串、锚点与末尾斜杠。
 *
 * ${} 里可能嵌套括号与引号（`/story/${path.slice(0, path.lastIndexOf('/'))}`），
 * 用 [^}]* 会在第一个 } 就断掉，切出半截路径来误报。故容忍一层嵌套花括号，
 * 并反复替换到稳定为止。
 */
function normalize(u) {
  let s = u;
  for (let i = 0; i < 5; i++) {
    const next = s.replace(/\$\{(?:[^{}]|\{[^{}]*\})*\}/g, DYNAMIC);
    if (next === s) break;
    s = next;
  }
  return s.split('?')[0].split('#')[0].replace(/\/$/, '') || '/';
}

/** 取所有 href 字面量（JSX 属性与对象键都认）。 */
function hrefLiterals(txt) {
  const out = [];
  for (const m of txt.matchAll(/href\s*[=:]\s*\{?\s*/g)) {
    const lit = readStringAt(txt, m.index + m[0].length);
    if (lit) out.push(lit.value);
  }
  return out;
}

/** 取「请求位置」上的字面量：href/src/action/url 与 fetch/open/redirect 等调用。 */
function requestLiterals(txt) {
  const out = [];
  for (const m of txt.matchAll(REQUEST_KEYWORDS)) {
    const lit = readStringAt(txt, m.index + m[0].length);
    if (lit) out.push(lit.value);
  }
  return out;
}

/** 取所有字符串 / 模板串的内容（§2 的 API 扫描与 §3 的常量判定用）。 */
function stringLiterals(txt) {
  const out = [];
  let i = 0;
  while (i < txt.length) {
    const ch = txt[i];
    if (ch === "'" || ch === '"' || ch === '`') {
      const lit = readStringAt(txt, i);
      if (!lit) break; // 未闭合：交给 HREF 正则那一侧兜底
      out.push(lit.value);
      i = lit.end;
      continue;
    }
    i++;
  }
  return out;
}

// ── 分析 ────────────────────────────────────────────────────────────────────
function analyze(root) {
  const APP = path.join(root, 'src', 'app');
  const SRC = path.join(root, 'src');

  const appFiles = walk(APP);
  const pagePatterns = appFiles
    .filter((f) => f.endsWith('page.tsx'))
    .map((f) => routePattern(APP, path.dirname(f)));
  const routePatterns = appFiles
    .filter((f) => f.endsWith('route.ts'))
    .map((f) => routePattern(APP, path.dirname(f)));
  const srcFiles = walk(SRC).filter((f) => f.endsWith('.ts') || f.endsWith('.tsx'));

  const problems = [];
  const rel = (f) => path.relative(root, f);

  // ── 1. href → page ────────────────────────────────────────────────────────
  for (const f of srcFiles.filter((f) => f.endsWith('.tsx'))) {
    for (const raw of hrefLiterals(stripComments(fs.readFileSync(f, 'utf8')))) {
      if (!raw.startsWith('/')) continue; // 绝对 URL 交给第 3 节
      const u = normalize(raw);
      if (SPECIAL.has(u) || u.startsWith('/api/') || IGNORED_PREFIXES.some((p) => u.startsWith(p))) continue;
      if (!matchesCandidate(u, pagePatterns, raw.endsWith('/'))) {
        problems.push(`链接指向不存在的页面：${bold(u)}  ← ${rel(f)}`);
      }
    }
  }

  // ── 2. /api/... → route ───────────────────────────────────────────────────
  // 跳过两处**不是调用点**的文件：middleware 的 matcher 与 robots 的规则。
  for (const f of srcFiles) {
    if (f.endsWith('middleware.ts') || f.endsWith('robots.ts')) continue;
    for (const lit of stringLiterals(stripComments(fs.readFileSync(f, 'utf8')))) {
      if (!lit.startsWith('/api/')) continue;
      const u = normalize(lit);
      if (API_SKIP.some((re) => re.test(u))) continue;
      if (!matchesCandidate(u, routePatterns, lit.endsWith('/'))) {
        problems.push(`调用不存在的 API：${bold(u)}  ← ${rel(f)}`);
      }
    }
  }

  // ── 3. 不得写死绝对 URL ───────────────────────────────────────────────────
  // 写死主机名的绝对 URL 会绕开站内路由，指向的老路径又已经不存在 —— 点了就是 404。
  // 工具菜单曾经就是这么把 5 个工具指出去的（而它们在本站早就实现好了）。
  //
  // 两种形态才算：①出现在真实请求位置上的字符串；②本身就是绝对 URL 的常量
  // （`const BASE = 'https://raricy.com/tool'`）。普通文本里出现的网址（例如
  // User-Agent 字符串里那句 `(+https://raricy.com/tool/dev/http-headers)`）不算 ——
  // 它不会被请求，误报只会训练大家无视这个脚本。
  const BACKLINK = /(?:^|\/\/)(?:www\.)?raricy\.com\/(tool|blog|auth|image|audio|vote|clipboard|checkin)\b/;
  const URL_START = /^(?:https?:)?\/\/(?:www\.)?raricy\.com\//;
  for (const f of srcFiles) {
    const txt = stripComments(fs.readFileSync(f, 'utf8'));
    if (/FLASK_ORIGIN/.test(txt)) {
      problems.push(`还在用 FLASK_ORIGIN 回源：${rel(f)}（该变量已废弃删除，回源必然失败）`);
    }
    const candidates = new Set([...requestLiterals(txt), ...stringLiterals(txt)]);
    for (const lit of candidates) {
      const trimmed = lit.trim();
      // ② 本身就是绝对 URL 的常量：整串就是 URL（无空白、以协议或 raricy.com 开头）
      const isPureUrl = !/\s/.test(trimmed) && URL_START.test(trimmed);
      // ① 请求位置上的字符串：由 requestLiterals 提供，要求里面出现 URL 形状
      const looksLikeUrl = /^(?:https?:)?\/\//.test(trimmed);
      if (!(isPureUrl || looksLikeUrl)) continue;
      if (BACKLINK.test(trimmed)) {
        problems.push(`疑似写死主机名的老路径（会 404）：${bold(trimmed)}  ← ${rel(f)}`);
      }
    }
  }

  return { problems, pages: pagePatterns.length, routes: routePatterns.length };
}

// ── 报告 ────────────────────────────────────────────────────────────────────
function report(result) {
  console.log(bold('\n═══ 链接与 API 可达性检查 ═══'));
  console.log(`  页面 ${result.pages} 个 / API 路由 ${result.routes} 个\n`);
  if (result.problems.length === 0) {
    console.log(green('  ✅ 没有断链\n'));
    return 0;
  }
  for (const p of result.problems) console.log(`  ${red('✗')} ${p}`);
  console.log(red(`\n  ${result.problems.length} 处问题\n`));
  return 1;
}

// ── 黄金样本自测 ────────────────────────────────────────────────────────────
/**
 * 在 %TEMP% 造一棵最小的 fixture 树（app + src），断言：
 *   · 不该报的形态（动态段命中、模板值、嵌套模板串、前缀常量、UA 文本）一条都不报
 *   · 该报的形态（不存在的页面 / 不存在的 API / 写死老路径 / FLASK_ORIGIN）一条不少
 * 这个自测存在的意义：本脚本修的是「匹配规则」，没有样本就只能靠下次线上事故验证。
 */
function selfTest() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'r3-check-links-'));
  const write = (p, content = '') => {
    const abs = path.join(root, p);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
  };
  try {
    // app 路由
    write('src/app/page.tsx', 'export default function Page() { return null; }');
    write('src/app/blog/[id]/page.tsx', 'export default function Page() { return null; }');
    write('src/app/game/collections/[...slug]/page.tsx', 'export default function Page() { return null; }');
    write('src/app/editor/(tools)/page.tsx', 'export default function Page() { return null; }');
    write('src/app/api/avatar/[id]/route.ts', 'export function GET() {}');
    write('src/app/api/frames/[key]/route.ts', 'export function GET() {}');
    write('src/app/api/daily-quotes/[id]/favorite/route.ts', 'export function POST() {}');
    write('src/app/api/daily-quotes/[id]/resonance/route.ts', 'export function POST() {}');
    write('src/app/api/fish/tokens/route.ts', 'export function GET() {}');

    // 不该报的
    write(
      'src/components/Good.tsx',
      [
        'export function Good() {',
        '  const id = "x";',
        '  return <a href="/blog/abc">a</a>;',
        '}',
        'export const R = <a href={`/blog/${id}`} />;',
        'export const C = <a href="/game/collections/test" />;',
        'export const D = <a href="/editor" />;',
        'void fetch(`/api/fish/tokens${id ? `?before_id=${id}` : ""}`);',
        'export const AVATAR_URL_PREFIX = "/api/avatar/";',
        'export const FRAME_URL_PREFIX = "/api/frames/";',
        'const UA = "raricy.com-dev-tools/1.0 (+https://raricy.com/tool/dev/http-headers)";',
        'export const E = <a href="/static/foo.png" />;',
        'export const F = <a href="/robots.txt" />;',
        'void fetch(`/api/daily-quotes/${id}/favorite`);',
        'console.log(UA);',
      ].join('\n')
    );

    // 该报的
    write(
      'src/components/Bad.tsx',
      [
        'export function Bad() {',
        '  return <a href="/no-such-page">b</a>;',
        '}',
        'void fetch("/api/nope");',
      ].join('\n')
    );
    write('src/lib/bad-url.ts', 'void fetch("https://raricy.com/tool/legacy");');
    write('src/lib/flask.ts', 'const o = FLASK_ORIGIN;');

    const result = analyze(root);
    const text = result.problems.join('\n');
    const expectPresent = ['/no-such-page', '/api/nope', 'https://raricy.com/tool/legacy', 'FLASK_ORIGIN'];
    const missing = expectPresent.filter((needle) => !text.includes(needle));
    const unexpected = result.problems.filter(
      (p) =>
        !expectPresent.some((needle) => p.includes(needle))
    );
    const ok = missing.length === 0 && unexpected.length === 0;
    if (ok) {
      console.log(green(`  ✅ 自测通过：${result.problems.length} 条该报的都报了，假阳性形态一条都没报`));
      return 0;
    }
    console.error(red('  ✗ 自测失败'));
    if (missing.length) console.error(`    少报了：${missing.join(', ')}`);
    for (const p of unexpected) console.error(`    多报了：${p}`);
    return 1;
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

if (process.argv.includes('--self-test')) {
  process.exit(selfTest());
}
process.exit(report(analyze(REPO_ROOT)));
