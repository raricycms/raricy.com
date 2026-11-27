// ─────────────────────────────────────────────────────────────────────────────
// chat-rmd-options.test.ts — 聊天编译配置、0.9.3 嵌入档位与 URL 策略
//
// 钉住聊天的能力边界：不启用作者 CSS / JS / 扩展 HTML；表达式按字面文本编译，
// 未支持组件就地降级（onUnsupported: 'fallback'），合法兄弟节点保留；配置与
// `reactive-md/react/minimal` 的默认宿主同键。链接只放行站内路径、http(s)、
// mailto；图片只放行同源受控前缀。
// ─────────────────────────────────────────────────────────────────────────────

import { describe, expect, it } from 'vitest';
import { compileLocal, type LocalNode } from 'reactive-md';
import { createReactHost } from 'reactive-md/react/minimal';
import { createLocalConfig } from 'reactive-md/sdk';
import { minimalPreset } from 'reactive-md/presets/minimal';
import {
  CHAT_RMD_COMPILE_CONFIG,
  CHAT_RMD_COMPILE_CONFIG_KEY,
} from '@/lib/chat-rmd/compiler-config';
import { CHAT_RMD_COMPILE_OPTIONS, chatReactiveUrlPolicy } from '@/lib/chat-rmd/options';

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

describe('CHAT_RMD_COMPILE_OPTIONS', () => {
  it('冻结聊天专用配置与预算', () => {
    expect(CHAT_RMD_COMPILE_OPTIONS.config).toBe(CHAT_RMD_COMPILE_CONFIG);
    expect(CHAT_RMD_COMPILE_OPTIONS.strict).toBe(false);
    expect(CHAT_RMD_COMPILE_OPTIONS.markdownBreaks).toBe(true);
    expect(CHAT_RMD_COMPILE_OPTIONS.enableCss).toBe(false);
    expect(CHAT_RMD_COMPILE_OPTIONS.enableJavaScript).toBe(false);
    expect(CHAT_RMD_COMPILE_OPTIONS.enableExtendedHtml).toBe(false);
    expect(CHAT_RMD_COMPILE_OPTIONS.hostComponents).toBeUndefined();
    expect(CHAT_RMD_COMPILE_OPTIONS.limits).toEqual({
      maxSyntaxNodes: 10_000,
      maxParseWork: 1_000_000,
      maxMarkdownDepth: 64,
    });
  });

  it('嵌入档位：字面表达式 + 局部降级，不整体关闭交互组件', () => {
    expect(CHAT_RMD_COMPILE_OPTIONS.embedding).toEqual({
      expressions: 'literal',
      onUnsupported: 'fallback',
      allowImages: false,
    });
    // allowInteractive 不在编译档位整体关闭：静态组件要保留，交互组件的收缩
    // 交给 document-policy 的允许列表。
    expect(CHAT_RMD_COMPILE_OPTIONS.embedding?.allowInteractive).toBeUndefined();
  });

  it('配置键稳定，且与 react/minimal 默认宿主一致', () => {
    expect(CHAT_RMD_COMPILE_CONFIG.key).toBe(CHAT_RMD_COMPILE_CONFIG_KEY);
    expect(createLocalConfig({ presets: [minimalPreset] }).key).toBe(CHAT_RMD_COMPILE_CONFIG_KEY);
    expect(createReactHost().reactConfig.config.key).toBe(CHAT_RMD_COMPILE_CONFIG_KEY);
  });
});

