// ─────────────────────────────────────────────────────────────────────────────
// chat-rmd-options.test.ts — 聊天编译配置与 URL 策略
//
// 钉住 M0 冻结的数值与「不跟着博客放宽」的边界：聊天不启用作者 CSS / JS / 扩展
// HTML；链接只放行站内路径、http(s)、mailto；图片只放行同源受控前缀。
// ─────────────────────────────────────────────────────────────────────────────

import { describe, expect, it } from 'vitest';
import {
  CHAT_RMD_COMPILE_OPTIONS,
  CHAT_RMD_COMPILER_VERSION,
  CHAT_RMD_OPTIONS_VERSION,
  chatReactiveUrlPolicy,
} from '@/lib/chat-rmd/options';

describe('CHAT_RMD_COMPILE_OPTIONS', () => {
  it('冻结聊天专用配置与预算', () => {
    expect(CHAT_RMD_COMPILE_OPTIONS).toEqual({
      strict: false,
      markdownBreaks: true,
      enableCss: false,
      enableJavaScript: false,
      enableExtendedHtml: false,
      limits: {
        maxSyntaxNodes: 10_000,
        maxParseWork: 1_000_000,
        maxMarkdownDepth: 64,
      },
    });
    expect(CHAT_RMD_COMPILE_OPTIONS.hostComponents).toBeUndefined();
    expect(CHAT_RMD_COMPILE_OPTIONS.config).toBeUndefined();
  });

  it('导出稳定的版本身份', () => {
    expect(CHAT_RMD_COMPILER_VERSION).toBe('reactive-md/0.9.2');
    expect(CHAT_RMD_OPTIONS_VERSION).toBe('chat-rmd/1');
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