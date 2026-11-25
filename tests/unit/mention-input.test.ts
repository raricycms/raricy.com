// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, createElement, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import MentionInput from '@/app/components/MentionInput';
import type { MentionScope } from '@/lib/mention-shared';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];

afterEach(() => {
  act(() => { for (const root of roots.splice(0)) root.unmount(); });
  document.body.replaceChildren();
});

function mount(
  kind: MentionScope['kind'],
  initialValue = '',
  onKeyDown?: (e: ReactKeyboardEvent<HTMLTextAreaElement>) => void
) {
  function Composer() {
    const [text, setText] = useState(initialValue);
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    return createElement('div', null,
      createElement(MentionInput, {
        value: text,
        scope: { kind, id: 'ime-test' },
        textareaRef,
        onTextChange: setText,
        onChange: (e) => setText(e.currentTarget.value),
        onKeyDown,
      }),
      createElement('output', null, text),
    );
  }

  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  act(() => { root.render(createElement(Composer)); });
  const input = container.querySelector('textarea')!;
  act(() => { input.focus(); });
  return { input, output: container.querySelector('output')! };
}

// 浏览器/输入法写 DOM 不经过 React 的 value tracker；直接 input.value = ... 会让
// React 误以为自己已经见过新值，测不到真实的 onChange 与受控值回写。
function browserValue(input: HTMLTextAreaElement, value: string, caret = value.length) {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, value);
  input.setSelectionRange(caret, caret);
}

function fire(input: HTMLTextAreaElement, event: Event) {
  // 每个原生事件后都允许 React 完成一次更新；把整段组字包在同一个 act 中会
  // 把 compositionend 与 input 合批，掩盖最终汉字被旧 props.value 覆盖的问题。
  act(() => { input.dispatchEvent(event); });
}

function composing(input: HTMLTextAreaElement, type: 'compositionstart' | 'compositionend', data = '') {
  fire(input, new CompositionEvent(type, { bubbles: true, data }));
}

function notifyInput(input: HTMLTextAreaElement, isComposing: boolean) {
  fire(input, new InputEvent('input', {
    bubbles: true, inputType: 'insertCompositionText', isComposing,
  }));
}

/**
 * 造一次 keydown。`isComposing` / `keyCode` 是**事件对象自己的属性**，用 defineProperty
 * 钉住：jsdom 的构造字典对它们的支持随版本而变，钉住才不依赖环境（同
 * md-editor-resource-panel.test.ts 的写法）。
 */
function keydown(
  input: HTMLTextAreaElement,
  key: string,
  init: { keyCode?: number; isComposing?: boolean } = {}
): KeyboardEvent {
  const ev = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  if (init.keyCode !== undefined) Object.defineProperty(ev, 'keyCode', { value: init.keyCode, configurable: true });
  if (init.isComposing !== undefined) Object.defineProperty(ev, 'isComposing', { value: init.isComposing, configurable: true });
  fire(input, ev);
  return ev;
}

