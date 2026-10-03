// ─────────────────────────────────────────────────────────────────────────────
// docs-catalog.test.ts —— 静态检查：站内文档页登记的每一条都对得上磁盘
//
// 【为什么要有】`/docs` 把 `docs/` 下的 Markdown 渲染到站上，而「哪几份、叫什么、
// 什么顺序」住在一张手写的登记表（`src/lib/docs-catalog.ts`）里。手写表有两种静默漂法：
//
//   · **漏登记**：新加一份文档、忘了往表里添一行 —— 它在站上根本不出现，
//     没有任何报错，只有作者自己「咦我写的文档呢」。
//   · **标题漂**：文档改名（H1 改了）、表里的 title 没跟着改 —— 目录里写着 A、
//     点进去正文是 B。改标题的人多半只改 .md，不会记得还有第二处。
//
// 所以这里双向对账：磁盘上有的表里必须有，表里有的磁盘上必须存在，标题必须一致。
// 与本仓 `guide-docs.test.ts`（页面 ↔ 文件名）、`avatar-sites-guard.test.ts`
//（头像落点台账）同一条纪律 —— 认不出来就报错，**绝不静默跳过**。
//
// 顺带钉住取件口 `findDocEntry` 的边界：它是 `/docs/<...>` 唯一的入口，
// 越界、畸形、空 slug 必须一律 null（拼路径读文件那条路因此不存在）。
// ─────────────────────────────────────────────────────────────────────────────

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  DOC_ENTRIES,
  DOC_GROUPS,
  docAnchor,
  docHref,
  findDocEntry,
  repoFileUrl,
  resolveDocRef,
  rewriteDocHref,
  sectionKeyOf,
} from '@/lib/docs-catalog';

const ROOT = path.resolve(import.meta.dirname, '../..');
const DOCS_DIR = path.join(ROOT, 'docs');

/** 磁盘上全部文档，仓库根相对写法（`docs/bot/chat-bot.md`）。 */
function collectDocFiles(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) collectDocFiles(p, out);
    else if (e.name.endsWith('.md')) out.push(path.relative(ROOT, p));
  }
  return out;
}

const FILES = collectDocFiles(DOCS_DIR);
const H1_OF = new Map(FILES.map((f) => [f, fs.readFileSync(path.join(ROOT, f), 'utf-8').split('\n')[0].trim()]));

/**
 * 标题比对前先归一化：去掉行内代码的反引号、把连续空白压成一个、去首尾。
 *
 * 归一化是为了 `内容引用语法 \`[@ ]\` 使用指南` 这类 H1 —— 标题里那段行内代码在
 * 正文里该有反引号（它是个语法记号），在目录里带上反引号却只会显示成两个怪符号。
 * 除了反引号与空白，其余差异一律算不一致。
 */
