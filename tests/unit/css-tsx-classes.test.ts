// ─────────────────────────────────────────────────────────────────────────────
// css-tsx-classes.test.ts —— 静态检查：.tsx / .ts 里写的类名，编译后的 CSS 里必须有定义
//
// 【为什么要有】两道老守卫都够不着这一片：
//   · css-classes.test.ts 只查 .tsx 的 `icon-*`（判据干净，其余一律不查）
//   · css-js-classes.test.ts 只查 public/static/js/ 里**运行时注入**的类名
//   · check-links.mjs §4 是 css-classes 那条的孪生，范围相同
// 于是「页面写了 className、样式却没跟过来」这一整类问题**没有任何东西会报警**：
// 构建不失败、tsc 管不着（类名是字符串）、e2e 只钉它自己那几个选择器。
//
// 2026-09-18 一次全量扫描扫出两批真实缺口，两批都符合这个形状：
//   · 收银台 /fish/pay：`.pay-quick*` / `.pay-amount__input` / `.pay-amount__error`
//     四个类写了、CSS 从未有过 —— 快捷金额那排落回浏览器默认按钮（灰底方角），
//     金额输入框从 24px 粗体掉成 14.4px 常规体，错误提示与正文同色。
//   · 剪贴板编辑器：`.clipboard-form__editor` 在 SCSS 里**写歪了嵌套层级**
//     （落进 `&__group` 里 → 编译成 `.clipboard-form__group__editor`），
//     一个 DOM 里不存在的选择器。规则一直在，只是没人能命中它。
//
// 【范围】src/ 下所有 .tsx / .ts 的 `className=` 与 HTML 串里的 `class=`。
// 取值方式对齐既有的两道守卫：**只认字面量**，模板串里的 `${…}` 整段剥掉。
// 动态拼出来的名字（`${prefix}__title`、`--${statusType}`）静态判不了，一律不查 ——
// 这类要么靠 e2e 钉，要么靠人眼，别在这里假装能验。
//
// 【白名单纪律】这类检查最大的风险是「噪音把真问题淹了」，所以不留隐式豁免：
// 每个无样式却要用到的类名都得在下面登记一行，并写清**为什么它可以没有样式**。
// 两条硬约束防止名单烂掉：
//   · CONSUMED 里的类名必须真的被某处的选择器消费（querySelector / locator / …），
//     否则测试转红 —— 「它是个 JS 钩子」这种话必须可验证
//     （`.article-checkbox` / `.toggle-featured` 曾经顶着这个名头躺在注释里，
//      实际全仓无人消费，已删）
//   · 名单里的类名一旦在 CSS 里有了定义也要转红 —— 提醒把这一行删掉
// ─────────────────────────────────────────────────────────────────────────────

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { compiledCss } from '../../scripts/compiled-css.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');
const SKIP_DIRS = new Set(['node_modules', '.next', '.git', 'compiled', 'test-results', 'instance', 'coverage']);

// ── 取值：CSS 侧 ────────────────────────────────────────────────────────────

/** 编译后的类名 + 组件内联 `<style>`（`const X_CSS = …` / `const X_STYLES = …`）里的类名。 */
function definedClasses(): Set<string> {
  const out = new Set(Array.from(compiledCss().matchAll(/\.([\w-]+)/g), (m) => m[1]));
  for (const f of walk(path.join(ROOT, 'src'), ['.tsx'])) {
    const txt = fs.readFileSync(f, 'utf8');
    for (const m of txt.matchAll(/const\s+\w*(?:_CSS|_STYLES)\w*\s*=\s*([\s\S]*?);\s*\n/g)) {
      for (const c of m[1].matchAll(/\.([\w-]+)/g)) out.add(c[1]);
    }
  }
  return out;
}

// ── 取值：源码侧 ────────────────────────────────────────────────────────────

function walk(dir: string, exts: string[], out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, exts, out);
    else if (exts.some((x) => e.name.endsWith(x))) out.push(p);
  }
  return out;
}

/**
 * 取出一段 JS 表达式里的字符串字面量片段：普通串整段，模板串按 `${…}` 切开
 * （切出来的每片都保证不含插值，可以直接按空白切词）。
 */
