// ─────────────────────────────────────────────────────────────────────────────
// docs-xref.test.ts —— 静态检查：文档之间的交叉引用必须指得到
//
// 【为什么要有】本仓文档互指**不用 markdown 相对链接**，而用反引号路径：
//
//     `docs/architecture.md` §6.5 + `src/lib/rate-limit.ts` 的 `RULES`
//
// 这是刻意的（相对链接在目录重排时会静默失效）。代价是**没有任何东西校验它**：
// 这两种漂法都是全静默的 ——
//
//   · 路径漂：把 `cli.md` 改名成 `cli-reference.md`，全仓十几处指向它的引用
//     照旧渲染、照旧返回 200，只是读者点过去什么都没有。
//   · 段号漂：往 `deploy.md` §4 前面插一节，§4 后面的全部位移，
//     而 `README.md` 里「详见 `docs/deploy.md` §4」指向的就成了别的内容。
//     段号引用比路径**更脆** —— 加一节不需要改任何文件名。
//
// 【与既有守卫的分工】`guide-docs.test.ts` 管的是**运行时**资产：站内 4 个页面按文件名
// 读盘渲染 `docs/guide/` 下的 4 份文档。本测试管的是**另外**一半：文档与文档之间的普通
// 引用 —— 失效不会打到用户脸上，只会让下一个读文档的人走错路。
//
// 【扫描面】文档集 = `docs/**/*.md` + 根下 `README.md` / `CLAUDE.md`。
// **不含** `blog-export/` 与 `instance/` —— 那是文章与故事正文（站点内容，不是项目文档），
// 里面的路径是行文举例而非引用。
//
// 【解析规则】与读者的直觉一致：**先看引用所在目录，再回退到仓库根**。
// 于是 `docs/cli.md` 里的 `deploy.md` 是兄弟文件，`docs/deploy.md` 里的
// `../README.md` 是根下的 README。裸名一律按兄弟解析 —— 实测这覆盖了全仓所有引用
// （`docs/` 下的裸名 `CLAUDE.md` 会落到根，因为 `docs/CLAUDE.md` 不存在）。
// 两条基准同时命中**不同**文件时判为歧义并报错，**绝不静默挑一个** ——
// 静默挑错的引用比断链更难发现（`docs/deploy.md` 的裸 `README.md` 就撞上了
// 真实存在的 `docs/README.md`，已改成 `../README.md`）。
//
// 【不检查什么】文件内部的 `## N.` 自引用——段号少写一个点就猜错指向，猜测不如不猜。
// 只查带 `「」` 的标题引用：那是明确的书名号标题，不带的是行文说明
// （如 `§8（角色阶梯、四个 guard）`，括号里是**对那节的说明**而非那节的标题，
// 而 §8 的真实标题是「关键约定」——校验括号等于把说明钉死成标题）。
//
// 认不出来就抛，**绝不静默跳过** —— 守卫失效比没有守卫更糟（同 db-time-guard / guide-docs）。
// ─────────────────────────────────────────────────────────────────────────────

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');
const DOCS_DIR = path.join(ROOT, 'docs');
/** 文档集根的入口；`docs/` 下的靠递归拿到。 */
const ROOT_DOCS = ['README.md', 'CLAUDE.md'];

// 严格限定字符集，只认项目文档与源码路径。刻意**不**匹配含 `<>{}[]()` 的：
// `tests/unit/cli-{registry,guards,docs}.test.ts` 是花括号展开记号，
// `loadGuideHtml('xxx.md')` 是代码示例里的假路径 —— 它们本就不指向某个具体文件。
const RE_MD_TOKEN = /`([A-Za-z0-9_\-./一-龥]+\.md)`/g;

/** 一个段号：`6.4`、`6.4「标题」`、`五、命令清单`。`(?![\w])` 挡掉 `§2b` 被截成 `§2`。 */
const SEC = String.raw`(\d+(?:\.\d+)*|[一-龥]+、[一-龥A-Za-z0-9]+)(?![\w])(?:\s*「([^」]*)」)?`;

/** 裸段号：`§6.4「标题」`，用于不带路径的自引用。 */
const RE_BARE_SECTION = new RegExp(String.raw`§\s*` + SEC, 'g');

/** 链式引用里的一段：段号 + **紧随其后的分隔符**（链式是 `/`，其他情况捕获为空）。 */
const RE_LINK = /§[ \t]*(\d+(?:\.\d+)*|[一-龥]+、[一-龥A-Za-z0-9]+)(?![\w])(?:\s*「([^」]*)」)?([ \t]*\/[ \t]*|)/g;

