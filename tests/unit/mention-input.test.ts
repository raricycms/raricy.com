// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest';
import { act, createElement, useRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import MentionInput from '@/app/components/MentionInput';
import type { MentionScope } from '@/lib/mention-shared';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];

afterEach(() => {
  act(() => { for (const root of roots.splice(0)) root.unmount(); });
  document.body.replaceChildren();
});

function mount(kind: MentionScope['kind'], initialValue = '') {
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
