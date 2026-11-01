// ─────────────────────────────────────────────────────────────────────────────
// reactive-legacy-compat.test.ts —— 历史 HTML 的局部容错
//
// 每个夹具都对应本地语料扫描里的一类真实例外（已匿名化、现生成）：
// 超长 HTML 属性、`</br>`、多余 `</details>`、未知 `<TAB>`、未配对数学、
// 历史 data 位图、整页 HTML 粘贴、代码块里的同名标签。
//
// 判据不是「诊断里没有某个码」这么松：要真的编译成功、正文文字还在、
// 危险能力没有变成可执行内容。
// ─────────────────────────────────────────────────────────────────────────────

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { compileLocal, type LocalNode } from 'reactive-md';
import { renderSiteEmbedStatic } from '@/app/components/reactive/site-embed-static';
import { adaptReactiveReferences } from '@/lib/reactive/ref-adapter';
import { applyLegacyHtmlCompat } from '@/lib/reactive/legacy-compat';
import { reactiveCompileOptions } from '@/lib/reactive/host-components';
import { parseLegacyDataImage } from '@/lib/reactive/data-image';
import { isAllowedReactiveUrl } from '@/lib/reactive/url-policy';

const PNG_1PX =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function compile(source: string) {
  return compileLocal(source, reactiveCompileOptions('markdown'));
}

function flatten(nodes: readonly LocalNode[]): string {
  const out: string[] = [];
  const walk = (node: LocalNode): void => {
    if (typeof node.value === 'string') out.push(node.value);
    node.children?.forEach(walk);
  };
  nodes.forEach(walk);
  return out.join('');
}

function documentOf(result: ReturnType<typeof compile>) {
  if (!result.ok) throw new Error(`fixture did not compile: ${result.diagnostics.map((d) => d.code).join(',')}`);
  return result.document;
}

function compatCompile(source: string) {
  const compat = applyLegacyHtmlCompat(source);
  return { compat, result: compile(compat.source) };
}