/**
 * 从串首 `§` 开始扫出一段连续的段号引用（含链式 `§6/§13`），
 * 返回各段（段号, 标题）与覆盖到的结束下标（-1 表示串首不是段号）。
 *
 * 写成循环而不是一条正则，是因为**链的各段不能跨着匹配标题**：要取每段各自的
 * 「」标题，就不能让上一段的标题吃到下一段的 `§` 去。分隔符只认 `/`（本仓实测
 * 只有这一种链式写法），其余字符一律终止 —— 于是 `§6.4 + ` 这种写法里
 * 段号只归它自己，后面的内容不会顺手算进来。
 *
 * 每轮都要求**正好从 at 处**匹配（`m.index !== at` 即退出）：`RE_LINK` 的
 * 分隔符组可以匹配空串，若不校验，正则会在 at 匹配失败后自行往后找到下一个
 * `§`，把两段不相干的段号串成一条链。
 */
function scanSectionChain(s: string): { refs: [string, string][]; end: number } {
  const refs: [string, string][] = [];
  let at = 0;
  for (;;) {
    RE_LINK.lastIndex = at;
    const m = RE_LINK.exec(s);
    if (!m || m.index !== at) break;
    refs.push([m[1], m[2] ?? '']);
    if (m[3].trim() === '') return { refs, end: m.index + m[0].length }; // 分隔符为空 → 链到头
    at = m.index + m[0].length; // 停在分隔符（`/`）之后，下一轮由 `§` 起头
  }
  return { refs, end: refs.length ? at : -1 };
}

/**
 * 去掉 ``` 围栏内的行（**含围栏行本身**），避免把代码示例里的假路径当成引用。
 *
 * 只剥围栏、不剥行内 —— 与 guide-docs / db-time-guard 同一套保守做法：行内剥离需要
 * 正确识别嵌套反引号，剥错了会把真引用一起吞掉。本仓引用**全部**写在行内反引号里。
 */
function stripCodeFences(src: string): string {
  const out: string[] = [];
  let inFence = false;
  for (const line of src.split('\n')) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (!inFence) out.push(line);
  }
  return out.join('\n');
}

// ── 每份文档的标题索引 ────────────────────────────────────────────────────────

interface Heading {
  /** 段号（`6.4` / `五、`），无编号的标题为 null。 */
  key: string | null;
  text: string;
}

const FILE_INDEX = new Map<string, Heading[]>();

/**
 * 扫一份文档的标题。**同样剥围栏** —— 否则给读者看的示例代码里
 * 一个 `## 4. 假的` 会凭空造出一节，让指向它的引用假装成立。
 */
function indexOf(file: string): Heading[] {
  let idx = FILE_INDEX.get(file);
  if (idx) return idx;
  idx = [];
  if (fs.existsSync(file)) {
    const lines = stripCodeFences(fs.readFileSync(file, 'utf-8')).split('\n');
    for (const line of lines) {
      const m = /^#{1,6}\s+(.+?)\s*$/.exec(line);
      if (!m) continue;
      const text = m[1];
      // 编号紧贴标题（`6.4 CSRF 中间件` / `五、命令清单`），所以 `6.4` 不会误配 `6.40`
      const key = /^(\d+(?:\.\d+)*)[.\s、]/.exec(text)?.[1] ?? /^([一-龥]+、)/.exec(text)?.[1] ?? null;
      idx.push({ key, text });
    }
  }
  FILE_INDEX.set(file, idx);
  return idx;
}

/** 段号对应的标题；不存在返回空串（**不用哨兵字符串** —— 会被 `includes` 当成标题）。 */
function headingLabel(file: string, sec: string): string {
  return indexOf(file).find((h) => h.key === sec)?.text ?? '';
}

/** 递归收集文档集。 */
function collectDocs(): string[] {
  const out = ROOT_DOCS.map((r) => path.join(ROOT, r));
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.md')) out.push(p);
    }
  };
  walk(DOCS_DIR);
  return out;
}

/** 按解析规则列出候选绝对路径（已去重、只留存在的），并标出是否有歧义。 */
function candidates(raw: string, fromFile: string): { path: string | null; ambiguous: boolean } {
  const sibling = path.resolve(path.dirname(fromFile), raw);
  const fallback = path.resolve(ROOT, raw);
  if (fs.existsSync(sibling)) {
    return { path: sibling, ambiguous: fallback !== sibling && fs.existsSync(fallback) };
  }
  if (fs.existsSync(fallback)) return { path: fallback, ambiguous: false };
  return { path: null, ambiguous: false };
}

