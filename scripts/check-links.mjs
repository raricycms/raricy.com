#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// check-links.mjs —— 静态检查「代码里写的地址，后端/页面是否真的存在」
//
// 【为什么需要】这类错 tsc 完全不管（href 和 fetch 的 URL 都只是字符串字面量），
// 单测也不管（单测直接 import service 函数，压根不经过路由与页面）。迁移过程中
// 已经因此漏掉三处，全是用户可见的功能断裂：
//   · 工具菜单把 5 个工具指回老站 Flask，而它们在 Next 侧早就实现好了
//   · 博客列表的「创建文章」按钮指向 /blog/upload_blog（Flask 老路径）→ 404
//   · /audit 列表的「详情」链接指向不存在的 /audit/[id] → 404，
//     连带让提交申诉的 API 成了没有入口的孤儿，用户根本无法申诉
//
// 三处都只有真点进去才会发现。这个脚本把「点一遍」变成 CI 能跑的东西。
//
// 用法：npm run check:links   （有问题时退出码 1）
//
// 【它查什么】
//   1. src/**/*.tsx 里的 href="/..."       → 必须存在对应的 page.tsx
//   2. src/**/*.{ts,tsx} 里的 "/api/..."   → 必须存在对应的 route.ts
//   3. 工具菜单不得出现指向老站的绝对 URL（Flask 一删就 404）
//
// 【它不查什么】动态拼出来的地址（`/blog/${slug}`）只能核对到路径形状，
// 拼错的 slug 值查不出来 —— 那是 E2E 的活。
// ─────────────────────────────────────────────────────────────────────────────

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP = path.join(ROOT, 'src', 'app');
const SRC = path.join(ROOT, 'src');

const red = (s) => `\x1b[31m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const bold = (s) => `\x1b[1m${s}\x1b[0m`;

/** Next 的约定式产物 / 静态资源 —— 没有 page.tsx 但确实可访问。 */
const SPECIAL = new Set(['/robots.txt', '/sitemap.xml']);
const IGNORED_PREFIXES = ['/static/', '/_next'];

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

/** 目录路径 → 路由形状：路由组 (x) 去掉，[id] / [...slug] 归一成 <x>。 */
function toRoute(absDir) {
  let r = '/' + path.relative(APP, absDir).split(path.sep).join('/');
  if (r === '/.') r = '/';
  r = r.replace(/\/\([^)]+\)/g, '');
  r = r.replace(/\[\.\.\.[^\]]+\]/g, '<x>').replace(/\[[^\]]+\]/g, '<x>');
  return r.replace(/\/$/, '') || '/';
}

const files = walk(APP);
const pages = new Set(files.filter((f) => f.endsWith('page.tsx')).map((f) => toRoute(path.dirname(f))));
const routes = new Set(files.filter((f) => f.endsWith('route.ts')).map((f) => toRoute(path.dirname(f))));

const srcFiles = walk(SRC).filter((f) => f.endsWith('.ts') || f.endsWith('.tsx'));

const problems = [];

/**
 * 去掉注释，但**不动字符串与模板串里的内容**。
 *
 * 【为什么必须先剥注释】检查是拿正则扫源码文本的，而注释里出现的路径长得和真代码
 * 一模一样。`forbidden.tsx` 里那句「这里曾经有个 <Link href="/logout">，已删除」
 * 就被当成了一条真的断链，长期挂在输出里 —— 一条永远修不掉的假阳性，恰恰是训练
 * 所有人无视这个脚本的最快方式（真问题混在同一条红字里，没人会再逐条看）。
 *
 * 【为什么自己做扫描而不是正则替换】行注释的两个斜杠也可能是 `https:` 的一半，
 * 块注释的起头也可能出现在字符串里。所以按字符走一遍状态机：进了引号就照抄到
 * 对应的收尾引号（含反斜杠转义），只有在引号之外才丢掉行注释直到行尾、以及
 * 块注释的起止标记之间的内容。
 * 正则字面量不单独处理 —— 本仓库的源码里没有以斜杠开头、看起来像注释的正则，
 * 真要出现了也只会漏掉一小段文本，不会造成新的假阴性方向的问题。
 */
function stripComments(txt) {
  let out = '';
  let i = 0;
  let quote = null; // null | "'" | '"' | '`'
  while (i < txt.length) {
    const ch = txt[i];
    const next = txt[i + 1];

    if (quote) {
      out += ch;
      if (ch === '\\') {
        out += next ?? ''; // 转义：连下一个字符一起照抄，别把它当成收尾引号
        i += 2;
        continue;
      }
      if (ch === quote) quote = null;
      i++;
      continue;
    }

    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      out += ch;
      i++;
      continue;
    }
    if (ch === '/' && next === '/') {
      while (i < txt.length && txt[i] !== '\n') i++;
      continue; // 换行本身留给下一轮，保住行号对齐（报错信息里不带行号，但便于肉眼比对）
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < txt.length && !(txt[i] === '*' && txt[i + 1] === '/')) i++;
      i += 2;
      continue;
    }

    out += ch;
    i++;
  }
  return out;
}