const norm = (s: string) => s.replace(/`/g, '').replace(/\s+/g, ' ').trim();

const entryFile = (slug: string) => `docs/${slug}.md`;

describe('文档登记表 ↔ docs/ 双向对账', () => {
  it('扫到了文档（防止扫描逻辑悄悄失效）', () => {
    expect(FILES.length).toBeGreaterThan(30);
    expect(DOC_ENTRIES.length).toBeGreaterThan(30);
  });

  it('登记表里的每一条都指向真实存在的文件', () => {
    const missing = DOC_ENTRIES.filter((e) => !FILES.includes(entryFile(e.slug))).map(
      (e) => `${e.slug} → ${entryFile(e.slug)}`
    );
    expect(
      missing,
      `登记表里有磁盘上没有的文档 —— /docs 下这些条目点了就是 404：\n  ${missing.join('\n  ')}`
    ).toEqual([]);
  });

  it('磁盘上的每一份文档都在登记表里（漏登记 = 站上永远看不到它）', () => {
    const registered = new Set(DOC_ENTRIES.map((e) => entryFile(e.slug)));
    const unlisted = FILES.filter((f) => !registered.has(f));
    expect(
      unlisted,
      `这些文档没有登记，站内 /docs 里不会出现：\n  ${unlisted.join('\n  ')}\n` +
        `（改 src/lib/docs-catalog.ts 的 DOC_ENTRIES：加一条，别漏。` +
        `确实不想上站的文档目前没有 —— 有的话得在这里显式排除并写明理由。）`
    ).toEqual([]);
  });

  it('每份文档首行都是 H1', () => {
    const bad = FILES.filter((f) => !/^#\s+\S/.test(H1_OF.get(f) ?? ''));
    expect(bad, `这些文档首行不是 H1（页面上会失去层级）：\n  ${bad.join('\n  ')}`).toEqual([]);
  });

  it('登记表的 title 与文档 H1 一致（目录里写着 A、点进去是 B 就是这里漏了）', () => {
    const drift = DOC_ENTRIES.filter(
      (e) => norm(H1_OF.get(entryFile(e.slug))?.replace(/^#\s+/, '') ?? '') !== norm(e.title)
    ).map((e) => `${e.slug}\n     表里：${e.title}\n     文档：${H1_OF.get(entryFile(e.slug))}`);
    expect(
      drift,
      `登记表的标题与文档 H1 对不上（改标题要两处一起改）：\n  ${drift.join('\n  ')}`
    ).toEqual([]);
  });

  it('标题与摘要都是能直接显示的一行字', () => {
    const bad: string[] = [];
    for (const e of DOC_ENTRIES) {
      if (!e.title.trim()) bad.push(`${e.slug}: title 为空`);
      if (!e.summary.trim()) bad.push(`${e.slug}: summary 为空`);
      if (/[\n\r]/.test(e.summary)) bad.push(`${e.slug}: summary 里有换行`);
      // 索引页那两行是并排显示的，太长会把卡片撑成一堵墙
      if (e.summary.length > 60) bad.push(`${e.slug}: summary ${e.summary.length} 字，超过 60`);
    }
    expect(bad, `登记表的字段不合格：\n  ${bad.join('\n  ')}`).toEqual([]);
  });

  it('slug 唯一、分组合法、每组都有条目', () => {
    const slugs = DOC_ENTRIES.map((e) => e.slug);
    expect(new Set(slugs).size, `slug 有重复：${slugs.join(', ')}`).toBe(slugs.length);

    const keys = new Set(DOC_GROUPS.map((g) => g.key));
    const badGroup = DOC_ENTRIES.filter((e) => !keys.has(e.group)).map((e) => e.slug);
    expect(badGroup, `这些条目的 group 不在 DOC_GROUPS 里：${badGroup.join(', ')}`).toEqual([]);

    const empty = DOC_GROUPS.filter((g) => !DOC_ENTRIES.some((e) => e.group === g.key)).map((g) => g.key);
    expect(empty, `这些分组一份文档都没有（索引页会显示一个空标题）：${empty.join(', ')}`).toEqual([]);
  });
});

describe('URL 与取件口', () => {
  it('slug 中的中文逐段转义，且能被 findDocEntry 解回同一份文档', () => {
    for (const e of DOC_ENTRIES) {
      const href = docHref(e.slug);
      expect(href.startsWith('/docs/')).toBe(true);
      const segments = href.slice('/docs/'.length).split('/');
      // Next 两种形态都可能给到：原样转义的，与已解码的
      expect(findDocEntry(segments)?.slug).toBe(e.slug);
      expect(findDocEntry(segments.map(decodeURIComponent))?.slug).toBe(e.slug);
    }
  });

  it('越界与畸形的 slug 一律 null（不拼路径、不读文件）', () => {
    const bad = [
      [],
      ['..'],
      ['..', '..', 'package.json'],
      ['guide', '..', 'architecture'],
      ['/etc/passwd'],
      ['guide%2F图床使用指南'], // 转义出的斜杠 = 同一份文档的第二个 URL，拒掉
      ['guide', '不存在的文档'],
      ['guide', '.'],
      [''],
    ];
    for (const slug of bad) {
      expect(findDocEntry(slug), `slug ${JSON.stringify(slug)} 不该命中`).toBe(null);
    }
  });

  it('正文里的相对链接：指向文档的走站内，指向源码的走仓库', () => {
    // 兄弟文档（docs/guide/内容引用语法指南.md 里的写法）
    expect(rewriteDocHref('guide/内容引用语法指南', '表情包使用指南.md')).toBe(
      docHref('guide/表情包使用指南')
    );
    // 上跳一层再进 docs（同目录树的另一种写法）
    expect(rewriteDocHref('guide/图床使用指南', '../bot/chat-bot.md')).toBe(docHref('bot/chat-bot'));
    // 仓库里的源码 —— docs/frontend-styles.md 里的写法
    expect(rewriteDocHref('frontend-styles', '../src/app/layout.tsx')).toBe(
      repoFileUrl('src/app/layout.tsx')
    );
    // 锚点要跟着走
    expect(rewriteDocHref('guide/图床使用指南', '表情包使用指南.md#第二节')).toBe(
      docHref('guide/表情包使用指南') + '#第二节'
    );
  });

  it('外链、站内绝对路径、纯锚点原样返回', () => {
    const untouched = [
      'https://example.com/a.md',
      'mailto:raricycms@gmail.com',
      '/api/images/AbCdEf1234/raw',
      '#本地标题',
      '//example.com/x',
    ];
    for (const href of untouched) {
      expect(rewriteDocHref('architecture', href)).toBe(href);
    }
    // 越出仓库根：不猜，原样返回
    expect(rewriteDocHref('architecture', '../../../etc/passwd')).toBe('../../../etc/passwd');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// resolveDocRef —— 反引号路径 → 站内条目
//
// 判据与守卫 `docs-xref.test.ts` 的 `candidates()` **同一优先级**：兄弟优先，
// 再回退仓库根。两者必须一致 —— 守卫管「这个引用指得到」，它管「点下去去哪」。
// ─────────────────────────────────────────────────────────────────────────────

describe('resolveDocRef：反引号路径的解析', () => {
  const slugOf = (from: string, raw: string) => resolveDocRef(from, raw)?.slug ?? null;

  it('根相对写法（最多的一种）', () => {
    expect(slugOf('bot/trade-bot', 'docs/architecture.md')).toBe('architecture');
    expect(slugOf('deploy', 'docs/bot/fish-bot.md')).toBe('bot/fish-bot');
  });

  it('兄弟裸名 —— 按引用所在目录解析', () => {
    expect(slugOf('cli', 'deploy.md')).toBe('deploy');
    expect(slugOf('bot/trade-bot', 'fish-bot.md')).toBe('bot/fish-bot');
    expect(slugOf('guide/图床使用指南', '表情包使用指南.md')).toBe('guide/表情包使用指南');
  });

  it('`docs/README.md` 的索引表里那种 `guide/xxx.md`', () => {
    expect(slugOf('README', 'guide/图床使用指南.md')).toBe('guide/图床使用指南');
    expect(slugOf('README', 'bot/chat-bot.md')).toBe('bot/chat-bot');
  });

  it('解析到仓库根、而非 docs/ 下的那个同名文件时，不链', () => {
    // `../README.md` 从 docs/ 下出发 = 仓库根的 README，它**没有**站内页
    // （登记表里的 `README` 是 `docs/README.md`，是另一份文件）。
    expect(slugOf('deploy', '../README.md')).toBe(null);
    expect(slugOf('bot/trade-bot', '../CLAUDE.md')).toBe(null);
  });

  it('非文档、未登记、越界的一律 null', () => {
    expect(slugOf('architecture', 'src/lib/rate-limit.ts')).toBe(null); // 源码，不是文档引用
    expect(slugOf('architecture', 'docs/不存在的文档.md')).toBe(null);
    expect(slugOf('architecture', '/etc/passwd.md')).toBe(null);
    expect(slugOf('architecture', 'https://example.com/a.md')).toBe(null);
    expect(slugOf('architecture', '随便什么字')).toBe(null);
  });

  it('同目录与根下同名时按兄弟解析（那种歧义由 docs-xref 守卫全仓禁止）', () => {
    // 从 `docs/README.md` 出发的裸 `README.md` 落在同目录 —— 与守卫的兄弟优先一致。
    // 语料里不该出现这种写法（守卫会报「歧义」），这里钉的是**优先级**本身。
    expect(slugOf('README', 'README.md')).toBe('README');
  });
});

describe('段号词汇：sectionKeyOf 与 docAnchor', () => {
  it('认数字段与中文段，中文段只取到顿号', () => {
    expect(sectionKeyOf('6.3 CSRF 中间件')).toBe('6.3');
    expect(sectionKeyOf('五、命令清单')).toBe('五、');
    expect(sectionKeyOf('6.40 干扰项')).toBe('6.40'); // 不该被读成 6.4
    expect(sectionKeyOf('没有编号的标题')).toBe(null);
  });

  it('锚点从段号派生，标题改名不会漂', () => {
    expect(docAnchor('6.3')).toBe('sec-6.3');
    expect(docAnchor('五、')).toBe('sec-五、');
  });
});
