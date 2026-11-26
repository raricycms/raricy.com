// ─────────────────────────────────────────────────────────────────────────────
// chat-rmd-interpolation-literals.test.ts — 聊天把表达式降级为字面文本
//
// 未声明标识符不能把整条消息拖回源码：表格 / 标题等结构照常渲染，`{{ … }}`
// 只在原位显示为文本；代码、公式与普通 Markdown 不受影响。
// ─────────────────────────────────────────────────────────────────────────────

import { describe, expect, it } from 'vitest';
import type { LocalDocument, LocalNode } from 'reactive-md';
import {
  maskChatExpressionLiterals,
  restoreChatExpressionLiterals,
} from '@/lib/chat-rmd/interpolation-literals';
import { applyChatDocumentPolicy } from '@/lib/chat-rmd/document-policy';
import { CHAT_RMD_COMPILE_OPTIONS } from '@/lib/chat-rmd/options';
import { compileSource } from '@/lib/reactive/compile-source';

function compileChat(source: string): LocalDocument {
  const masked = maskChatExpressionLiterals(source, CHAT_RMD_COMPILE_OPTIONS);
  expect(masked.source.length).toBe(source.length);
  const result = compileSource(masked.source, CHAT_RMD_COMPILE_OPTIONS, 'final');
  expect(result.ok, JSON.stringify(result)).toBe(true);
  if (!result.ok) throw new Error('unreachable');
  if (masked.masked) restoreChatExpressionLiterals(result.document, source);
  expect(result.document.source).toBe(source);
  const policy = applyChatDocumentPolicy(result.document);
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

describe('maskChatExpressionLiterals', () => {
  it('未声明标识符的表格保留结构，只有表达式显示为文本', () => {
    const source = [
      '| Item | Cost |',
      '| --- | ---: |',
      '| Venue | {{ venueCost }} |',
      '| Materials | {{ materialsCost }} |',
      '| Promotion | {{ promoSpend }} |',
      '| Refreshments | {{ refreshmentSpend }} |',
    ].join('\n');
    const document = compileChat(source);

    expect(collectNodes(document.nodes, 'table')).toHaveLength(1);
    expect(collectNodes(document.nodes, 'tableRow')).toHaveLength(5);
    expect(collectText(document.nodes)).toContain('{{ venueCost }}');
    expect(collectText(document.nodes)).toContain('{{ refreshmentSpend }}');
    expect(collectText(document.nodes)).not.toContain('\uE100');
  });

  it('表头插值与乘法表达式同样按字面文本渲染', () => {
    const document = compileChat(
      ['| {{ header }} | b |', '| --- | --- |', '| 1 | {{ price * qty }} |'].join('\n')
    );

    expect(collectNodes(document.nodes, 'table')).toHaveLength(1);
    expect(collectText(document.nodes)).toContain('{{ header }}');
    expect(collectText(document.nodes)).toContain('{{ price * qty }}');
    expect(collectNodes(document.nodes, 'emphasis')).toHaveLength(0);
  });

  it('含插值的属性不再拖垮组件之外的正文', () => {
    const document = compileChat(
      ['前文', '', '<panel title="{{ c }}">正文</panel>', '', '后文'].join('\n')
    );

    const paragraphs = collectNodes(document.nodes, 'paragraph');
    expect(paragraphs).toHaveLength(2);
    expect(collectText(document.nodes)).toContain('<panel title="{{ c }}">正文</panel>');
    expect(collectNodes(document.nodes, 'component')).toHaveLength(0);
  });

  it('代码与公式里的花括号保持原样，不触发掩码', () => {
    const code = '`{{ x }}` 与 ${{ a }}$';
    const masked = maskChatExpressionLiterals(code, CHAT_RMD_COMPILE_OPTIONS);
    expect(masked.masked).toBe(false);

    const document = compileChat(code);
    expect(collectNodes(document.nodes, 'inlineCode')[0]?.value).toBe('{{ x }}');
    expect(collectNodes(document.nodes, 'inlineMath')[0]?.value).toBe('{{ a }}');
  });

  it('未闭合插值不掩码，仍走原有编译预算', () => {
    const masked = maskChatExpressionLiterals('text {{ unclosed', CHAT_RMD_COMPILE_OPTIONS);
    expect(masked.masked).toBe(false);
    expect(masked.source).toBe('text {{ unclosed');
  });

  it('掩码后的源码切片仍指向原文', () => {
    const source = [
      '| a |',
      '| --- |',
      '| {{ x }} |',
      '',
      '![外链](https://evil.example/x.png)',
    ].join('\n');
    const document = compileChat(source);

    expect(collectText(document.nodes)).toContain('![外链](https://evil.example/x.png)');
    expect(collectText(document.nodes)).toContain('{{ x }}');
  });
});