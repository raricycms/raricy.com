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

import { describe, expect, it } from 'vitest';
import { compileLocal, type LocalNode } from 'reactive-md';
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

  it('历史 data 位图转成 Markdown 图片，仍在受限 URL 策略内', () => {
    const source = `<p>前面</p><img src="${PNG_1PX}" alt="示意图"><p>后面</p>`;
    const { compat, result } = compatCompile(source);
    expect(compat.counts['data-image']).toBe(1);
    expect(result.ok).toBe(true);
    const json = JSON.stringify(documentOf(result).nodes);
    expect(json).toContain('data:image/png;base64,');
    expect(documentOf(result).nodes.some((node) => JSON.stringify(node).includes('"type":"image"'))).toBe(true);
    expect(isAllowedReactiveUrl(PNG_1PX, 'image')).toBe(true);
    expect(isAllowedReactiveUrl(PNG_1PX, 'link')).toBe(false);
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

  it('未配对数学不会被当成标签处理，且不吞掉后半句', () => {
    const valid = '公式 $a<b$ 结尾';
    expect(applyLegacyHtmlCompat(valid).source).toBe(valid);

    const unpaired = '公式 $x 没配对，还有 **后半句**';
    const { compat, result } = compatCompile(unpaired);
    expect(compat.counts['unpaired-math']).toBe(1);
    expect(result.ok).toBe(true);
    expect(flatten(documentOf(result).nodes)).toContain('后半句');
    const json = JSON.stringify(documentOf(result).nodes);
    expect(json).not.toContain('"type":"inlineMath"');
  });

  it('旧 HTML 音视频：站内音频变引用 token，外链变链接', () => {
    const audio = applyLegacyHtmlCompat(
      '<audio controls src="/api/audio/abcdefghij/raw"></audio>'
    );
    expect(audio.source).toContain('[@音频/abcdefghij]');

    const video = applyLegacyHtmlCompat('<video src="https://example.com/a.mp4"></video>');
    expect(video.source).toContain('[视频](https://example.com/a.mp4)');
  });

  it('不支持的 class 剥掉后不再触发 attribute 回退', () => {
    const { result } = compatCompile('<div class="x">正文</div>');
    expect(result.ok).toBe(true);
    expect(result.diagnostics).toEqual([]);
  });

  it('javascript: 链接不再以原样标签进入文档', () => {
    const { result } = compatCompile('<a href="javascript:alert(1)">点我</a>');
    expect(result.ok).toBe(true);
    const json = JSON.stringify(documentOf(result).nodes);
    expect(json).not.toContain('javascript:');
    expect(flatten(documentOf(result).nodes)).toContain('点我');
  });
});
