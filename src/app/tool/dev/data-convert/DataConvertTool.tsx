'use client';

// 数据转换：JSON / YAML / CSV 互转。
//
// 解析与序列化全在 `src/lib/dev-tools/data-convert.ts`（js-yaml + 自写 CSV）。
// 页面只做三件事：选方向、把错误文案摆出来、把「有损项」写在下面。
// 有损项清单来自库里的 `DATA_CONVERT_LOSS_NOTES`，不是这里另抄一份 —— 转换规则
// 改了而说明没改，是这类工具最常见的谎话。
import { useMemo, useState } from 'react';
import {
  CSV_DELIMITER_OPTIONS,
  DATA_CONVERT_LOSS_NOTES,
  DATA_FORMAT_OPTIONS,
  DataConvertError,
  convertData,
  type CsvDelimiterOption,
  type DataConvertStats,
  type DataFormat,
} from '@/lib/dev-tools/data-convert';

function labelOf(format: DataFormat): string {
  return DATA_FORMAT_OPTIONS.find((option) => option.value === format)?.label ?? format;
}

/** 换一个与 `current` 不同的格式（源 / 目标不能相同）。 */
function otherFormat(current: DataFormat): DataFormat {
  return DATA_FORMAT_OPTIONS.map((option) => option.value).find((value) => value !== current) ?? 'json';
}

function statsText(stats: DataConvertStats): string {
  const parts: string[] = [];
  if (stats.rowCount !== undefined) parts.push(`${stats.rowCount} 行`);
  if (stats.columnCount !== undefined) parts.push(`${stats.columnCount} 列`);
  return parts.join(' × ');
}

export default function DataConvertTool() {
  const [from, setFrom] = useState<DataFormat>('json');
  const [to, setTo] = useState<DataFormat>('yaml');
  const [delimiter, setDelimiter] = useState<CsvDelimiterOption>('auto');
  const [input, setInput] = useState('');
  const [output, setOutput] = useState('');
  const [stats, setStats] = useState<DataConvertStats | null>(null);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');

  const csvInvolved = from === 'csv' || to === 'csv';
  const delimiterHint = useMemo(() => {
    if (!csvInvolved) return '';
    if (delimiter === 'auto') {
      return from === 'csv' ? '读取 CSV 时自动识别逗号 / 制表符 / 分号，写 CSV 时用逗号。' : '写 CSV 使用逗号。';
    }
    return '读取与写入 CSV 都使用这个分隔符。';
  }, [csvInvolved, delimiter, from]);

  function changeFrom(next: DataFormat) {
    setFrom(next);
    if (next === to) setTo(otherFormat(next));
    setOutput('');
    setStats(null);
    setError('');
    setStatus('');
  }

  function changeTo(next: DataFormat) {
    setTo(next);
    if (next === from) setFrom(otherFormat(next));
    setOutput('');
    setStats(null);
    setError('');
    setStatus('');
  }

  function runConvert() {
    setOutput('');
    setStats(null);
    setError('');
    setStatus('');
    try {
      const result = convertData(input, from, to, {
        csvDelimiter: csvInvolved ? delimiter : undefined,
      });
      setOutput(result.output);
      setStats(result.stats);
      setStatus('转换完成');
    } catch (e) {
      setError(e instanceof DataConvertError ? e.message : '转换失败：出现了未能识别的错误');
    }
  }

  function swapFormats() {
    setFrom(to);
    setTo(from);
    // 输出正是「新源格式」的文本，顺带带进输入框，方便继续往下转。
    if (output !== '') {
      setInput(output);
      setOutput('');
      setStats(null);
      setError('');
      setStatus('已交换方向，并把上一次的结果带进输入');
    } else {
      // 没有结果可带进输入时也要清掉旧错误/旧统计：切了方向，旧结果就不再生效（R3-483）。
      setOutput('');
      setStats(null);
      setError('');
      setStatus('已交换方向');
    }
  }

  async function copyOutput() {
    if (output === '') {
      setStatus('还没有可复制的结果');
      return;
    }
    try {
      await navigator.clipboard.writeText(output);
      setStatus('已复制');
    } catch {
      setStatus('复制失败');
    }
  }

  return (
    <div className="devtool-stack">
      <div className="tool-panel">
        <div className="devtool-bar">
          <label className="form-label" htmlFor="devtool-convert-from">
            源格式
          </label>
          <select
            id="devtool-convert-from"
            className="form-select devtool-select"
            value={from}
            onChange={(event) => changeFrom(event.target.value as DataFormat)}
          >
            {DATA_FORMAT_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <label className="form-label" htmlFor="devtool-convert-to">
            目标格式
          </label>
          <select
            id="devtool-convert-to"
            className="form-select devtool-select"
            value={to}
            onChange={(event) => changeTo(event.target.value as DataFormat)}
          >
            {DATA_FORMAT_OPTIONS.filter((option) => option.value !== from).map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          {csvInvolved && (
            <>
              <label className="form-label" htmlFor="devtool-convert-delimiter">
                CSV 分隔符
              </label>
              <select
                id="devtool-convert-delimiter"
                className="form-select devtool-select"
                value={delimiter}
                onChange={(event) => {
                  setDelimiter(event.target.value as CsvDelimiterOption);
                  // 分隔符参与解析 / 序列化，旧结果立即失效（R3-483）。
                  setOutput('');
                  setStats(null);
                  setError('');
                  setStatus('');
                }}
              >
                {CSV_DELIMITER_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </>
          )}
          <span className="devtool-bar__spacer" />
          <span className="devtool-status">{status}</span>
        </div>

        <div className="devtool-bar">
          <button type="button" className="btn btn-primary" onClick={runConvert}>
            转换
          </button>
          <button type="button" className="btn btn-outline-secondary" onClick={swapFormats}>
            交换方向
          </button>
          <button
            type="button"
            className="btn btn-outline-secondary"
            onClick={copyOutput}
            disabled={output === ''}
          >
            复制结果
          </button>
          {csvInvolved && <span className="devtool-hint">{delimiterHint}</span>}
        </div>
      </div>

      <div className="devtool-split">
        <div className="tool-panel">
          <label className="form-label" htmlFor="devtool-convert-input">
            输入（{labelOf(from)}）
          </label>
          <textarea
            id="devtool-convert-input"
            className="devtool-input"
            rows={16}
            value={input}
            spellCheck={false}
            onChange={(event) => {
              setInput(event.target.value);
              setOutput('');
              setStats(null);
              setError('');
              setStatus('');
            }}
            placeholder={
              from === 'csv'
                ? 'a,b\n1,2'
                : from === 'yaml'
                  ? 'a: 1\nb:\n  - x'
                  : '{"a":1,"b":[2,3]}'
            }
          />
        </div>
        <div className="tool-panel">
          <div className="devtool-bar">
            <span className="form-label">输出（{labelOf(to)}）</span>
            <span className="devtool-bar__spacer" />
            {stats !== null && statsText(stats) !== '' && (
              <span className="devtool-badge">{statsText(stats)}</span>
            )}
          </div>
          {output === '' ? (
            <p className="devtool-hint">转换结果会显示在这里。</p>
          ) : (
            <pre id="devtool-convert-output" className="devtool-output">{output}</pre>
          )}
        </div>
      </div>

      {error !== '' && <p className="devtool-error">{error}</p>}

      <section className="tool-panel">
        <h2 className="devtool-subtitle">有损项</h2>
        <p className="devtool-hint">转换不是无损的，下面这些信息会丢失或改变形状：</p>
        <ul className="devtool-notes">
          {DATA_CONVERT_LOSS_NOTES.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      </section>
    </div>
  );
}