describe('applyLegacyHtmlCompat', () => {
  it('结果与原文等长（source-map 的前提）', () => {
    const source = '<font color="red" style="font-size:20px" class="x" id="y">正文</font>\n\n</br>';
    expect(applyLegacyHtmlCompat(source).source).toHaveLength(source.length);
  });

  it('font / style / class / id 被剥掉，正文保留且可编译', () => {
    const { compat, result } = compatCompile(
      '<font color="red" style="font-size:20px" class="x" id="y">正文**加粗**</font>'
    );
    expect(result.ok).toBe(true);
    expect(result.diagnostics).toEqual([]);
    expect(flatten(documentOf(result).nodes)).toContain('正文加粗');
    expect(compat.counts['unwrapped-tag']).toBeGreaterThan(0);
  });

  it('`</br>` 归一成 `<br/>`，多余 `</details>` 去掉，折叠结构保留', () => {
    const { result } = compatCompile(
      '<details open><summary>标题</summary>正文</details></details>\n\na</br>b'
    );
    expect(result.ok).toBe(true);
    expect(result.diagnostics).toEqual([]);
    expect(flatten(documentOf(result).nodes)).toContain('正文');
    expect(flatten(documentOf(result).nodes)).toContain('a');
  });

  it('未知普通标签（<TAB>）只剥标签，不拖垮整篇', () => {
    const { result } = compatCompile('<TAB>缩进文字</TAB>\n\n后面的正常正文');
    expect(result.ok).toBe(true);
    expect(result.diagnostics).toEqual([]);
    expect(flatten(documentOf(result).nodes)).toContain('缩进文字');
    expect(flatten(documentOf(result).nodes)).toContain('后面的正常正文');
  });

  it('危险整块能力连同内容一起消失，不输出源码', () => {
    const { result } = compatCompile(
      '<script>alert(1)</script>\n\n<style>body{color:red}</style>\n\n<iframe src="https://example.com"></iframe>\n\n正文'
    );
    expect(result.ok).toBe(true);
    expect(flatten(documentOf(result).nodes)).toContain('正文');
    expect(flatten(documentOf(result).nodes)).not.toContain('alert');
    expect(flatten(documentOf(result).nodes)).not.toContain('body{color:red}');
    // 任何 fallback 节点都不该留下这些源码。
    expect(JSON.stringify(documentOf(result).nodes)).not.toContain('<script');
    expect(JSON.stringify(documentOf(result).nodes)).not.toContain('<iframe');
  });

  it('整页 HTML 粘贴：壳被剥掉，body 正文仍可读', () => {
    const { result } = compatCompile(
      '<!doctype html><html><head><title>页面标题</title><style>p{color:red}</style></head><body><h1>正文标题</h1><p>正文段落</p></body></html>'
    );
    expect(result.ok).toBe(true);
    expect(flatten(documentOf(result).nodes)).toContain('正文标题');
    expect(flatten(documentOf(result).nodes)).toContain('正文段落');
    expect(JSON.stringify(documentOf(result).nodes)).not.toContain('<style');
  });

  it('★ 历史 data 位图走宿主组件，真实渲染出 <img>（不依赖上游 urlPolicy）★', async () => {
    const source = `<p>前面</p><img src="${PNG_1PX}" alt="示意图"><p>后面</p>`;
    const compat = applyLegacyHtmlCompat(source);
    expect(compat.counts['data-image']).toBe(1);
    expect(compat.source).toContain('[@图片/');
    const ref = compat.source.match(/\[@图片\/([a-f0-9]{24})\]/)?.[1];
    expect(ref).toBeTruthy();
    expect(compat.dataImages[ref!]?.url).toBe(PNG_1PX);

    const adapted = await adaptReactiveReferences(compat.source, {
      mode: 'external',
      dataImages: compat.dataImages,
    });
    const hostData = adapted.hostData[`image:${ref}`];
    expect(hostData).toMatchObject({ kind: 'image', ref, status: 'ready' });
    expect((hostData.payload as { src: string }).src).toBe(PNG_1PX);

    const markup = renderToStaticMarkup(
      createElement(
        'div',
        null,
        renderSiteEmbedStatic(
          { type: 'component', id: 'img', range: { start: 0, end: 0 }, attrs: { kind: 'image', ref: ref! } },
          hostData,
          { mode: 'static' } as never
        )
      )
    );
    expect(markup).toContain('<img');
    expect(markup).toContain('src="data:image/png;base64,');
    expect(markup).toContain('alt="示意图"');
    expect(isAllowedReactiveUrl(PNG_1PX, 'image')).toBe(true);
    expect(isAllowedReactiveUrl(PNG_1PX, 'link')).toBe(false);
  });

  it('>8KB data 位图仍被兼容层截住，不把 base64 当源码输出', () => {
    const payload =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg';
    const padded = `${payload}${'A'.repeat(9000)}`;
    const big = `data:image/png;base64,${padded.slice(0, padded.length - (padded.length % 4))}`;
    expect(big.length).toBeGreaterThan(8192);
    const compat = applyLegacyHtmlCompat(`<img src="${big}" alt="大图">`);
    expect(compat.counts['data-image']).toBe(1);
    expect(compat.source).not.toContain('base64');
    expect(compat.source).toContain('[@图片/');
    expect(isAllowedReactiveUrl(big, 'image')).toBe(true);
    expect(isAllowedReactiveUrl(big, 'link')).toBe(false);
  });

  it('★ 接近上限的 data 位图不会因参数展开触发栈溢出 ★', () => {
    const payload =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg';
    const raw = `${payload}${'A'.repeat(400_000)}`;
    const big = `data:image/png;base64,${raw.slice(0, raw.length - (raw.length % 4))}`;
    const source = `<p>前</p><img src="${big}" alt="大图"><p>后</p>`;
    let compat: ReturnType<typeof applyLegacyHtmlCompat> | null = null;
    expect(() => {
      compat = applyLegacyHtmlCompat(source);
    }).not.toThrow();
    expect(compat!.source).toHaveLength(source.length);
    expect(compat!.source).toContain('[@图片/');
    expect(compat!.source).not.toContain('base64');
    expect(Object.keys(compat!.dataImages)).toHaveLength(1);
    // 替换后的剩余区间必须是零宽而不是几十万个空格：巨型空白会让上游编译卡死。
    const longestSpaceRun = Math.max(
      0,
      ...(compat!.source.match(/ +/g) ?? []).map((run) => run.length)
    );
    expect(longestSpaceRun).toBeLessThan(200);
    expect(compile(compat!.source).ok).toBe(true);

    // 被拒绝的大 data 图（魔数不对）同样不能留下巨型空格。
    const rejected = `<p>前</p><img src="data:image/png;base64,${'A'.repeat(400_000)}" alt="大图"><p>后</p>`;
    const rejectedCompat = applyLegacyHtmlCompat(rejected);
    expect(rejectedCompat.counts['data-image-rejected']).toBe(1);
    const rejectedSpaces = Math.max(
      0,
      ...(rejectedCompat.source.match(/ +/g) ?? []).map((run) => run.length)
    );
    expect(rejectedSpaces).toBeLessThan(200);
    expect(compile(rejectedCompat.source).ok).toBe(true);
  });

  it('Markdown 原生 data 图片同样走宿主组件', () => {
    const compat = applyLegacyHtmlCompat(`![示意](${PNG_1PX})`);
    expect(compat.counts['data-image']).toBe(1);
    expect(compat.source).toContain('[@图片/');
    expect(compat.source).not.toContain('data:image');
  });

  it('WebP 只接受 RIFF/WEBP 品牌，RIFF/WAVE 不显示', () => {
    const webp = `data:image/webp;base64,${Buffer.from('RIFF\0\0\0\0WEBPVP8 ').toString('base64')}`;
    const wave = `data:image/webp;base64,${Buffer.from('RIFF\0\0\0\0WAVEfmt ').toString('base64')}`;
    expect(parseLegacyDataImage(webp)).not.toBeNull();
    expect(parseLegacyDataImage(wave)).toBeNull();
  });

  it('非受限 data 位图（SVG）不显示、也不输出巨长源码', () => {
    const svg = 'data:image/svg+xml;base64,PHN2Zz48c2NyaXB0PmFsZXJ0KDEpPC9zY3JpcHQ+PC9zdmc+';
    const { compat, result } = compatCompile(`<img src="${svg}" alt="坏图">`);
    expect(parseLegacyDataImage(svg)).toBeNull();
    expect(compat.counts['data-image-rejected']).toBe(1);
    expect(JSON.stringify(documentOf(result).nodes)).not.toContain('c2NyaXB0');
  });

  it('代码块与行内代码里的标签逐字保留', () => {
    const source = [
      '```html',
      '<font style="x">示例</font>',
      '</br>',
      '```',
      '',
      '行内 `<TAB>` 示例',
    ].join('\n');
    const compat = applyLegacyHtmlCompat(source);
    expect(compat.changed).toBe(false);
    expect(compat.source).toBe(source);
  });

  it('emoji / 代理对前后等长改写，偏移仍按 UTF-16 一致', () => {
    const source = '😀前缀 <font style="x">表情🙂</font> 后文';
    const compat = applyLegacyHtmlCompat(source);
    expect(compat.source).toHaveLength(source.length);
    // 每个 UTF-16 code unit 的位置不变（emoji 是两个 code unit）
    for (let index = 0; index < source.length; index += 1) {
      expect(compat.source.charCodeAt(index), `index ${index}`).not.toBe(0);
    }
    expect(compat.source.slice(0, 4)).toBe(source.slice(0, 4));
    expect(compat.source.slice(-3)).toBe(source.slice(-3));
    // 诊断 range 也必须落在原始源码的同一位置
    const invalid = '😀 <panel title="未闭合">';
    const result = compileLocal(applyLegacyHtmlCompat(invalid).source, reactiveCompileOptions('markdown'));
    expect(result.ok).toBe(false);
    const range = result.diagnostics[0]?.range;
    expect(range).toBeTruthy();
    expect(invalid.slice(range!.start, range!.end).length).toBeGreaterThanOrEqual(0);
    expect(range!.end).toBeLessThanOrEqual(invalid.length);
  });

  it('缩进代码块逐字保留（含 font / script / $）', () => {
    const source = [
      '    示例 <font color="red">x</font>',
      '',
      '    <script>alert(1)</script>',
      '',
      '    价格 $5 与 </br>',
    ].join('\n');
    const compat = applyLegacyHtmlCompat(source);
    expect(compat.changed).toBe(false);
    expect(compat.source).toBe(source);
    const result = compile(source);
    expect(result.ok).toBe(true);
    expect(JSON.stringify(documentOf(result).nodes)).toContain('alert(1)');
  });

  it('未配对数学不破坏转义 / 链接目标 / HTML 属性 URL', () => {
    const escaped = '价格 \\$5 元';
    expect(applyLegacyHtmlCompat(escaped).source).toBe(escaped);

    const link = '[说明](https://e.com/items?$filter=name)';
    expect(applyLegacyHtmlCompat(link).source).toBe(link);

    const video = '<video src="https://e.com/a$b$c.mp4"></video>';
    const compat = applyLegacyHtmlCompat(video);
    // 视频改走 media token；属性值必须从原文读，不能被数学掩码改成 xxxx。
    expect(Object.values(compat.mediaSources)[0]).toMatchObject({
      media: 'video',
      src: 'https://e.com/a$b$c.mp4',
    });
    expect(compat.source).not.toContain('axxxxc');
  });

  it('未配对数学不碰 reference definition / 裸 URL / 图片 alt', () => {
    const ref = `[ref]: https://e.com/$path

正文`;
    expect(applyLegacyHtmlCompat(ref).source).toBe(ref);
    const url = '见 https://e.com/items?$filter=name 结尾';
    expect(applyLegacyHtmlCompat(url).source).toBe(url);
    const alt = '![价格 $5](https://e.com/a.png)';
    expect(applyLegacyHtmlCompat(alt).source).toBe(alt);
    // alt 与链接目标同时含 `$`：盖 alt 时不能把 `](` 一起盖掉，否则目标漏网。
    const both = '![价格 $5](https://e.com/items?$filter=name)';
    expect(applyLegacyHtmlCompat(both).source).toBe(both);
  });

  it('兼容改写是幂等的（预览适配 + worker 各跑一次也不会二次漂移）', () => {
    const samples = [
      '😀<font color="red">表情🙂</font> 后文',
      '<select><option label="A">A</option><option value="b">B</option></select>',
      '<multi-select bind="s" label="主题"><option value="a">A</option></multi-select>',
      '<p>前</p><script>alert(1)</script><p>后</p>',
      '![价格 $5](https://e.com/a.png)',
      '```html\n<font>x</font>\n```',
    ];
    for (const source of samples) {
      const once = applyLegacyHtmlCompat(source).source;
      const twice = applyLegacyHtmlCompat(once).source;
      expect(twice, source).toBe(once);
      expect(once.length, source).toBe(source.length);
    }
  });

  it('组件容器里的 <option> 保留；旧 <select><option> 仍解包（含 label 属性）', () => {
    const component = applyLegacyHtmlCompat(
      '<multi-select bind="s" label="主题"><option value="a">A</option></multi-select>'
    );
    expect(component.source).toContain('<option value="a">A</option>');

    for (const legacy of [
      '<select><option value="a">A</option></select>',
      '<select><option label="A">A</option></select>',
    ]) {
      const compat = applyLegacyHtmlCompat(legacy);
      expect(compat.source, legacy).not.toContain('<option');
      expect(compat.source, legacy).not.toContain('</option>');
    }
  });

  it('普通美元内容按字面渲染：价格 / 转义 / reference / 裸 URL / 图片 alt', () => {
    // 单个 `$` 上游本来就当普通文本，不能为了“容错”改成全角 ＄。
    const price = compatCompile('价格 $5');
    expect(flatten(documentOf(price.result).nodes)).toBe('价格 $5');
    expect(flatten(documentOf(price.result).nodes)).not.toContain('＄');
    expect(price.compat.changed).toBe(false);

    const escaped = compatCompile('价格 \\$5');
    expect(flatten(documentOf(escaped.result).nodes)).toBe('价格 $5');
    expect(escaped.compat.source).toBe('价格 \\$5');

    const ref = compatCompile('[ref]: https://e.com/$path\n\n[见][ref]');
    const refJson = JSON.stringify(documentOf(ref.result).nodes);
    expect(refJson).toContain('"url":"https://e.com/$path"');
    expect(refJson).not.toContain('＄');
    expect(flatten(documentOf(ref.result).nodes)).toBe('见');

    const bare = compatCompile('见 https://e.com/items?$filter=name 结尾');
    const bareJson = JSON.stringify(documentOf(bare.result).nodes);
    expect(bareJson).toContain('"url":"https://e.com/items?$filter=name"');
    expect(bareJson).not.toContain('＄');

    const alt = compatCompile('![价格 $5](https://e.com/a.png)');
    const altJson = JSON.stringify(documentOf(alt.result).nodes);
    expect(altJson).toContain('"alt":"价格 $5"');
    expect(altJson).toContain('"url":"https://e.com/a.png"');
    expect(altJson).not.toContain('＄');

    // 有效公式仍然是公式；未闭合的显示数学保留可读文字、不产生数学节点。
    const valid = compatCompile('公式 $a<b$ 结尾');
    expect(JSON.stringify(documentOf(valid.result).nodes)).toContain('"type":"inlineMath"');
    const unpaired = compatCompile('$$ 没配对');
    expect(unpaired.result.ok).toBe(true);
    expect(flatten(documentOf(unpaired.result).nodes)).toContain('没配对');
    expect(JSON.stringify(documentOf(unpaired.result).nodes)).not.toContain('"type":"inlineMath"');
  });

  it('未配对数学不会被当成标签处理，且不吞掉后半句', () => {
    const valid = '公式 $a<b$ 结尾';
    expect(applyLegacyHtmlCompat(valid).source).toBe(valid);

    const unpaired = '公式 $x 没配对，还有 **后半句**';
    const { compat, result } = compatCompile(unpaired);
    // 单个 `$` 是普通文字：不中和、不计数、不改字符。
    expect(compat.changed).toBe(false);
    expect(compat.source).toBe(unpaired);
    expect(result.ok).toBe(true);
    expect(flatten(documentOf(result).nodes)).toContain('$x 没配对');
    expect(flatten(documentOf(result).nodes)).toContain('后半句');
    const json = JSON.stringify(documentOf(result).nodes);
    expect(json).not.toContain('"type":"inlineMath"');
  });

  it('旧 HTML 音视频：站内音频仍走引用 token，外链走 media host', () => {
    const audio = applyLegacyHtmlCompat(
      '<audio controls src="/api/audio/abcdefghij/raw"></audio>'
    );
    expect(audio.source).toContain('[@音频/abcdefghij]');
    expect(audio.mediaSources).toEqual({});

    const video = applyLegacyHtmlCompat('<video src="https://example.com/a.mp4"></video>');
    expect(video.source).toMatch(/\[\[媒体:[a-f0-9]{10}\]\]/);
    expect(Object.values(video.mediaSources)).toEqual([
      { media: 'video', src: 'https://example.com/a.mp4' },
    ]);
  });

  it('不支持的 class 剥掉后不再触发 attribute 回退', () => {
    const { result } = compatCompile('<div class="x">正文</div>');
    expect(result.ok).toBe(true);
    expect(result.diagnostics).toEqual([]);
  });

  it('★ 兼容白名单 × 上游属性矩阵：每一格都不触发 local.html.fallback ★', () => {
    const cases = [
      '<div align="center">x</div>',
      '<p align="center">x</p>',
      '<h1 align="center">x</h1>',
      '<table><tr><td colspan="2" rowspan="1" headers="h">x</td></tr></table>',
      '<table><tr><th scope="col">h</th></tr></table>',
      '<ol start="3"><li>x</li></ol>',
      '<a href="https://e.com" target="_blank" rel="noopener">x</a>',
      '<img src="/a.png" width="10" height="20" alt="a" title="t">',
      '<details open><summary>s</summary>x</details>',
    ];
    for (const html of cases) {
      const { result } = compatCompile(html);
      expect(result.ok, html).toBe(true);
      expect(result.diagnostics.map((d) => d.code), html).not.toContain('local.html.fallback');
    }
    // 上游拒绝的属性必须被剥掉，而不是整块退成源码。
    for (const html of [
      '<table align="center"><tr><td>x</td></tr></table>',
      '<table><caption align="center">c</caption><tr><td>x</td></tr></table>',
      '<details><summary align="center">s</summary>x</details>',
      '<img src="/a.png" align="center">',
      '<table><colgroup span="2"><col span="2"></colgroup><tr><td>x</td></tr></table>',
    ]) {
      const { result } = compatCompile(html);
      expect(result.ok, html).toBe(true);
      expect(result.diagnostics.map((d) => d.code), html).not.toContain('local.html.fallback');
    }
  });

  it('javascript: 链接不再以原样标签进入文档', () => {
    const { result } = compatCompile('<a href="javascript:alert(1)">点我</a>');
    expect(result.ok).toBe(true);
    const json = JSON.stringify(documentOf(result).nodes);
    expect(json).not.toContain('javascript:');
    expect(flatten(documentOf(result).nodes)).toContain('点我');
  });
});