describe('0.9.3 嵌入档位的编译行为', () => {
  it('表达式按字面文本编译，表格不再整段回退源码', () => {
    const source = [
      '| Item | Cost |',
      '| --- | ---: |',
      '| Venue | {{ venueCost }} |',
      '| Materials | {{ materialsCost }} |',
    ].join('\n');
    const result = compileLocal(source, CHAT_RMD_COMPILE_OPTIONS);
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) throw new Error('unreachable');

    const types = collectTypes(result.document.nodes);
    expect(types.has('table')).toBe(true);
    expect(types.has('fallback')).toBe(false);
    expect(collectText(result.document.nodes)).toContain('{{ venueCost }}');
    expect(collectText(result.document.nodes)).toContain('{{ materialsCost }}');
    expect(result.document.requiresRuntime).toBe(false);
  });

  it('坏属性的 alert 局部降级，合法 alert 仍是组件', () => {
    const source = '前文\n\n<alert tone="nope">坏</alert> <alert>好</alert>\n\n后文';
    const result = compileLocal(source, CHAT_RMD_COMPILE_OPTIONS);
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) throw new Error('unreachable');

    const document = result.document;
    const alerts = collectNodes(document.nodes, 'component').filter(
      (node) => node.name === 'alert'
    );
    expect(alerts).toHaveLength(1);
    expect(collectText(alerts[0].children ?? [])).toBe('好');
    expect(collectNodes(document.nodes, 'fallback').map((node) => node.value)).toEqual([
      '<alert tone="nope">坏</alert>',
    ]);
    // 不存在包裹整条消息的 fallback，前后文照常渲染。
    expect(collectNodes(document.nodes, 'fallback').some((node) => node.value === source)).toBe(
      false
    );
    expect(collectText(document.nodes)).toContain('前文');
    expect(collectText(document.nodes)).toContain('后文');
    expect(document.requiresRuntime).toBe(false);
  });
});

describe('chatReactiveUrlPolicy — link', () => {
  const allowed = [
    '/chat/abc',
    '/',
    '#top',
    '#',
    'https://example.com/a?b=1#c',
    'http://example.com',
    'HTTPS://Example.COM/Path',
    'mailto:a@b.c',
  ];

  it.each(allowed)('放行 %s', (url) => {
    expect(chatReactiveUrlPolicy(url, 'link')).toBe(true);
  });

  const rejected = [
    '',
    '//evil.example/x',
    '///evil.example/x',
    '/\\evil.example/x',
    '/chat\\x',
    '/chat\nx',
    '/chat x',
    'foo/bar',
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'file:///etc/passwd',
    'vbscript:msgbox(1)',
    'blob:https://example.com/uuid',
    'https://user:pass@example.com/',
    'https://exa mple.com/',
    'https://example.com/\u0000',
    'mailto:',
    `/${'a'.repeat(8192)}`,
  ];

  it.each(rejected)('拒绝 %s', (url) => {
    expect(chatReactiveUrlPolicy(url, 'link')).toBe(false);
  });

  it('长度 8192 以内仍接受', () => {
    expect(chatReactiveUrlPolicy(`/${'a'.repeat(8191)}`, 'link')).toBe(true);
  });
});

describe('chatReactiveUrlPolicy — image', () => {
  const allowed = [
    '/api/images/abc/raw',
    '/api/stickers/collection/name',
    '/static/emoji/smile.svg',
  ];

  it.each(allowed)('放行同源受控路径 %s', (url) => {
    expect(chatReactiveUrlPolicy(url, 'image')).toBe(true);
  });

  const rejected = [
    // 头像 / 头像框只由宿主 Avatar 组件取数，不进入文档 URL 策略；
    // `/api/avatar/` 字面量另有 avatar-sites-guard 守（只许在 avatar-refs.ts）。
    '/api/avatar/u1',
    '/api/frames/frame-key',
    'https://raricy.com/api/images/abc/raw',
    'http://evil.example/x.png',
    '//raricy.com/api/images/abc/raw',
    '/\\raricy.com/api/images/abc/raw',
    '/api/audio/abc',
    '/api/images/../admin',
    '/api/images/%2e%2e/admin',
    '/api/images/%E0%A4%A',
    '/static/emoji/../../etc/passwd',
    '/static/other/x.svg',
    'data:image/png;base64,AAAA',
    'blob:https://raricy.com/uuid',
    '/api/images/abc/raw\n',
  ];

  it.each(rejected)('拒绝 %s', (url) => {
    expect(chatReactiveUrlPolicy(url, 'image')).toBe(false);
  });
});