/** 让出一个宏任务（守卫的复位挂在 setTimeout(0) 上）。 */
async function nextTask(): Promise<void> {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

describe.each(['comment', 'chat'] as const)('%s 输入框的中文组字', (kind) => {
  it.each([
    ['compositionend → input', ['end', 'input']],
    ['input → compositionend', ['input', 'end']],
    ['input → compositionend → input', ['input', 'end', 'input']],
  ] as const)('%s：选词后保留汉字及光标两边的正文', (_name, sequence) => {
    const { input, output } = mount(kind, '前文  后文');
    composing(input, 'compositionstart');
    browserValue(input, '前文 ni 后文', 5);
    notifyInput(input, true);
    expect(output.textContent).toBe('前文 ni 后文');

    // 选中候选词后 DOM 已有汉字，但最后一个 input 事件可能尚未通知 React。
    browserValue(input, '前文 你好 后文', 5);
    let ended = false;
    for (const event of sequence) {
      if (event === 'end') {
        composing(input, 'compositionend', '你好');
        ended = true;
      } else {
        // 这里只通知，绝不再次写 value，否则会把已经丢掉的字人为补回去。
        notifyInput(input, !ended);
      }
    }

    expect(input.value).toBe('前文 你好 后文');
    expect(output.textContent).toBe('前文 你好 后文');
    expect(input.selectionStart).toBe(5);
    expect(input.selectionEnd).toBe(5);
  });

  it('没有中间 input 事件时，直接选词仍能进入草稿', () => {
    const { input, output } = mount(kind);
    composing(input, 'compositionstart');
    browserValue(input, '你好');
    composing(input, 'compositionend', '你好');
    notifyInput(input, false);
    expect(input.value).toBe('你好');
    expect(output.textContent).toBe('你好');
  });

  it('取消组字时保留输入框实际文本，不把拼音或 event.data 拼回正文', () => {
    const { input, output } = mount(kind, '原文');
    composing(input, 'compositionstart');
    browserValue(input, '原文ni');
    notifyInput(input, true);
    browserValue(input, '原文');
    composing(input, 'compositionend');
    notifyInput(input, false);
    expect(input.value).toBe('原文');
    expect(output.textContent).toBe('原文');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 组字的确认键不许交给调用方（讨论区 / 评论区的 Enter 发送）
//
// 【为什么单测】macOS Safari 把「结束组字的那一下 keydown」排在 compositionend
// **之后**发，那一下的 isComposing 已经是 false（WebKit bug 165004，修过一次又被
// bug 317127 关掉）。只判原生标志时，中文用户打英文、按 Enter 确认候选词，这一下
// 会被当成正常回车交给 RichComposer —— 消息当场发出，草稿连同挂着的图片 / 引用
// 一起被清掉。
//
// 这几条钉的是「那一下真的没被交出去」，以及「只吞紧接着的一下、不粘住」：
// 粘住的表现是「打完字再按回车没反应」，与误发一样是 bug。
//
// 【不是真 IME 验证】这里合成的是事件，真 Safari 只能人手动敲。
// ─────────────────────────────────────────────────────────────────────────────
describe('组字确认键不交给调用方', () => {
  it('★ Safari 顺序（compositionend → keydown）：确认键不触发发送，也不拦默认动作 ★', () => {
    const onKeyDown = vi.fn();
    const { input } = mount('chat', '', onKeyDown);

    composing(input, 'compositionstart');
    // Safari：compositionend 先把标志复位，紧接着才是那一下 keydown
    composing(input, 'compositionend', 'hello');
    const enter = keydown(input, 'Enter');

    expect(onKeyDown, '确认候选词的 Enter 被当成正常回车交出去了（消息会当场发出）').not.toHaveBeenCalled();
    expect(enter.defaultPrevented, '拦了默认动作：候选词会被取消').toBe(false);
  });

  it('守卫不粘住：下一个宏任务之后的正常 Enter 照常交给调用方', async () => {
    const onKeyDown = vi.fn();
    const { input } = mount('chat', '', onKeyDown);

    composing(input, 'compositionstart');
    composing(input, 'compositionend', 'hello');
    await nextTask();

    keydown(input, 'Enter');
    expect(onKeyDown).toHaveBeenCalledTimes(1);
  });

  it('没有 composition 事件、只有 keyCode 229 的确认键也让开', () => {
    const onKeyDown = vi.fn();
    const { input } = mount('chat', '', onKeyDown);

    const enter = keydown(input, 'Enter', { keyCode: 229 });
    expect(onKeyDown).not.toHaveBeenCalled();
    expect(enter.defaultPrevented).toBe(false);
  });

  it('组字中（isComposing=true）同样不交给调用方', () => {
    const onKeyDown = vi.fn();
    const { input } = mount('chat', '', onKeyDown);

    keydown(input, 'Enter', { isComposing: true });
    expect(onKeyDown).not.toHaveBeenCalled();
  });
});