function literalsOf(src: string, out: string[] = []): string[] {
  // 先抹掉「拿来做比较 / 查找」的字符串 —— 它们是枚举值不是类名
  // （`a.status === 'pending'`、`queue.includes('text')`）。
  const s = src
    .replace(/['"][^'"]*['"]\s*(?:===|!==|==|!=)/g, ' ')
    .replace(/(?:===|!==|==|!=)\s*['"][^'"]*['"]/g, ' ')
    .replace(/\.(?:includes|indexOf|has|startsWith|endsWith)\(\s*['"][^'"]*['"]\s*\)/g, ' ');

  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '"' || ch === "'") {
      let j = i + 1, buf = '';
      while (j < s.length && s[j] !== ch) {
        if (s[j] === '\\') { buf += s[j + 1]; j += 2; continue; }
        buf += s[j]; j++;
      }
      out.push(buf); i = j;
    } else if (ch === '`') {
      let j = i + 1, buf = '';
      while (j < s.length && s[j] !== '`') {
        if (s[j] === '$' && s[j + 1] === '{') {
          out.push(buf); buf = '';
          let depth = 0;
          while (j < s.length) {
            if (s[j] === '{') depth++;
            else if (s[j] === '}') { depth--; if (depth === 0) { j++; break; } }
            else if (s[j] === '"' || s[j] === "'" || s[j] === '`') {
              const q = s[j]; j++;
              while (j < s.length && s[j] !== q) { if (s[j] === '\\') j++; j++; }
            }
            j++;
          }
          continue;
        }
        if (s[j] === '\\') { buf += s[j + 1]; j += 2; continue; }
        buf += s[j]; j++;
      }
      out.push(buf); i = j;
    }
  }
  return out;
}

/**
 * 扫出 `className=` / `class=` 的属性值（字符串、模板串、或 `{…}` 表达式，括号配对取全）。
 * `isExpr` 区分「值本身就是一串类名」与「值是一段要再解析的表达式」——
 * 前者直接按空白切词即可，后者得先抽字面量。
 */
function attrValues(txt: string): { text: string; isExpr: boolean }[] {
  const re = /(?:className|class)\s*=/g;
  const out: { text: string; isExpr: boolean }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(txt))) {
    let j = re.lastIndex;
    while (j < txt.length && /\s/.test(txt[j])) j++;
    const c = txt[j];
    if (c === '"' || c === "'" || c === '`') {
      let k = j + 1;
      while (k < txt.length && txt[k] !== c) { if (txt[k] === '\\') k++; k++; }
      out.push({ text: txt.slice(j + 1, k), isExpr: c === '`' });
      re.lastIndex = k + 1;
    } else if (c === '{') {
      let depth = 0, k = j;
      while (k < txt.length) {
        const ch = txt[k];
        if (ch === '{') depth++;
        else if (ch === '}') { depth--; if (depth === 0) break; }
        else if (ch === '"' || ch === "'" || ch === '`') {
          const q = ch; k++;
          while (k < txt.length && txt[k] !== q) { if (txt[k] === '\\') k++; k++; }
        }
        k++;
      }
      out.push({ text: txt.slice(j + 1, k), isExpr: true });
      re.lastIndex = k + 1;
    }
  }
  return out;
}

const CLASS_TOKEN = /^[a-zA-Z][\w-]*$/;

/** 从 src/ 里扫出「用到但可能没定义」的类名（名字 → 出现的文件）。 */
function usedClasses(): Map<string, Set<string>> {
  const used = new Map<string, Set<string>>();
  for (const f of walk(path.join(ROOT, 'src'), ['.tsx', '.ts'])) {
    const rel = path.relative(ROOT, f).replace(/\\/g, '/');
    for (const { text, isExpr } of attrValues(fs.readFileSync(f, 'utf8'))) {
      for (const lit of isExpr ? literalsOf(text) : [text]) {
        for (const raw of lit.split(/\s+/)) {
          // 收尾是 `-` / `_` 的是拼接前缀（`toast--`、`&__` 那类），不是完整类名
          if (!raw || !CLASS_TOKEN.test(raw) || /[-_]$/.test(raw)) continue;
          if (!used.has(raw)) used.set(raw, new Set());
          used.get(raw)!.add(rel);
        }
      }
    }
  }
  return used;
}

