'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

const MAX_OPTIONS = 10;
const MIN_OPTIONS = 2;

export default function VoteCreate() {
  const router = useRouter();
  const [title, setTitle] = useState('');
  const [options, setOptions] = useState<string[]>(['', '']);
  const [loading, setLoading] = useState(false);
  const optionInputsRef = useRef<(HTMLInputElement | null)[]>([]);

  function setOption(i: number, value: string) {
    setOptions((prev) => prev.map((o, idx) => (idx === i ? value : o)));
  }

  function addOption() {
    if (options.length >= MAX_OPTIONS) {
      alert('最多只能添加10个选项');
      return;
    }
    setOptions((prev) => {
      const next = [...prev, ''];
      // 与 Flask 一致：新增选项后自动聚焦到新生成的输入框
      requestAnimationFrame(() => {
        optionInputsRef.current[next.length - 1]?.focus();
      });
      return next;
    });
  }

  function removeOption(i: number) {
    setOptions((prev) => prev.filter((_, idx) => idx !== i));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();

    const t = title.trim();
    const opts = options.map((o) => o.trim()).filter((v) => v !== '');

    if (!t) {
      alert('请输入投票标题');
      return;
    }
    if (opts.length < MIN_OPTIONS) {
      alert(`至少需要${MIN_OPTIONS}个选项`);
      return;
    }
    if (opts.length > MAX_OPTIONS) {
      alert(`最多只能有${MAX_OPTIONS}个选项`);
      return;
    }

    setLoading(true);
    try {
      const resp = await fetch('/api/votes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ title: t, options: opts }),
      });
      const result = await resp.json();
      if (resp.ok && result.code === 200) {
        router.push('/vote/' + result.data.id);
        router.refresh();
      } else {
        alert('创建失败：' + (result.message || '未知错误'));
      }
    } catch (err) {
      console.error(err);
      alert('出错了，请稍后再试');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="vote-page">
      <h1 className="vote-title">创建投票</h1>

      <div className="vote-form">
        <form id="createForm" onSubmit={submit}>
          <div className="vote-form__group">
            <label htmlFor="title">
              投票标题 <span className="vote-form__hint">（1-200字）</span>
            </label>
            <input
              type="text"
              id="title"
              name="title"
              placeholder="请输入投票标题"
              maxLength={200}
              required
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>

          <div className="vote-form__group">
            <label>
              投票选项 <span className="vote-form__hint">（2-10个选项，每个1-200字）</span>
            </label>
            <div className="vote-form__options" id="optionsContainer">
              {options.map((opt, i) => (
                <div className="vote-form__option-row" key={i}>
                  <input
                    ref={(el) => {
                      optionInputsRef.current[i] = el;
                    }}
                    type="text"
                    className="vote-option-input"
                    placeholder={`选项 ${i + 1}`}
                    maxLength={200}
                    required
                    value={opt}
                    onChange={(e) => setOption(i, e.target.value)}
                  />
                  <button
                    type="button"
                    className="vote-form__remove-option"
                    title="移除"
                    style={{ display: options.length <= MIN_OPTIONS ? 'none' : '' }}
                    onClick={() => removeOption(i)}
                  >
                    &times;
                  </button>
                </div>
              ))}
            </div>
            <button type="button" className="vote-form__add-option" id="addOption" onClick={addOption}>
              + 添加选项
            </button>
          </div>

          <button type="submit" className="vote-form__submit" disabled={loading}>
            {loading ? '创建中……' : '创建投票'}
          </button>
        </form>
      </div>
    </div>
  );
}