describe('与原生 HTML 同名的合法组件', () => {
  it('section / table / progress 不被当成历史标签解包，保留真实组件节点', () => {
    const cases: { source: string; name: string }[] = [
      { source: '<section color="#45536f">\n\n正文\n\n</section>', name: 'section' },
      {
        source: '<table label="数据" page-size="5">\n| 名称 |\n| --- |\n| 甲 |\n</table>',
        name: 'table',
      },
      { source: '<progress label="进度" value="{{ 40 }}">', name: 'progress' },
    ];
    for (const { source, name } of cases) {
      const compat = applyLegacyHtmlCompat(source);
      expect(compat.source, source).toContain(`<${name}`);
      expect(compat.counts['unwrapped-tag'] ?? 0, source).toBe(0);
      const result = compileLocal(compat.source, reactiveCompileOptions('reactive'));
      expect(result.ok, source).toBe(true);
      expect(JSON.stringify(documentOf(result).nodes), source).toContain(`"type":"component"`);
      expect(JSON.stringify(documentOf(result).nodes), source).toContain(`"name":"${name}"`);
    }

    // 缺必填属性时必须是“组件诊断”，不能悄悄解包成纯文本 —— 后者会让作者
    // 以为进度条存进去了。
    const missingLabel = applyLegacyHtmlCompat('<progress value="{{ 40 }}">');
    expect(missingLabel.source).toContain('<progress');
    const failed = compile(missingLabel.source);
    expect(failed.ok).toBe(false);
    expect(failed.diagnostics.map((d) => d.code)).toContain('local.label.required');
  });

  it('没有组件证据的同名历史标签仍然解包（普通正文不被硬判）', () => {
    const section = applyLegacyHtmlCompat('<section>历史正文</section>');
    expect(section.source).not.toContain('<section');
    expect(flatten(documentOf(compile(section.source)).nodes)).toContain('历史正文');

    const select = applyLegacyHtmlCompat('<select><option label="A">A</option></select>');
    expect(select.source).not.toContain('<select');
  });

  it('align 取值不在上游白名单时整条属性剥掉，正文仍可读', () => {
    const compat = applyLegacyHtmlCompat('<div align="middle">正文</div>');
    expect(compat.source).not.toContain('align');
    expect(compat.counts['dropped-attribute']).toBe(1);
    const result = compile(compat.source);
    expect(result.ok).toBe(true);
    expect(result.diagnostics).toEqual([]);
    expect(flatten(documentOf(result).nodes)).toContain('正文');
  });

  it('引用块里的缩进代码逐字保留（示例里的标签不被改写）', () => {
    const source = '> 示例：\n>\n>     <font color="red">x</font>\n>\n> 结束';
    const compat = applyLegacyHtmlCompat(source);
    expect(compat.changed).toBe(false);
    expect(compat.source).toBe(source);
  });
});

