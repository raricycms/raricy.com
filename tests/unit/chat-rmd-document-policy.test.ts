// ─────────────────────────────────────────────────────────────────────────────
// chat-rmd-document-policy.test.ts — 聊天文档策略（静态安全边界）
//
// 用真实 reactive-md 编译结果验证「允许 Markdown + 公式」与「其余一律收缩为源码」：
// 原生图片、组件、表达式、HTML 通道、危险链接都不得留在 AST 里；能力开关与运行期
// 元数据必须清空，结果仍可 JSON 序列化（Worker postMessage 可克隆）。
// ─────────────────────────────────────────────────────────────────────────────

import { describe, expect, it } from 'vitest';
import type { LocalDocument, LocalNode } from 'reactive-md';
import {
  CHAT_RMD_POLICY_UNSUPPORTED,
  CHAT_RMD_POLICY_VERSION,
  applyChatDocumentPolicy,
} from '@/lib/chat-rmd/document-policy';
import { CHAT_RMD_COMPILE_OPTIONS } from '@/lib/chat-rmd/options';
import { compileSource } from '@/lib/reactive/compile-source';

function compileFinal(source: string): LocalDocument {
  const result = compileSource(source, CHAT_RMD_COMPILE_OPTIONS, 'final');
  expect(result.ok, JSON.stringify(result)).toBe(true);
  if (!result.ok) throw new Error('unreachable');
  return result.document;
}

function compiledPolicy(source: string): LocalDocument {
  const policy = applyChatDocumentPolicy(compileFinal(source));
  expect(policy.ok, JSON.stringify(policy)).toBe(true);
  if (!policy.ok) throw new Error('unreachable');
  return policy.document;
}

function collectNodes(nodes: readonly LocalNode[], type: string): LocalNode[] {
  const found: LocalNode[] = [];
  const walk = (list: readonly LocalNode[]) => {
    for (const node of list) {
      if (node.type === type) found.push(node);
      if (node.children) walk(node.children);
    }
  };
  walk(nodes);
  return found;
}

function collectTypes(nodes: readonly LocalNode[]): Set<string> {
  const types = new Set<string>();
  const walk = (list: readonly LocalNode[]) => {
    for (const node of list) {
      types.add(node.type);
      if (node.children) walk(node.children);
    }
  };
  walk(nodes);
  return types;
}

function collectText(nodes: readonly LocalNode[]): string {
  const parts: string[] = [];
  const walk = (list: readonly LocalNode[]) => {
    for (const node of list) {
      if (typeof node.value === 'string') parts.push(node.value);
      if (node.children) walk(node.children);
    }
  };
  walk(nodes);
  return parts.join('');
}

describe('允许的 Markdown 结构与公式', () => {
  it('保留标题、强调、代码、引用、列表、表格与公式', () => {
    const document = compiledPolicy(
      [
        '# 标题',
        '',
        '**粗** *斜* ~~删~~ `行内` [站内](/chat/1) [外链](https://example.com)',
        '',
        '> 引用',
        '',
        '- [x] 完成',
        '- 未完成',
        '',
        '| a | b |',
        '| --- | --- |',
        '| 1 | 2 |',
        '',
        '行内 $x^2$',
        '',
        '$$',
        'y = 1',
        '$$',
      ].join('\n')
    );

    const types = collectTypes(document.nodes);
    for (const expected of [
      'heading',
      'paragraph',
      'strong',
      'emphasis',
      'delete',
      'inlineCode',
      'link',
      'blockquote',
      'list',
      'listItem',
      'table',
      'tableRow',
      'tableCell',
      'inlineMath',
      'math',
    ]) {
      expect(types, `缺少 ${expected}`).toContain(expected);
    }
    expect(types).not.toContain('image');
    expect(collectNodes(document.nodes, 'link').map((node) => node.url)).toEqual([
      '/chat/1',
      'https://example.com',
    ]);
  });

  it('清空能力开关与运行期元数据', () => {
    const document = compiledPolicy('<number label="数量"/> 与 {{ 1 + 1 }}');
    expect(document.capabilities).toEqual({
      policy: { enableCss: false, enableJavaScript: false, enableExtendedHtml: false },
      styles: [],
      scripts: [],
      componentStyles: {},
      actionTargets: {},
    });
    expect(document.bindings).toEqual({});
    expect(document.initialState).toEqual({});
    expect(document.computations).toBeUndefined();
    expect(document.externals).toBeUndefined();
    expect(document.validations).toBeUndefined();
    expect(document.dynamicConstraints).toBeUndefined();
    expect(document.dependencies).toBeUndefined();
    expect(document.tableShapes).toBeUndefined();
    expect(document.componentDefinitions).toBeUndefined();
    expect(document.extensions).toBeUndefined();
    expect(document.kernel).toBeUndefined();
    expect(document.bindingSlots).toBeUndefined();
    expect(document.html).toEqual({
      enableCss: false,
      enableJavaScript: false,
      enableExtendedHtml: false,
    });
  });
});

