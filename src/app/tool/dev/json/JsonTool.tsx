'use client';

// JSON 格式化与校验。
//
// 全部计算在浏览器本地完成（`src/lib/dev-tools/json.ts`），这里只负责输入、按钮与
// 结果展示。错误不落成裸异常：`parseJsonText` 已经把 V8 的 message 翻译成中文，
// 并给出「第几行第几列 + 附近片段（带 ^）」，这里原样渲染。
import { useMemo, useState } from 'react';
import {
  JSON_MAX_BYTES,
  countJsonNodes,
  exceedsJsonSizeLimit,
  formatJson,
  minifyJson,
  parseJsonText,
  utf8ByteLength,
  type JsonErrorLocation,
  type JsonIndent,
} from '@/lib/dev-tools/json';

const INDENT_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: '2', label: '2 空格' },
  { value: '4', label: '4 空格' },
  { value: 'tab', label: 'Tab' },
];

type OutputState =
  | { kind: 'empty' }
  | { kind: 'ok'; text: string; copyable: boolean }
  | { kind: 'error'; message: string; location: JsonErrorLocation | null };

function parseIndent(raw: string): JsonIndent {
  if (raw === 'tab') return 'tab';
  return raw === '4' ? 4 : 2;
}

function sizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function typeLabel(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return '数组';
  switch (typeof value) {
    case 'string':
      return '字符串';
    case 'number':
      return '数字';
    case 'boolean':
      return '布尔值';
    default:
      return '对象';
  }
}

export default function JsonTool() {
  const [input, setInput] = useState('');
  const [indentRaw, setIndentRaw] = useState('2');
  const [sortKeys, setSortKeys] = useState(false);
  const [output, setOutput] = useState<OutputState>({ kind: 'empty' });
  const [status, setStatus] = useState('');

  const inputBytes = useMemo(() => utf8ByteLength(input), [input]);
  const tooLarge = useMemo(() => exceedsJsonSizeLimit(input), [input]);

  function run(mode: 'format' | 'minify' | 'validate') {
    if (input.trim() === '') {
      setOutput({ kind: 'error', message: '输入为空', location: null });
      setStatus('');
      return;
    }
    if (tooLarge) {
      setOutput({
        kind: 'error',
        message: `输入约 ${sizeLabel(inputBytes)}，超过 ${sizeLabel(JSON_MAX_BYTES)} 上限，请先精简后再处理`,
        location: null,
      });
      setStatus('');
      return;
    }

    if (mode === 'validate') {
      const parsed = parseJsonText(input);
      if (!parsed.ok) {
        setOutput({ kind: 'error', message: parsed.message, location: parsed.location });
        setStatus('');
        return;
      }
      setOutput({
        kind: 'ok',
        copyable: false,
        text: `校验通过：合法 JSON。根类型 ${typeLabel(parsed.value)}，共 ${countJsonNodes(parsed.value)} 个节点。`,
      });
      setStatus('校验通过');
      return;
    }

    const result =
      mode === 'format'
        ? formatJson(input, { indent: parseIndent(indentRaw), sortKeys })
        : minifyJson(input);

    if (!result.ok) {
      setOutput({ kind: 'error', message: result.message, location: result.location });
      setStatus('');
      return;
    }
    setOutput({ kind: 'ok', copyable: true, text: result.output });
    setStatus(mode === 'format' ? '已格式化' : '已压缩');
  }

  async function copyOutput() {
    if (output.kind !== 'ok' || !output.copyable) return;
    try {
      await navigator.clipboard.writeText(output.text);
      setStatus('已复制');
    } catch {
      setStatus('复制失败');
    }
  }

  return (
    <div className="devtool-stack">
      <div className="devtool-split devtool-split--left">
        <div className="tool-panel">
        <div className="devtool-bar">
          <label className="form-label" htmlFor="devtool-json-input">
            输入
          </label>
          <span className="devtool-bar__spacer" />
          <span className="devtool-status">
            {input.length} 字符 · {sizeLabel(inputBytes)}
          </span>
        </div>
        <textarea
          id="devtool-json-input"
          className="devtool-input"
          rows={16}
          value={input}
          spellCheck={false}
          onChange={(event) => {
            setInput(event.target.value);
            setOutput({ kind: 'empty' });
            setStatus('');
          }}
          placeholder={'把 JSON 粘贴到这里，然后点「格式化」「压缩」或「校验」'}
        />
        {tooLarge ? (
          <p className="devtool-error">
            输入超过 {sizeLabel(JSON_MAX_BYTES)} 上限（当前约 {sizeLabel(inputBytes)}）。本工具在浏览器本地计算，
            超大 JSON 会卡住页面，请先精简。
          </p>
        ) : (
          <p className="devtool-hint">
            上限 {sizeLabel(JSON_MAX_BYTES)}；输入全程留在本机，不会上传。
          </p>
        )}
      </div>

      <div className="tool-panel">
        <div className="devtool-bar">
          <button type="button" className="btn btn-primary" onClick={() => run('format')}>
            格式化
          </button>
          <button type="button" className="btn btn-outline-secondary" onClick={() => run('minify')}>
            压缩
          </button>
          <button type="button" className="btn btn-outline-secondary" onClick={() => run('validate')}>
            校验
          </button>
          <button
            type="button"
            className="btn btn-outline-secondary"
            onClick={copyOutput}
            disabled={output.kind !== 'ok' || !output.copyable}
          >
            复制结果
          </button>
        </div>

        <div className="devtool-bar">
          <label className="form-label" htmlFor="devtool-json-indent">
            缩进
          </label>
          <select
            id="devtool-json-indent"
            className="form-select devtool-select"
            value={indentRaw}
            onChange={(event) => {
              setIndentRaw(event.target.value);
              // 缩进影响输出排版：旧结果 / 旧状态立即失效（R3-483）。
              setOutput({ kind: 'empty' });
              setStatus('');
            }}
          >
            {INDENT_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <div className="form-check">
            <input
              className="form-check-input"
              type="checkbox"
              id="devtool-json-sort"
              checked={sortKeys}
              onChange={(event) => {
                setSortKeys(event.target.checked);
                // 排序选项影响格式化输出：与缩进切换同口径，旧结果失效。
                setOutput({ kind: 'empty' });
                setStatus('');
              }}
            />
            <label className="form-check-label" htmlFor="devtool-json-sort">
              按键名排序
            </label>
          </div>
          <span className="devtool-bar__spacer" />
          <span className="devtool-status">{status}</span>
        </div>

        {output.kind === 'empty' ? (
          <p className="devtool-hint">结果会显示在这里。</p>
        ) : output.kind === 'ok' ? (
          <pre className="devtool-output">{output.text}</pre>
        ) : (
          <div className="devtool-error-block">
            <p className="devtool-error">{output.message}</p>
            {output.location && (
              <>
                <p className="devtool-hint">
                  第 {output.location.line} 行第 {output.location.column} 列（字符偏移{' '}
                  {output.location.position}）
                </p>
                <pre className="devtool-output devtool-output--error">{output.location.snippet}</pre>
              </>
            )}
          </div>
        )}
        </div>
      </div>
    </div>
  );
}
