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
  docHref,
  findDocEntry,
  repoFileUrl,
  rewriteDocHref,
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
