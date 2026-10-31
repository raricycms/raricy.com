'use client';

// 文本工具：统计 + 大小写转换 + 行操作。
//
// 所有操作都**写回同一个 textarea**（不做左右两栏），因为行操作是链式的 ——
// 排序后去重、去重后去空行，用户会连续点。统计随输入实时更新。
import { useMemo, useState } from 'react';
import {
  analyzeText,
  applyLineOp,
  TEXT_LINE_OPS,
  TEXT_TRANSFORMS,
  transformText,
} from '@/lib/dev-tools/text';

const STAT_ITEMS = [
  { key: 'chars', label: '字符数' },
  { key: 'charsNoWhitespace', label: '不含空白字符' },
  { key: 'lines', label: '行数' },
  { key: 'nonEmptyLines', label: '非空行' },
  { key: 'paragraphs', label: '段落数' },
] as const;

export default function TextTool() {
  const [text, setText] = useState('');
  const [status, setStatus] = useState('');

  const stats = useMemo(() => analyzeText(text), [text]);

  async function copyText(): Promise<void> {
    if (text === '') return;
    try {
      await navigator.clipboard.writeText(text);
      setStatus('已复制文本');
    } catch {
      setStatus('复制失败（浏览器未授予剪贴板权限）');
    }
  }

  return (
    <div>
      <label className="form-label" htmlFor="text-source">
        文本
      </label>
      <textarea
        id="text-source"
        className="devtool-input"
        rows={12}
        value={text}
        onChange={(event) => setText(event.target.value)}
        placeholder="在这里输入或粘贴文本；所有转换都直接改这段内容"
      />

      <div className="devtool-text__stats">
        {STAT_ITEMS.map((item) => (
          <div className="devtool-text__stat" key={item.key}>
            <span className="devtool-text__stat-value">{stats[item.key]}</span>
            <span className="devtool-text__stat-label">{item.label}</span>
          </div>
        ))}
      </div>

      <h2 className="devtool-code__subhead">转换</h2>
      <div className="devtool-actions">
        {TEXT_TRANSFORMS.map((transform) => (
          <button
            type="button"
            className="btn btn-sm btn-outline-secondary"
            key={transform.value}
            onClick={() => {
              setText((prev) => transformText(prev, transform.value));
              setStatus(`已应用：${transform.label}`);
            }}
            disabled={text === ''}
          >
            {transform.label}
          </button>
        ))}
      </div>

      <h2 className="devtool-code__subhead">行操作</h2>
      <div className="devtool-actions">
        {TEXT_LINE_OPS.map((op) => (
          <button
            type="button"
            className="btn btn-sm btn-outline-secondary"
            key={op.value}
            onClick={() => {
              setText((prev) => applyLineOp(prev, op.value));
              setStatus(`已应用：${op.label}`);
            }}
            disabled={text === ''}
          >
            {op.label}
          </button>
        ))}
      </div>

      <div className="devtool-bar">
        <button type="button" className="btn btn-sm btn-primary" onClick={copyText} disabled={text === ''}>
          复制文本
        </button>
        <button
          type="button"
          className="btn btn-sm btn-outline-secondary"
          onClick={() => {
            setText('');
            setStatus('');
          }}
          disabled={text === ''}
        >
          清空
        </button>
      </div>

      <p className="devtool-hint">
        排序按字符编码顺序（与系统语言环境无关）；去重保留首次出现的位置；行号格式为
        「1. 内容」，加行号与去行号可互相还原。
      </p>
      <p className="devtool-status">{status}</p>
    </div>
  );
}
