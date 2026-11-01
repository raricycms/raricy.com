// ─────────────────────────────────────────────────────────────────────────────
// reactive-catalog-matrix.test.ts —— 本站 Components 目录的每个可插入模板
// 都必须能经过「统一 compat + 编译」而不产生未知组件 / 结构错误。
//
// 目录来自上游 `getNativeComponentCatalog('zh')`（与编辑器菜单同一份事实）；
// 模板里的 bind / selection / caret 占位按工具栏实际插入方式实例化。
// 这同时钉住 `multi-select` / `choices` / `quiz` 的 `<option>` 子结构不被
// legacy-compat 当成旧 HTML 解包。
// ─────────────────────────────────────────────────────────────────────────────

import { describe, expect, it } from 'vitest';
import { getNativeComponentCatalog, renderNativeSnippet } from 'reactive-md/authoring';
import { compileLocal, type LocalDocument } from 'reactive-md';
import { reactiveCompileOptions } from '@/lib/reactive/host-components';
import { applyLegacyHtmlCompat } from '@/lib/reactive/legacy-compat';

function instantiate(component: ReturnType<typeof getNativeComponentCatalog>['components'][number]): string {
  return renderNativeSnippet(component, '')
    .replace(/\{\{selection(?::(.*?))?\}\}/g, '$1')
    .replace(/\{\{caret\}\}/g, '')
    .replace(/\{\{select:(.*?)\}\}/g, '$1');
}

function componentNames(document: LocalDocument): string[] {
  const names: string[] = [];
  const walk = (nodes: LocalDocument['nodes']): void => {
    for (const node of nodes) {
      if (node.type === 'component' && node.name) names.push(node.name);
      if (node.children) walk(node.children);
    }
  };
  walk(document.nodes);
  return names;
}

describe('Components 目录模板 × 统一编译管线', () => {
  const catalog = getNativeComponentCatalog('zh');

  it('★ 目录非空，且每个模板都真的编译成对应组件节点 ★', () => {
    expect(catalog.components.length).toBeGreaterThan(20);
    for (const component of catalog.components) {
      const source = instantiate(component);
      const compat = applyLegacyHtmlCompat(source);
      // 只断言 ok 不够：section / table / progress 被当成历史 HTML 解包后同样 ok，
      // 但组件语义已经永久丢失。这里必须看到真实 component 节点。
      expect(compat.source, `${component.id} 的标签被 compat 改写`).toContain(`<${component.id}`);
      const result = compileLocal(compat.source, reactiveCompileOptions('reactive'));
      const codes = result.diagnostics.map((d) => d.code);
      expect(result.ok, `${component.id}: ${codes.join(', ')}`).toBe(true);
      expect(codes, component.id).not.toContain('local.component.unknown');
      if (!result.ok) continue; // 上面的断言已失败；这里只为类型收窄
      expect(componentNames(result.document), component.id).toContain(component.id);
    }
  });

  it('旧 HTML 的 <select><option> 仍按历史标签处理，不误当组件子结构', () => {
    const compat = applyLegacyHtmlCompat('<select><option value="a">A</option></select>');
    expect(compat.source).not.toContain('<option');
    expect(compileLocal(compat.source, reactiveCompileOptions('markdown')).ok).toBe(true);
  });
});
