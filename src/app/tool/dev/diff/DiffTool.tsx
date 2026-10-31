'use client';

// 文本 Diff：左右两段文本逐行对比。
//
// 算法与统计在 `src/lib/dev-tools/diff.ts`（行 LCS）。页面只负责选项、结果列表与
// 复制 unified diff。
//
// 两个容易误解的点写在页面上：
//   · 末尾换行不参与比较（`"a\n"` 与 `"a"` 都算一行）；
//   · 忽略大小写 / 行尾空白只影响“是否算同一行”，不修改展示的原文。
import { useMemo, useState } from 'react';
import {
  DIFF_MAX_LINES,
  DiffLimitError,
  computeDiff,
  countLines,
  formatUnifiedDiff,
  type DiffResult,
} from '@/lib/dev-tools/diff';

/** 结果列表最多渲染多少行（「仅差异行」时可能仍有上万行）。 */
const DIFF_DISPLAY_LIMIT = 5000;

function signOf(type: DiffResult['lines'][number]['type']): string {
  if (type === 'add') return '+';
  if (type === 'remove') return '-';
  return ' ';
}

export default function DiffTool() {
  const [left, setLeft] = useState('');
  const [right, setRight] = useState('');
  const [ignoreCase, setIgnoreCase] = useState(false);
  const [ignoreTrailingWhitespace, setIgnoreTrailingWhitespace] = useState(false);
  const [onlyDiff, setOnlyDiff] = useState(false);
  const [result, setResult] = useState<DiffResult | null>(null);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');

  const leftLines = useMemo(() => countLines(left), [left]);
  const rightLines = useMemo(() => countLines(right), [right]);
  const leftTooLong = leftLines > DIFF_MAX_LINES;
  const rightTooLong = rightLines > DIFF_MAX_LINES;

  function runCompare() {
    setResult(null);
    setError('');
    setStatus('');
    if (leftTooLong || rightTooLong) {
      setError(
        `每侧最多 ${DIFF_MAX_LINES} 行：左侧 ${leftLines} 行、右侧 ${rightLines} 行，请先精简。`,
      );
      return;
    }
    try {
      const diff = computeDiff(left, right, { ignoreCase, ignoreTrailingWhitespace });
      setResult(diff);
      setStatus(
        diff.identical
          ? '两段文本一致'
          : `新增 ${diff.stats.added} 行，删除 ${diff.stats.removed} 行，相同 ${diff.stats.unchanged} 行`,
      );
    } catch (e) {
      setError(e instanceof DiffLimitError ? e.message : '对比失败：出现了未能识别的错误');
    }
  }

  function swapSides() {
    setLeft(right);
    setRight(left);
    setResult(null);
    setError('');
    setStatus('已交换两侧');
  }

  async function copyUnified() {
    if (result === null) {
      setStatus('先点「对比」生成差异');
      return;
    }
    const unified = formatUnifiedDiff(result);
    if (unified === '') {
      setStatus('两段文本一致，没有可复制的差异');
      return;
    }
    try {
      await navigator.clipboard.writeText(unified);
      setStatus('已复制 unified diff');
    } catch {
      setStatus('复制失败');
    }
  }

  const visibleLines = result === null ? [] : onlyDiff ? result.lines.filter((line) => line.type !== 'equal') : result.lines;
  const shownLines = visibleLines.slice(0, DIFF_DISPLAY_LIMIT);
  const rowsTruncated = visibleLines.length > DIFF_DISPLAY_LIMIT;

  return (
    <div className="devtool-stack">
      <div className="tool-panel">
        <div className="devtool-bar">
          <button type="button" className="btn btn-primary" onClick={runCompare}>
            对比
          </button>
          <button type="button" className="btn btn-outline-secondary" onClick={copyUnified}>
            复制 unified diff
          </button>
          <button type="button" className="btn btn-outline-secondary" onClick={swapSides}>
            交换两侧
          </button>
          <div className="form-check">
            <input
              className="form-check-input"
              type="checkbox"
              id="devtool-diff-ignore-case"
              checked={ignoreCase}
              onChange={(event) => setIgnoreCase(event.target.checked)}
            />
            <label className="form-check-label" htmlFor="devtool-diff-ignore-case">
              忽略大小写
            </label>
          </div>
          <div className="form-check">
            <input
              className="form-check-input"
              type="checkbox"
              id="devtool-diff-ignore-trailing"
              checked={ignoreTrailingWhitespace}
              onChange={(event) => setIgnoreTrailingWhitespace(event.target.checked)}
            />
            <label className="form-check-label" htmlFor="devtool-diff-ignore-trailing">
              忽略行尾空白
            </label>
          </div>
          <div className="form-check">
            <input
              className="form-check-input"
              type="checkbox"
              id="devtool-diff-only"
              checked={onlyDiff}
              onChange={(event) => setOnlyDiff(event.target.checked)}
            />
            <label className="form-check-label" htmlFor="devtool-diff-only">
              仅差异行
            </label>
          </div>
          <span className="devtool-bar__spacer" />
          <span className="devtool-status">{status}</span>
        </div>

        <div className="devtool-split">
          <div>
            <label className="form-label" htmlFor="devtool-diff-left">
              原文本
            </label>
            <textarea
              id="devtool-diff-left"
              className="devtool-input"
              rows={14}
              value={left}
              spellCheck={false}
              onChange={(event) => {
                setLeft(event.target.value);
                setResult(null);
                setError('');
                setStatus('');
              }}
              placeholder="左侧文本"
            />
            <p className={leftTooLong ? 'devtool-error' : 'devtool-hint'}>
              {leftLines} 行
              {leftTooLong ? `，超过 ${DIFF_MAX_LINES} 行上限` : ''}
            </p>
          </div>
          <div>
            <label className="form-label" htmlFor="devtool-diff-right">
              新文本
            </label>
            <textarea
              id="devtool-diff-right"
              className="devtool-input"
              rows={14}
              value={right}
              spellCheck={false}
              onChange={(event) => {
                setRight(event.target.value);
                setResult(null);
                setError('');
                setStatus('');
              }}
              placeholder="右侧文本"
            />
            <p className={rightTooLong ? 'devtool-error' : 'devtool-hint'}>
              {rightLines} 行
              {rightTooLong ? `，超过 ${DIFF_MAX_LINES} 行上限` : ''}
            </p>
          </div>
        </div>
      </div>

      {error !== '' && <p className="devtool-error">{error}</p>}

      {result !== null && (
        <div className="tool-panel">
          <div className="devtool-bar">
            <span className="devtool-badge devtool-badge--ok">新增 {result.stats.added}</span>
            <span className="devtool-badge devtool-badge--danger">删除 {result.stats.removed}</span>
            <span className="devtool-badge">相同 {result.stats.unchanged}</span>
            {result.simplified && (
              <span className="devtool-badge devtool-badge--warn">差异过大，已退化为整块替换</span>
            )}
          </div>

          {result.identical ? (
            <p className="devtool-output devtool-output--ok">两段文本完全一致。</p>
          ) : shownLines.length === 0 ? (
            <p className="devtool-hint">没有差异行。</p>
          ) : (
            <div className="devtool-diff">
              {shownLines.map((line, index) => (
                <div
                  className={`devtool-diff__row devtool-diff__row--${line.type}`}
                  key={`${index}-${line.type}-${line.oldLine ?? 'x'}-${line.newLine ?? 'x'}`}
                >
                  <span className="devtool-diff__line-no">{line.oldLine ?? ''}</span>
                  <span className="devtool-diff__line-no">{line.newLine ?? ''}</span>
                  <span className="devtool-diff__sign">{signOf(line.type)}</span>
                  <span className="devtool-diff__text">{line.text === '' ? '\u00a0' : line.text}</span>
                </div>
              ))}
            </div>
          )}

          {rowsTruncated && (
            <p className="devtool-hint">
              结果共 {visibleLines.length} 行，只渲染前 {DIFF_DISPLAY_LIMIT} 行；复制 unified diff 不受影响。
            </p>
          )}
          <p className="devtool-hint">
            末尾换行不参与比较；忽略选项只影响“是否算同一行”，展示的仍是原文。复制出的 unified diff
            每侧带 3 行上下文。
          </p>
        </div>
      )}
    </div>
  );
}