const resolve = (raw: string, fromFile: string) => candidates(raw, fromFile).path;

interface Ref {
  from: string;
  raw: string;
  line: number;
  abs: string | null;
  ambiguous: boolean;
}
interface Anchor {
  from: string;
  raw: string;
  /** 被指向的文档，仓库根相对写法（如 `docs/deploy.md`）。 */
  target: string;
  sec: string;
  title: string;
  line: number;
}

/**
 * 解析**一行**。抽出来是为了可测 —— 下面两条自我守卫
 * 要用临时样本来逼出基线上走不到的分支。
 *
 * `hasSection` 用来判断裸 `§N` 是不是本文件的段号：**只有本文件真有这一节才算锚点**。
 * 没有它就是外部规范的引用（`RFC 6749 §4.1`、`scripts/smoke.mjs` §2b），
 * 不该被记成「本文件的 §4.1 不存在」。
 */
function parseLine(
  line: string,
  file: string,
  lineNo: number,
  hasSection: (sec: string) => boolean
): { refs: Ref[]; anchors: Anchor[] } {
  const refs: Ref[] = [];
  const anchors: Anchor[] = [];

  for (const m of line.matchAll(RE_MD_TOKEN)) {
    const raw = m[1];
    if (raw.startsWith('/') || raw.includes('://')) continue; // 绝对路径 / URL 不在此列
    const c = candidates(raw, file);
    refs.push({ from: file, raw, line: lineNo, abs: c.path, ambiguous: c.ambiguous });
  }

  // ① 带路径的段号。被认掉的部分（路径 + 其后紧邻的段号链）要挖空，
  //    免得 ② 把同一处又记成「本文件 §N」—— `/§13` 就是这么漏过去的。
  //    路径与 `§` 之间只容空白：`见 deploy.md，另见 §4` 里的 §4 该落回 ②。
  let masked = line;
  for (const m of line.matchAll(RE_MD_TOKEN)) {
    const after = line.slice(m.index! + m[0].length);
    const lead = /^[ \t]*/.exec(after)![0].length;
    if (!after.startsWith('§', lead)) continue;
    const { refs, end } = scanSectionChain(after.slice(lead));
    if (end < 0) continue;
    const start = m.index!;
    const stop = start + m[0].length + lead + end;
    masked = masked.slice(0, start) + ' '.repeat(stop - start) + masked.slice(stop);
    for (const [sec, title] of refs) {
      anchors.push({ from: file, raw: `\`${m[1]}\` §${sec}`, target: m[1], sec, title, line: lineNo });
    }
  }

  // ② 不带路径的段号：只有当本文件真有这一节时，才是在指它自己。
  for (const m of masked.matchAll(RE_BARE_SECTION)) {
    if (!hasSection(m[1])) continue;
    anchors.push({
      from: file,
      raw: `§${m[1]}`,
      target: path.relative(ROOT, file),
      sec: m[1],
      title: m[2] ?? '',
      line: lineNo,
    });
  }

  return { refs, anchors };
}

/** 解析全部文档。模块加载时跑一次。 */
function parseAll(): { docs: string[]; refs: Ref[]; anchors: Anchor[] } {
  const docs = collectDocs();
  const refs: Ref[] = [];
  const anchors: Anchor[] = [];

  for (const file of docs) {
    const lines = stripCodeFences(fs.readFileSync(file, 'utf-8')).split('\n');
    for (let i = 0; i < lines.length; i++) {
      const parsed = parseLine(lines[i], file, i + 1, (sec) => indexOf(file).some((h) => h.key === sec));
      refs.push(...parsed.refs);
      anchors.push(...parsed.anchors);
    }
  }
  return { docs, refs, anchors };
}

const { docs: DOCS, refs: REFS, anchors: ANCHORS } = parseAll();