describe('未批准节点转回字面量源码', () => {
  it('移除 Markdown 与 HTML 原生图片', () => {
    const document = compiledPolicy(
      [
        '前 ![外链](https://evil.example/x.png) 后',
        '![站内图](/api/images/abc/raw)',
        '<img src="https://evil.example/y.png">',
      ].join('\n\n')
    );

    expect(collectNodes(document.nodes, 'image')).toEqual([]);
    const text = collectText(document.nodes);
    expect(text).toContain('![外链](https://evil.example/x.png)');
    expect(text).toContain('![站内图](/api/images/abc/raw)');
    expect(text).toContain('<img src="https://evil.example/y.png">');
  });

  it('移除作者组件与表达式，并保留可读源码', () => {
    const document = compiledPolicy('<number label="数量"/> 与 {{ 1 + 1 }}');

    expect(collectNodes(document.nodes, 'component')).toEqual([]);
    expect(collectNodes(document.nodes, 'hostComponent')).toEqual([]);
    expect(collectNodes(document.nodes, 'interpolation')).toEqual([]);
    const text = collectText(document.nodes);
    expect(text).toContain('<number label="数量"/>');
    expect(text).toContain('{{ 1 + 1 }}');
  });

  it('移除 HTML 原生节点与 attrs，按源码显示', () => {
    const document = compiledPolicy('<span data-x="1">span</span>');

    expect(collectNodes(document.nodes, 'span')).toEqual([]);
    expect(collectText(document.nodes)).toContain('<span data-x="1">span</span>');
    expect(JSON.stringify(document)).not.toContain('"attrs"');
  });

  it('保留编译器自己的 fallback（按源码显示）节点', () => {
    const document = compiledPolicy('<callout>hi</callout>');
    expect(collectNodes(document.nodes, 'fallback').length).toBe(1);
  });

  it('style / script / iframe 只以 fallback 源码展示，不进入能力通道', () => {
    const document = compiledPolicy(
      [
        '<style>body{color:red}</style>',
        '',
        '<script>alert(1)</script>',
        '',
        '<iframe src="https://evil.example"></iframe>',
      ].join('\n')
    );

    const types = collectTypes(document.nodes);
    for (const forbidden of ['style', 'script', 'iframe', 'extendedHtml', 'htmlDocument']) {
      expect(types, `不应出现 ${forbidden}`).not.toContain(forbidden);
    }
    const text = collectText(document.nodes);
    expect(text).toContain('<style>body{color:red}</style>');
    expect(text).toContain('<script>alert(1)</script>');
    expect(text).toContain('<iframe src="https://evil.example"></iframe>');
    expect(document.capabilities?.styles).toEqual([]);
    expect(document.capabilities?.scripts).toEqual([]);
  });
});