/**
 * 抽出源码里所有字符串/模板串的**内容**。
 *
 * 必须先整体取出再归一 ${...}，不能直接用 [^\s]* 之类去凑：
 * 模板串里的 ${(page - 1) * limit} 含空格与引号，按字符类匹配会直接漏掉 ——
 * /api/blogs/${id}/likers 当初就是这么从检查里溜走的。
 */
function stringLiterals(txt) {
  const out = [];
  // 模板串：` ... `（内部允许换行、空格、${}）
  for (const m of txt.matchAll(/`([^`\\]*(?:\\.[^`\\]*)*)`/g)) out.push(m[1]);
  // 普通串：'...' 与 "..."
  for (const m of txt.matchAll(/'([^'\\\n]*(?:\\.[^'\\\n]*)*)'/g)) out.push(m[1]);
  for (const m of txt.matchAll(/"([^"\\\n]*(?:\\.[^"\\\n]*)*)"/g)) out.push(m[1]);
  return out;
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
    const next = s.replace(/\$\{(?:[^{}]|\{[^{}]*\})*\}/g, '<x>');
    if (next === s) break;
    s = next;
  }
  return s.split('?')[0].split('#')[0].replace(/\/$/, '') || '/';
}

// ── 1. href → page ──────────────────────────────────────────────────────────
// 同时覆盖 JSX 的 href="..." 与对象字面量的 href: '...'（工具菜单用的是后者，
// 只认 href= 的话，那 5 个指回老站的工具链接一个都抓不到）。
// 按引号类型分开匹配，不能图省事写成 [`'"]([^`'"]*)[`'"] —— 模板串里常有引号
// （href={`/story/${path.lastIndexOf('/')}`}），那样会在内层引号处截断，
// 切出半截路径来误报。
const HREF_RE = /href\s*[=:]\s*\{?\s*(?:`([^`]*)`|'([^'\n]*)'|"([^"\n]*)")/g;
for (const f of srcFiles.filter((f) => f.endsWith('.tsx'))) {
  const txt = stripComments(fs.readFileSync(f, 'utf8'));
  for (const m of txt.matchAll(HREF_RE)) {
    const raw = m[1] ?? m[2] ?? m[3] ?? '';
    if (!raw.startsWith('/')) continue; // 绝对 URL 交给第 3 节
    const u = normalize(raw);
    if (SPECIAL.has(u) || u.startsWith('/api/') || IGNORED_PREFIXES.some((p) => u.startsWith(p))) continue;
    if (!pages.has(u)) {
      problems.push(`链接指向不存在的页面：${bold(u)}  ← ${path.relative(ROOT, f)}`);
    }
  }
}

// ── 2. /api/... → route ─────────────────────────────────────────────────────
// account-client 打的是**账户微服务**的 /api/v1/*，不是本应用的路由，跳过。
// middleware 的 '/api/:path*' 是 matcher 模式；robots 里的 '/api' 是 disallow 规则。
const API_SKIP = [/^\/api\/v1\//, /^\/api\/:/, /^\/api$/, /^\/api\/__/];
for (const f of srcFiles) {
  if (f.endsWith('account-client.ts') || f.endsWith('middleware.ts') || f.endsWith('robots.ts')) continue;
  const txt = stripComments(fs.readFileSync(f, 'utf8'));
  for (const lit of stringLiterals(txt)) {
    if (!lit.startsWith('/api/')) continue;
    const u = normalize(lit);
    if (API_SKIP.some((re) => re.test(u))) continue;
    if (!routes.has(u)) {
      problems.push(`调用不存在的 API：${bold(u)}  ← ${path.relative(ROOT, f)}`);
    }
  }
}

// ── 3. 不得回源老站 ──────────────────────────────────────────────────────────
// Flask 删掉之后这些链接会直接 404。工具菜单曾经就是这么把 5 个工具指回老站的。
// 只拦「回源本站老路径」，外站链接（GitHub、智慧河 zhh.raricy.com 等）是正常的。
const BACKLINK = /(?:^|\/\/)(?:www\.)?raricy\.com\/(tool|blog|auth|image|vote|clipboard|checkin)\b/;
for (const f of srcFiles) {
  const txt = stripComments(fs.readFileSync(f, 'utf8'));
  if (/FLASK_ORIGIN/.test(txt)) {
    problems.push(
      `还在用 FLASK_ORIGIN 回源老站：${path.relative(ROOT, f)}（Flask 删掉后必断）`
    );
  }
  for (const lit of stringLiterals(txt)) {
    if (BACKLINK.test(lit)) {
      problems.push(`疑似回源老站（Flask 删掉后会 404）：${bold(lit)}  ← ${path.relative(ROOT, f)}`);
    }
  }
}

// ── 4. 图标类必须有定义 ──────────────────────────────────────────────────────
// 图标靠 CSS 的 mask-image 上色，类名拼错不会报错，只会渲染成一个**纯黑方块**。
// 联系页就这么顶着个黑方块：代码写 .icon-chat-dots，而 CSS 里叫 .icon-chat-dots_new。
// 只查 icon-*：其余类名与 Flask 不对应属正常，拿「Flask 有而 Next 没有」当错报
// 会淹没真问题。
{
  // 样式统一由 src/styles-scss/ 编译到 compiled/flask.css，layout.tsx 直接导入。
  // 旧路径 src/app/rebuild.css / globals.css / public/static/css/legacy.css 已随迁移删除 ——
  // 本检查曾长期指向它们，于是 cssText 恒为空，**每一个** icon-* 都被报成「无定义」，
  // 24 条假阳性把真问题（下面那条断链）淹了。tests/unit/css-classes.test.ts 是同一条
  // 检查的孪生实现，读的是同一个编译产物 —— 改这里记得对照那边。
  const cssText = ['src/styles-scss/compiled/flask.css']
    .map((f) => {
      const p = path.join(ROOT, f);
      return fs.existsSync(p) ? stripComments(fs.readFileSync(p, 'utf8')) : '';
    })
    .join('\n');
  // 组件内联的 <style>{X_CSS}</style> 也算 —— ATAMAS 整个游戏就是这么上样式的
  const inlineCss = srcFiles.map((f) => stripComments(fs.readFileSync(f, 'utf8'))).join('\n');
  const allCss = cssText + '\n' + inlineCss;

  const seen = new Set();
  for (const f of srcFiles.filter((f) => f.endsWith('.tsx'))) {
    const txt = stripComments(fs.readFileSync(f, 'utf8'));
    for (const m of txt.matchAll(/className=[{]?\s*[`'"]([^`'"]*)[`'"]/g)) {
      for (const cls of m[1].split(/\s+/)) {
        if (!/^icon-[\w-]+$/.test(cls) || seen.has(cls)) continue;
        seen.add(cls);
        if (!new RegExp('\\.' + cls.replace(/[-]/g, '\\-') + '(?![\\w-])').test(allCss)) {
          problems.push(
            `图标类无定义（会渲染成黑方块）：${bold('.' + cls)}  ← ${path.relative(ROOT, f)}`
          );
        }
      }
    }
  }
}

console.log(bold('\n═══ 链接与 API 可达性检查 ═══'));
console.log(`  页面 ${pages.size} 个 / API 路由 ${routes.size} 个\n`);

if (problems.length === 0) {
  console.log(green('  ✅ 没有断链\n'));
  process.exit(0);
}
for (const p of problems) console.log(`  ${red('✗')} ${p}`);
console.log(red(`\n  ${problems.length} 处问题\n`));
process.exit(1);