describe('文档交叉引用', () => {
  it('扫到了文档（防止扫描逻辑悄悄失效）', () => {
    expect(DOCS.length).toBeGreaterThan(15);
    expect(REFS.length).toBeGreaterThan(30);
    expect(ANCHORS.length).toBeGreaterThan(10);
  });

  it('每个引用的路径都解析得到真实文件', () => {
    const broken = REFS.filter((r) => r.abs === null).map(
      (r) => `${path.relative(ROOT, r.from)}:${r.line} → \`${r.raw}\``
    );
    expect(broken, `这些文档引用了不存在的文件：\n  ${broken.join('\n  ')}`).toEqual([]);
  });

  it('裸名引用没有歧义（同目录与根下都有同名文件时必须写明路径）', () => {
    const ambiguous = REFS.filter((r) => r.ambiguous).map(
      (r) => `${path.relative(ROOT, r.from)}:${r.line} → \`${r.raw}\``
    );
    expect(
      ambiguous,
      `这些引用同时命中同目录与根下的两个不同文件，解析会静默挑一个：\n  ${ambiguous.join('\n  ')}`
    ).toEqual([]);
  });

  it('每个段号锚点在目标文档里真实存在', () => {
    const broken: string[] = [];
    for (const a of ANCHORS) {
      const target = resolve(a.target, a.from);
      if (!target) continue; // 路径本身不存在 —— 已由上面那条断言负责报
      if (headingLabel(target, a.sec)) continue;
      broken.push(
        `${path.relative(ROOT, a.from)}:${a.line} → \`${a.raw}\`，` +
          `而 ${path.relative(ROOT, target)} 没有 §${a.sec}`
      );
    }
    expect(
      broken,
      `这些段号指向的章节已不存在（多半是加/删了一节导致编号位移）：\n  ${broken.join('\n  ')}`
    ).toEqual([]);
  });

  it('「」里写明的标题确实出现在目标文档里', () => {
    const wrong: string[] = [];
    for (const a of ANCHORS) {
      if (!a.title) continue;
      const target = resolve(a.target, a.from);
      if (!target) continue;
      if (indexOf(target).some((h) => h.text.includes(a.title))) continue;
      wrong.push(
        `${path.relative(ROOT, a.from)}:${a.line} → \`${a.raw}\`，` +
          `但 ${path.relative(ROOT, target)} 里没有标题含「${a.title}」的章节`
      );
    }
    expect(wrong, `这些引用的标题与目标文档对不上：\n  ${wrong.join('\n  ')}`).toEqual([]);
  });

  // ── 下面两条是**测试自己的**守卫：上面几条的规则在基线数据上恰好走不到这些分支
  //    （裸 §N 全都跟在路径后面、代码示例全被围栏包着），哪天规则被改坏，
  //    上面的测试照样全绿。用临时样本把分支逼出来。
  it('链式段号 `§6/§13` 归被引文档，不残留成「本文件 §13」', () => {
    const file = path.join(ROOT, 'CLAUDE.md'); // 拿个真实文件当「本文件」
    const none = () => false;
    const parsed = parseLine('`docs/architecture.md` §6.4 与 `docs/deploy.md` §6/§13', file, 1, none);
    expect(parsed.anchors.map((a) => `${a.target}§${a.sec}`)).toEqual([
      'docs/architecture.md§6.4',
      'docs/deploy.md§6',
      'docs/deploy.md§13',
    ]);
  });

  it('裸 §N 只在「本文件真有这一节」时才算锚点', () => {
    const file = path.join(ROOT, 'CLAUDE.md');
    const has = (sec: string) => sec === '2.3';

    const own = parseLine('见 §2.3。', file, 1, has);
    expect(own.anchors.map((a) => `${a.target}§${a.sec}`)).toEqual(['CLAUDE.md§2.3']);

    // 外部规范（RFC / 别的仓库的脚本）写 §N 时本文件没有这一节 —— 不该记成断锚点
    const external = parseLine('`authorization_code`（RFC 6749 §4.1）', file, 1, has);
    expect(external.anchors).toEqual([]);
  });

  it('段号索引认得出编号，且不会把 6.4 误配到 6.40', () => {
    const probe = path.join(os.tmpdir(), 'raricy-xref-probe.md');
    try {
      fs.writeFileSync(probe, '# 探针\n\n## 2.3 真实存在的节\n\n## 6.40 干扰项\n');
      expect(headingLabel(probe, '2.3')).toContain('真实存在的节');
      expect(headingLabel(probe, '6.4')).toBe(''); // 前缀不算命中
      expect(headingLabel(probe, '9.9')).toBe('');
      expect(indexOf(probe).map((h) => h.text)).toContain('6.40 干扰项');
    } finally {
      fs.rmSync(probe, { force: true });
    }
  });

  it('围栏剥离生效：示例代码里的假路径不算引用', () => {
    expect(REFS.some((r) => r.raw === 'xxx.md')).toBe(false);
    expect(stripCodeFences(['a', '```', '`nope.md`', '```', 'b'].join('\n'))).toBe('a\nb');
  });
});