describe('链接策略', () => {
  it('危险协议链接降级为可见文字', () => {
    const document = compiledPolicy(
      '[坏](javascript:alert(1)) [数据](data:text/html,x) [空]()'
    );

    const links = collectNodes(document.nodes, 'link');
    expect(links).toEqual([]);
    const text = collectText(document.nodes);
    expect(text).toContain('坏');
    expect(text).toContain('数据');
    expect(text).toContain('空');
    expect(text).not.toContain('javascript:');
    expect(text).not.toContain('data:');
  });

  it('站内、锚点、http(s) 与 mailto 链接保留', () => {
    const document = compiledPolicy(
      '[站内](/chat/1) [锚](#top) [外链](https://example.com) [邮件](mailto:a@b.c)'
    );

    expect(collectNodes(document.nodes, 'link').map((node) => node.url)).toEqual([
      '/chat/1',
      '#top',
      'https://example.com',
      'mailto:a@b.c',
    ]);
  });
});

describe('策略失败与可序列化', () => {
  it('无法取得源码的未批准节点返回 policy.unsupported', () => {
    const document: LocalDocument = {
      syntax: 'local',
      source: '',
      nodes: [
        {
          type: 'component',
          id: 'local-0',
          range: { start: 50, end: 80 },
          name: 'number',
        },
      ],
      initialState: {},
      bindings: {},
    };

    expect(applyChatDocumentPolicy(document)).toEqual({
      ok: false,
      code: CHAT_RMD_POLICY_UNSUPPORTED,
    });
  });

  it('手写的旧文档：能力与运行期元数据全部收缩', () => {
    const document = {
      syntax: 'local',
      source: '正文',
      syntaxVersion: 'local-draft-3',
      nodes: [
        {
          type: 'paragraph',
          id: 'local-1',
          range: { start: 0, end: 2 },
          attrs: { onclick: 'alert(1)' },
          children: [{ type: 'text', id: 'local-0', range: { start: 0, end: 2 }, value: '正文' }],
        },
      ],
      initialState: { '@local-1': 3 },
      bindings: { '@local-1': { family: 'number' } },
      capabilities: {
        policy: { enableCss: true, enableJavaScript: true, enableExtendedHtml: true },
        styles: [{ text: 'body{color:red}', range: { start: 0, end: 1 } }],
        scripts: [{ text: 'alert(1)', range: { start: 0, end: 1 } }],
        componentStyles: { chart: '.x{}' },
        actionTargets: { open: '/api/x' },
      },
      computations: { x: {} },
      externals: { y: {} },
      validations: [{}],
      dynamicConstraints: { 'local-1': { min: '0' } },
      dependencies: { 'local-1': ['x'] },
      tableShapes: { 'local-1': { header: [], rowIds: [] } },
      componentDefinitions: [{ name: 'chart' }],
      extensions: { components: ['chart'] },
      kernel: { valueRules: {}, slotRelations: [], retentionExclusions: [] },
      bindingSlots: { 'local-1': { x: '@local-1' } },
      theme: 'dark',
    } as unknown as LocalDocument;

    const policy = applyChatDocumentPolicy(document);
    expect(policy.ok).toBe(true);
    if (!policy.ok) throw new Error('unreachable');

    const sanitized = policy.document;
    expect(sanitized.nodes).toEqual([
      {
        type: 'paragraph',
        id: 'local-1',
        range: { start: 0, end: 2 },
        children: [{ type: 'text', id: 'local-0', range: { start: 0, end: 2 }, value: '正文' }],
      },
    ]);
    expect(sanitized.capabilities?.policy).toEqual({
      enableCss: false,
      enableJavaScript: false,
      enableExtendedHtml: false,
    });
    expect(sanitized.capabilities?.styles).toEqual([]);
    expect(sanitized.initialState).toEqual({});
    expect(sanitized.bindings).toEqual({});
    expect(sanitized.theme).toBeUndefined();
    expect(sanitized.syntaxVersion).toBe('local-draft-3');
  });

  it('输出可 JSON 往返（Worker postMessage 克隆约束）', () => {
    const document = compiledPolicy(
      '# 标题\n\n![图](https://evil.example/x.png)\n\n[坏](javascript:alert(1))'
    );
    expect(JSON.parse(JSON.stringify(document))).toEqual(document);
  });

  it('导出稳定的策略版本', () => {
    expect(CHAT_RMD_POLICY_VERSION).toBe('chat-rmd-policy/1');
  });
});