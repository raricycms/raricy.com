import { expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { resolveBubbleKey, bubbleRentCost, parseBubbleKey } from '@/lib/bubble-refs';
import { parseRentCount } from '@/lib/shop-refs';
import ChatBubble from '@/app/components/ChatBubble';

it('有效期边界与免费默认：不认识的 key 一律降级，永久有效', () => {
  const now = new Date('2026-10-11T10:00:00Z');
  expect(resolveBubbleKey('blue-square', now, now)).toBe('blue-square');
  expect(resolveBubbleKey('blue-square', new Date(now.getTime() - 1), now)).toBeNull();
  expect(resolveBubbleKey('blue-square', null, now)).toBe('blue-square');
  expect(parseBubbleKey('blue-square malicious')).toBeNull();
  expect(resolveBubbleKey('unknown', null, now)).toBeNull();
  expect(bubbleRentCost('blue-square', 12)).toBe(120);
  expect(parseRentCount('month', '1e1')).toBeNull();
});
it('预览与消息只接受样式白名单，不将任意 key 拼入类名或 HTML', () => {
  const markup = renderToStaticMarkup(createElement(ChatBubble, { bubbleKey: 'blue-square', mentioned: true, children: '预览' }));
  expect(markup).toContain('data-bubble="blue-square"');
  expect(markup).toContain('chat-msg__content--mention');
  const invalid = renderToStaticMarkup(createElement(ChatBubble, { bubbleKey: '<img onerror=bad>', children: '默认' }));
  expect(invalid).not.toContain('data-bubble');
  expect(invalid).not.toContain('onerror');
});
