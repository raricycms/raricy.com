// ─────────────────────────────────────────────────────────────────────────────
// docs-render.test.ts —— 站内文档的**渲染管线**（读盘 → marked → 改写过的链接）
//
// 【为什么单独一份】`docs-catalog.test.ts` 管的是登记表与磁盘对不对得上，测的是
// 纯函数（`rewriteDocHref` 的输入输出）。可真正上页面的是 `renderDocHtml` ——
// 它把改写挂在 marked 的 `walkTokens` 钩子上。钩子挂错（名字改了、token 形状变了）
// 时，`rewriteDocHref` 的单测**照样全绿**，页面上的链接却全是死的 —— 死链不报错，
// 只有点的人知道。所以这里对着**真实文档**断言「渲染出来的 HTML 里已经是新地址」。
//
// 另有一条把全部登记文档渲染一遍：漏一份 → 页面 500（readDocSource 刻意不兜底），
// 而那是线上才发现最贵的一类。
// ─────────────────────────────────────────────────────────────────────────────

import { describe, expect, it } from 'vitest';
import { DOC_ENTRIES, docHref, findDocEntry } from '@/lib/docs-catalog';
import { renderDocHtml } from '@/lib/docs-service';

function entryOf(slug: string) {
  const entry = findDocEntry(slug.split('/'));
  expect(entry, `登记表里没有 ${slug}`).not.toBe(null);
  return entry!;
}

describe('文档渲染', () => {
  it('每一份登记在案的文档都渲染得出来', () => {
    const empty: string[] = [];
    for (const e of DOC_ENTRIES) {
      let html = '';
      try {
        html = renderDocHtml(e);
      } catch (err) {
        empty.push(`${e.slug}: ${String(err).split('\n')[0]}`);
        continue;
      }
      if (!html.trim()) empty.push(`${e.slug}: 渲染结果是空的`);
    }
    expect(empty, `这些文档渲染失败（线上会 500）：\n  ${empty.join('\n  ')}`).toEqual([]);
  });

  it('兄弟文档的相对链接渲染成了站内地址', () => {
    // docs/guide/内容引用语法指南.md 里有 `[表情包使用指南](表情包使用指南.md)`
    const html = renderDocHtml(entryOf('guide/内容引用语法指南'));
    expect(html).toContain(`href="${docHref('guide/表情包使用指南')}"`);
    expect(html).not.toContain('href="表情包使用指南.md"');
  });

  it('指向源码的相对链接渲染成了仓库地址', () => {
    // docs/frontend-styles.md 里有 `[src/app/layout.tsx](../src/app/layout.tsx)`
    const html = renderDocHtml(entryOf('frontend-styles'));
    expect(html).toContain(
      'https://github.com/raricycms/raricy.com/blob/main/src/app/layout.tsx'
    );
  });

  it('代码围栏里的链接不受影响（示例代码不该被改写，也不该变成真元素）', () => {
    // docs/guide/图床使用指南.md 的示例块里写着 `![图片说明](/api/images/AbCdEf1234/raw)`
    const html = renderDocHtml(entryOf('guide/图床使用指南'));
    expect(html).not.toContain('<img src="/api/images/AbCdEf1234/raw"');
    expect(html).toContain('![图片说明](/api/images/AbCdEf1234/raw)');
  });
});
