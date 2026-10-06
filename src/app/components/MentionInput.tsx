'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { activeMention, type MentionScope, type MentionUser } from '@/lib/mention-shared';
import { insertAtRange } from './textarea-insert';

/** 共用输入框的 @ 提示；搜索防抖、取消过期请求，选择只替换光标处的那一个 token。 */
export default function MentionInput({
  scope, textareaRef, onTextChange, ...props
}: Omit<React.TextareaHTMLAttributes<HTMLTextAreaElement>, 'value'> & {
  value: string;
  scope: MentionScope | null;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  onTextChange: (text: string) => void;
}) {
  const listId = useId();
  const pickerRef = useRef<HTMLDivElement>(null);
  const [focused, setFocused] = useState(false);
  const [composing, setComposing] = useState(false);
  const [caret, setCaret] = useState({ start: 0, end: 0 });
  const [dismissed, setDismissed] = useState('');
  const [selected, setSelected] = useState(0);
  const [result, setResult] = useState<{ key: string; users: MentionUser[]; failed?: boolean }>({ key: '', users: [] });
  const mention = focused && !composing && scope
    ? activeMention(props.value, caret.start, caret.end) : null;
  const key = mention && scope ? `${scope.kind}:${scope.id}:${mention.start}:${mention.query}` : '';
  const open = !!key && key !== dismissed;
  const users = result.key === key ? result.users : [];
  const ready = result.key === key;
  const selectedIndex = Math.min(selected, Math.max(0, users.length - 1));
  const kind = scope?.kind;
  const scopeId = scope?.id;
  const query = mention?.query;

  useEffect(() => {
    const picker = pickerRef.current;
    const option = picker?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (!picker || !option) return;
    // 只滚候选列表，不把下面的评论区或整个页面一起滚走。
    const top = option.offsetTop;
    const bottom = top + option.offsetHeight;
    if (top < picker.scrollTop) picker.scrollTop = top;
    else if (bottom > picker.scrollTop + picker.clientHeight) picker.scrollTop = bottom - picker.clientHeight;
  }, [open, users, selectedIndex]);

  useEffect(() => {
    if (!open || !kind || !scopeId || query === undefined) return;
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      try {
        const params = new URLSearchParams({ kind, id: scopeId, q: query });
        const response = await fetch(`/api/mentions/users?${params}`, { signal: controller.signal });
        if (!response.ok) throw new Error('mention search failed');
        const data = await response.json() as { users: MentionUser[] };
        if (!controller.signal.aborted) {
          setResult({ key, users: data.users });
          setSelected(0);
        }
      } catch {
        if (!controller.signal.aborted) setResult({ key, users: [], failed: true });
      }
    }, 180);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [open, kind, scopeId, query, key]);

  function updateCaret(el: HTMLTextAreaElement) {
    setCaret({ start: el.selectionStart, end: el.selectionEnd });
  }

  function pick(user: MentionUser) {
    if (!mention) return;
    const end = props.value[mention.end] === ' ' ? mention.end + 1 : mention.end;
    onTextChange(insertAtRange(textareaRef.current, props.value, `@${user.username} `, { start: mention.start, end }));
    setDismissed(key);
  }

  return (
    <div className="mention-input">
      <textarea
        {...props}
        ref={textareaRef}
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open && users.length ? `${listId}-${selectedIndex}` : undefined}
        onFocus={(e) => { setFocused(true); updateCaret(e.currentTarget); props.onFocus?.(e); }}
        onBlur={(e) => { setFocused(false); props.onBlur?.(e); }}
        onChange={(e) => { setDismissed(''); updateCaret(e.currentTarget); props.onChange?.(e); }}
        onSelect={(e) => { updateCaret(e.currentTarget); props.onSelect?.(e); }}
        onCompositionStart={(e) => { setComposing(true); props.onCompositionStart?.(e); }}
        onCompositionEnd={(e) => { setComposing(false); updateCaret(e.currentTarget); props.onCompositionEnd?.(e); }}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing || composing) return;
          if (open) {
            if (e.key === 'Escape') { e.preventDefault(); setDismissed(key); return; }
            if (users.length && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
              e.preventDefault();
              setSelected((selectedIndex + (e.key === 'ArrowDown' ? 1 : -1) + users.length) % users.length);
              return;
            }
            if (!e.shiftKey && (e.key === 'Enter' || e.key === 'Tab') && users.length) {
              e.preventDefault(); pick(users[selectedIndex]); return;
            }
            // 请求未完成时 Enter 也不发送，避免用户本想选人却发出半截评论。
            if (e.key === 'Enter' && !e.shiftKey && !ready) { e.preventDefault(); return; }
          }
          props.onKeyDown?.(e);
        }}
      />
      {open && (
        <div className="mention-picker" ref={pickerRef}>
          <div className="mention-picker__hint">选择要 @ 的用户 · ↑↓ 选择，Enter 确认</div>
          <div id={listId} role="listbox" aria-label="提及用户">
            {users.map((user, index) => (
              <button
                key={user.id}
                id={`${listId}-${index}`}
                type="button"
                role="option"
                aria-selected={index === selectedIndex}
                className={`mention-picker__option${index === selectedIndex ? ' is-active' : ''}`}
                onPointerDown={(e) => { if (e.button === 0) e.preventDefault(); }}
                // 触屏阻止 pointerdown 默认行为后，兼容 click 可能不再产生。
                // 统一在主指针释放时选择；键盘激活（detail=0）仍走 click，避免重复插入。
                onPointerUp={(e) => { if (e.button === 0) { e.preventDefault(); pick(user); } }}
                onMouseEnter={() => setSelected(index)}
                onClick={(e) => { if (e.detail === 0) pick(user); }}
              >@{user.username}</button>
            ))}
          </div>
          {!users.length && <div className="mention-picker__empty" role="status">
            {!ready ? '搜索中…' : result.failed ? '暂时无法搜索用户' : '没有可提及的用户'}
          </div>}
        </div>
      )}
    </div>
  );
}
