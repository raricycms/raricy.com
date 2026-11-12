// ─────────────────────────────────────────────────────────────────────────────
// reactive-mixed-content.test.ts —— 无缝混写：普通多行 Markdown 追加组件后，
// 原有排版（软换行 / 公式 / 引用 / 代码 / 列表）不得改变。
//
// 判据是编译后的**结构**（break / inlineMath / image 节点），不是 textContent：
// 折行丢失时文本往往相同，只有结构能发现。浏览器层的 `<br>` / 几何另由 e2e 覆盖。
// ─────────────────────────────────────────────────────────────────────────────

import { describe, expect, it } from 'vitest';
import { compileLocal, type LocalDocument } from 'reactive-md';
import { REACTIVE_COMPILE_OPTIONS } from '@/lib/reactive/host-components';
import { expandDocumentReferences } from '@/lib/reactive/ref-adapter';

const BASE = [
  '# 标题',
  '',
  '第一行',
  '第二行（与上一行之间只有一个换行）',
  '',
  '公式 $x_1 + y_2$ 与行内引用 [@1234567890]。',
  '',
  '> 引用块',
  '> 第二行',
  '',
  '- 列表一',
  '- 列表二',
  '',
  '```js',
  'const a = 1;',
  '```',
].join('\n');

async function compile(source: string): Promise<LocalDocument> {
  const result = compileLocal(source, REACTIVE_COMPILE_OPTIONS);
  if (!result.ok) throw new Error(result.diagnostics.map((d) => d.code).join(','));
  return (await expandDocumentReferences(result.document, { mode: 'external' })).document;
}

function stripIds<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => stripIds(item)) as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (key === 'id') continue;
      out[key] = stripIds(item);
    }
    return out as T;
  }
  return value;
}

function counts(document: LocalDocument) {
  const out = { break: 0, inlineMath: 0, image: 0, code: 0, blockquote: 0, list: 0 };
  const walk = (nodes: LocalDocument['nodes']): void => {
    for (const node of nodes) {
      if (node.type === 'break') out.break += 1;
      if (node.type === 'inlineMath') out.inlineMath += 1;
      if (node.type === 'image') out.image += 1;
      if (node.type === 'code') out.code += 1;
      if (node.type === 'blockquote') out.blockquote += 1;
      if (node.type === 'list') out.list += 1;
      if (node.children) walk(node.children);
    }
  };
  walk(document.nodes);
  return out;
}

describe('无缝混写：format 自动升级前后排版一致', () => {
  // 「Markdown 与 Reactive 使用同一套软换行规则」这条已在 reactive-compile.test.ts
  // 「format 不再切换编译选项：同一份源码命中同一份编译结果」里从缓存键一侧钉住
  // （R4 去重，原断言就是 localCompileOptionsKey 相等）。

  it('★ 追加组件后，原有 break / 公式 / 图片引用结构逐项不变 ★', async () => {
    const before = await compile(BASE);
    const after = await compile(`${BASE}\n\n<counter bind="n" label="N" initial="1" />`);

    expect(counts(after)).toMatchObject(counts(before));
    // 前 N 个节点是原有正文；追加的组件只应在末尾。
    expect(after.nodes.length).toBeGreaterThan(before.nodes.length);
    expect(stripIds(after.nodes.slice(0, before.nodes.length))).toEqual(stripIds(before.nodes));
    expect(counts(before).break).toBeGreaterThan(0);
    expect(counts(before).inlineMath).toBe(1);
    expect(counts(before).image).toBe(1);
    expect(counts(before).code).toBe(1);
    expect(counts(before).blockquote).toBe(1);
    expect(counts(before).list).toBe(1);
  });

  it('删除组件不会自动降级格式，排版同样不变', async () => {
    const withComponent = `${BASE}\n\n<counter bind="n" label="N" initial="1" />`;
    const again = await compile(withComponent.replace(/\n\n<counter[^\n]*>/, ''));
    expect(stripIds(again.nodes)).toEqual(stripIds((await compile(BASE)).nodes));
  });
});