/** 在别处以**选择器实参**形态被消费的类名（e2e 的 locator、运行时的 querySelector…）。 */
function consumedClasses(): Set<string> {
  const out = new Set<string>();
  const PATTERNS = [
    /(?:querySelector(?:All)?|closest|matches|getElementsByClassName|locator|isVisible)\s*(?:<[^>]*>)?\s*\(\s*['"`]([^'"`]*)['"`]/g,
    /classList\.(?:add|remove|toggle|contains)\(\s*['"`]([^'"`]*)['"`]/g,
  ];
  for (const dir of ['src', 'public/static/js', 'tests']) {
    for (const f of walk(path.join(ROOT, dir), ['.ts', '.tsx', '.js', '.mjs'])) {
      const txt = fs.readFileSync(f, 'utf8');
      for (const re of PATTERNS) {
        for (const m of txt.matchAll(re)) {
          for (const part of m[1].split(/[\s>+~,]+/)) {
            const cls = part.replace(/^\./, '').replace(/:{1,2}.*$/, '').replace(/[[].*$/, '');
            if (cls && CLASS_TOKEN.test(cls)) out.add(cls);
          }
        }
      }
    }
  }
  return out;
}

// ── 白名单 ──────────────────────────────────────────────────────────────────

/** 刻意无样式，且**不需要**有消费者 —— 纯语义包装 / 占位修饰类。 */
const UNSTYLED: [string, string][] = [
  ['.chat-msg__reply-text', '纯语义包装：字号/颜色/换行/超长裁剪全部自父级 button.chat-msg__reply 继承'],
  ['.fish-card__body', '纯语义包装：四个子块各自带间距与外观，这层壳不带样式（678f461 主动删掉过它的空规则）'],
  ['.fish-card__link-label', '纯语义包装且是必需的：整条文案要成为 .fish-card__link 的单一子元素（见 _fish.scss 注释）'],
  ['.home-grid-item', '纯语义包装：位置由 .home-grid 的 gap/stretch 给，卡片自己 height:100%'],
  ['.clipboard-markdown-content', 'JS 钩子（挂 MutationObserver）+ 包装：子节点 MarkdownRenderer 自带 .blog-content-container 卡片'],
  ['.rc-medal', '命名钩子：尺寸由 svg.rc-icon 的 1em × 父级 font-size 决定，奖牌三档的固定色在 svg 的 fill 上'],
  ['.modal-dialog-centered', 'Bootstrap 残留：居中由 .modal.is-open 的 flex + .modal-dialog{margin:auto} 实现，补了反而会压过现有居中（docs/frontend-styles.md §12 已登记）'],
  ['.nf__btn--ghost', '占位修饰类：SCSS 里有规则但体是空的，编译后不产出（源注释：保留类名以备后续差异化）'],
  ['.cattca-tool__btn--secondary', '同上（_tool-cattca.scss 里与 .story-cattca__btn--secondary 并排的空规则）'],
  ['.story-cattca__btn--secondary', '同上'],
  ['.pay-quick', '收银台别名钩子：与 .market-quick 成对出现，外观全由后者给（_fish-pay.scss 头部记着这套复用策略）'],
  ['.pay-amount__input', '收银台别名钩子：与 .market-amount__input 成对出现，外观全由后者给'],
];

/** 刻意无样式，但**必须**在别处以选择器形态被消费 —— 否则这条豁免就是假的。 */
const CONSUMED: [string, string][] = [
  ['.pay-quick__btn', 'tests/e2e/poster.spec.ts 用它点快捷金额'],
  ['.pay-amount__error', 'tests/e2e/poster.spec.ts 断言余额不足文案'],
  ['.vote-embed', 'MarkdownRenderer 扫到就把这个占位换成 <VoteEmbed>，不参与样式'],
];

// 名单里写作 `.foo`（读起来像选择器），比对时一律去点 —— used/defined 存的是裸类名。
const bare = (c: string) => c.replace(/^\./, '');
const ALLOW = new Set([...UNSTYLED, ...CONSUMED].map(([c]) => bare(c)));

// ── 断言 ────────────────────────────────────────────────────────────────────

describe('.tsx / .ts 里的类名与 CSS 定义一致', () => {
  const defined = definedClasses();
  const used = usedClasses();
  const consumed = consumedClasses();

  it('确实扫到了东西（自检：别因为正则失效而空过）', () => {
    expect(defined.size).toBeGreaterThan(500);
    expect(used.size).toBeGreaterThan(300);
  });

  it('每个用到的类名要么有 CSS 定义，要么在白名单里', () => {
    const missing = [...used.entries()]
      .filter(([c]) => !defined.has(c) && !ALLOW.has(c))
      .map(([c, files]) => `.${c} ← ${[...files].join(', ')}`);
    expect(
      missing,
      '这些类名写了但全站没有定义，会静默落回浏览器默认样式：\n' +
        `${missing.join('\n')}\n` +
        '补样式，或（确实是纯语义包装/占位修饰类时）登记进本文件顶部的 UNSTYLED 并写明理由。'
    ).toEqual([]);
  });

  it('CONSUMED 白名单里每个类名都真的被消费了（防止豁免变成谎话）', () => {
    const lies = CONSUMED.map(([c]) => c).filter((c) => !consumed.has(bare(c)));
    expect(
      lies,
      '这些类名登记成「有消费者」但全仓找不到任何选择器在用它们：\n' +
        `${lies.join('\n')}\n` +
        '要么它其实没人用（那就把类名从 JSX 里删掉），要么挪进 UNSTYLED 并换个诚实的理由。'
    ).toEqual([]);
  });

  it('白名单里没有已经过期的一行（该类名已经拿到 CSS 定义了）', () => {
    const stale = ALLOW.size ? [...ALLOW].filter((c) => defined.has(c)) : [];
    expect(stale, `这些类名已经有 CSS 定义了，把它们从白名单里删掉：\n${stale.join('\n')}`).toEqual([]);
  });
});