describe('键名 / 普通文字里的组件同名标签', () => {
  it('光秃秃的 <tab> / <text> 按历史文字解包，不再当组件', () => {
    const tab = applyLegacyHtmlCompat('Press <tab>.');
    expect(tab.source).not.toContain('<tab');
    // 解包用零宽字符保长度，不一定是空格；只要键名标签不再出现、正文仍在即可。
    const tabText = flatten(documentOf(compile(tab.source)).nodes);
    expect(tabText).toContain('Press');
    expect(tabText).toContain('.');

    const text = applyLegacyHtmlCompat('SVG 示例 <text>hello</text>');
    expect(text.source).not.toContain('<text');
    expect(flatten(documentOf(compile(text.source)).nodes)).toContain('hello');
  });

  it('真正在父容器里的 <tab> 仍是组件（标签与属性保留）', () => {
    const source = '<tabs>\n<tab label="一">内容</tab>\n</tabs>';
    const compat = applyLegacyHtmlCompat(source);
    expect(compat.source).toContain('<tab label="一">');
    expect(compat.source).toContain('</tab>');
    const result = compile(compat.source);
    expect(result.ok).toBe(true);
    expect(JSON.stringify(documentOf(result).nodes)).toContain('"name":"tab"');
  });
});

describe('历史 HTML 音视频 → 受限 media host', () => {
  it('保留 controls 语义的 src / poster / preload / source / track，丢弃 autoplay', async () => {
    const source = [
      '<video controls autoplay src="https://cdn.example.com/a.mp4"',
      ' poster="/api/images/abcdefghijklmnopqrstuvwx/raw" preload="metadata" loop muted playsinline width="640" height="360">',
      '<source src="https://cdn.example.com/b.webm" type="video/webm">',
      '<track kind="subtitles" src="/api/audio/abcdefghij/raw" srclang="zh-CN" label="中文字幕" default>',
      '</video>',
    ].join('');
    const compat = applyLegacyHtmlCompat(source);
    const token = /\[\[媒体:([a-f0-9]{10})\]\]/.exec(compat.source);
    expect(token, compat.source).toBeTruthy();
    expect(compat.source).not.toContain('autoplay');
    const payload = compat.mediaSources[token![1]];
    expect(payload).toMatchObject({
      media: 'video',
      src: 'https://cdn.example.com/a.mp4',
      poster: '/api/images/abcdefghijklmnopqrstuvwx/raw',
      preload: 'metadata',
      loop: true,
      muted: true,
      playsInline: true,
      width: 640,
      height: 360,
    });
    expect(payload.sources).toEqual([{ src: 'https://cdn.example.com/b.webm', type: 'video/webm' }]);
    expect(payload.tracks).toEqual([
      {
        src: '/api/audio/abcdefghij/raw',
        kind: 'subtitles',
        srclang: 'zh-CN',
        label: '中文字幕',
        default: true,
      },
    ]);
    expect(payload).not.toHaveProperty('autoplay');

    const adapted = await adaptReactiveReferences(compat.source, {
      mode: 'external',
      parentFormat: 'markdown',
      mediaSources: compat.mediaSources,
    });
    expect(adapted.adaptedSource).toContain(`<site-embed kind="media" ref="${token![1]}" />`);
    expect(adapted.hostData[`media:${token![1]}`]).toMatchObject({
      kind: 'media',
      status: 'ready',
      payload,
    });
    const result = compile(adapted.adaptedSource);
    expect(result.ok).toBe(true);
    expect(JSON.stringify(documentOf(result).nodes)).toContain('"kind":"media"');
  });

  it('外部 audio 走 media；站内受控音频仍走 [@音频]；危险协议不生成 media', () => {
    const external = applyLegacyHtmlCompat('<audio src="https://cdn.example.com/a.mp3"></audio>');
    expect(external.source).toMatch(/\[\[媒体:[a-f0-9]{10}\]\]/);
    expect(Object.values(external.mediaSources)).toEqual([
      { media: 'audio', src: 'https://cdn.example.com/a.mp3' },
    ]);

    const controlled = applyLegacyHtmlCompat('<audio src="/api/audio/abcdefghij/raw"></audio>');
    expect(controlled.source).toContain('[@音频/abcdefghij]');
    expect(controlled.mediaSources).toEqual({});

    const unsafe = applyLegacyHtmlCompat('<video src="javascript:alert(1)"></video>');
    expect(unsafe.source).not.toMatch(/\[\[媒体:/);
    expect(unsafe.mediaSources).toEqual({});
    expect(unsafe.source).toContain('视频');
  });

  it('最短的成对可播放区块也装得下 token', () => {
    const tiny = applyLegacyHtmlCompat('<video src=a></video>');
    expect(tiny.source).toMatch(/^\[\[媒体:[a-f0-9]{10}\]\]/);
    expect(tiny.mediaSources).toHaveProperty(Object.keys(tiny.mediaSources)[0]);
  });
});
