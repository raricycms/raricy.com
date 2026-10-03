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
import { DOC_ENTRIES, docHref, findDocEntry, resolveDocRef, sectionKeyOf } from '@/lib/docs-catalog';
import { renderDocHtml } from '@/lib/docs-service';

function entryOf(slug: string) {
  const entry = findDocEntry(slug.split('/'));
  expect(entry, `登记表里没有 ${slug}`).not.toBe(null);
  return entry!;
}

/** 渲染结果按 slug 缓存 —— 下面几条断言要把全部文档渲染好几遍。 */
const HTML_CACHE = new Map<string, string>();
function htmlOf(slug: string): string {
  let html = HTML_CACHE.get(slug);
  if (html === undefined) {
    html = renderDocHtml(entryOf(slug));
    HTML_CACHE.set(slug, html);
  }
  return html;
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

    // 同文件里还有两条**写在表格单元格里**的真链接。单元格的 token 挂法与段落不同
    //（见 docs-service.ts 的 `childTokenArrays`），遍历器漏了这一类的话，
    // 它们会静默退回 404 的死链 —— 这条断言就是那道网。
    expect(html).toContain(`href="${docHref('guide/音频床使用指南')}"`);
    expect(html).not.toContain('href="音频床使用指南.md"');
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

// ─────────────────────────────────────────────────────────────────────────────
// 反引号文档路径 → 站内链接
//
// 本仓规范要求文档互指写成**反引号路径**（`docs/README.md`「互指怎么写」），
// 于是它们在页面上是 `<code>` 死文本。渲染层负责把它们变成链接 —— 写法一个字不改。
//
// 这一组钉的是**渲染产物**：单测 `resolveDocRef` 只能证明「认得出」，
// 证明不了「页面上真有那颗 `<a>`」—— 中间还隔着遍历器有没有走进那个容器。
// ─────────────────────────────────────────────────────────────────────────────

describe('反引号文档路径 → 站内链接', () => {
  it('路径渲染成 <a><code>，指向站内页', () => {
    // docs/deploy.md 里多次写 `docs/architecture.md`
    expect(htmlOf('deploy')).toMatch(
      /<a href="\/docs\/architecture(?:#[^"]*)?"><code>docs\/architecture\.md<\/code>/
    );
  });

  it('紧随的段号被吃进链接，href 带上锚点', () => {
    expect(htmlOf('deploy')).toMatch(
      /<a href="\/docs\/architecture#sec-[^"]*"><code>docs\/architecture\.md<\/code> §[^<]*<\/a>/
    );
  });

  it('中文 slug 的引用也链得上（href 逐段转义）', () => {
    // docs/README.md 的索引表里写着 `guide/图床使用指南.md`
    expect(htmlOf('README')).toContain(`<a href="${docHref('guide/图床使用指南')}">`);
  });

  it('表格单元格 / 列表项里的引用同样被链（遍历器漏一层的回归网）', () => {
    const table = htmlOf('README');
    expect(table).toContain('<table>');
    expect(table).toMatch(/<td>(?:(?!<\/td>)[\s\S])*?<a href="\/docs\//);

    const list = htmlOf('architecture');
    expect(list).toMatch(/<li>(?:(?!<\/li>)[\s\S])*?<a href="\/docs\//);
  });

  it('源码路径不会被链 —— 只认登记在案的 .md', () => {
    const html = htmlOf('architecture');
    expect(html).not.toMatch(/href="\/docs\/src\//);
    // 反向：文件里确实有源码路径，只是保持 <code> 原样
    expect(html).toMatch(/<code>src\/[^<]*\.ts<\/code>/);
  });

  it('每个段号链接的锚点在目标文档里真的存在', () => {
    // 这条是**锚点闭环**：href 里的 `#sec-K` 与 heading 渲染出的 `id="sec-K"`
    // 是两处算出来的。漂开的表现是点了**落在文档顶部**，不报错、也没人会说。
    const missing: string[] = [];
    for (const e of DOC_ENTRIES) {
      for (const m of htmlOf(e.slug).matchAll(/href="\/docs\/([^"#]*)#sec-([^"]*)"/g)) {
        const slug = decodeURIComponent(m[1]);
        const id = `sec-${decodeURIComponent(m[2])}`;
        if (!htmlOf(slug).includes(`id="${id}"`)) missing.push(`${e.slug} → /docs/${m[1]}#${m[2]}`);
      }
    }
    expect(
      missing,
      `这些段号链接指向的标题不存在（多半是加/删了一节导致编号位移）：\n  ${missing.join('\n  ')}`
    ).toEqual([]);
  });

  it('认得出编号标题（渲染层与守卫共用同一个 sectionKeyOf）', () => {
    expect(sectionKeyOf('6.3 CSRF 中间件')).toBe('6.3');
    expect(sectionKeyOf('五、命令清单')).toBe('五、');
    expect(sectionKeyOf('6.40 干扰项')).toBe('6.40'); // 前缀不算命中 6.4
    expect(sectionKeyOf('没有编号的标题')).toBe(null);
  });
});
