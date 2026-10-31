'use client';

import { useMemo, useState } from 'react';
import { EXTRACT_MAX_INPUT_CHARS, extractUrls } from '@/lib/dev-tools/url-tools';

/** 结果最多渲染这么多行：再多的 DOM 只会让页面发卡，复制全部仍然拿得到完整结果。 */
const DISPLAY_LIMIT = 500;

export default function ExtractUrlsTool() {
  const [text, setText] = useState('');
  const [dedupe, setDedupe] = useState(true);
  const [ignoreCase, setIgnoreCase] = useState(true);
  const [stripTracking, setStripTracking] = useState(true);
  const [sort, setSort] = useState(false);
  const [domainsOnly, setDomainsOnly] = useState(false);
  const [status, setStatus] = useState('');

  const result = useMemo(
    () => extractUrls(text, { dedupe, ignoreCase, stripTracking, sort, domainsOnly }),
    [text, dedupe, ignoreCase, stripTracking, sort, domainsOnly]
  );
  const shown = result.urls.slice(0, DISPLAY_LIMIT);

  async function copyAll() {
    if (result.urls.length === 0) return;
    try {
      await navigator.clipboard.writeText(result.urls.join('\n'));
      setStatus(`已复制全部 ${result.urls.length} 条`);
    } catch {
      setStatus('复制失败：浏览器拒绝了剪贴板访问');
    }
  }

  async function copyOne(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setStatus(`已复制 ${value}`);
    } catch {
      setStatus('复制失败：浏览器拒绝了剪贴板访问');
    }
  }

  return (
    <div>
      <textarea
        className="devtool-input"
        value={text}
        onChange={(event) => setText(event.target.value)}
        placeholder="把整段文本粘进来，例如日志、Markdown、聊天记录"
        aria-label="待提取的文本"
        spellCheck={false}
      />
      <p className="devtool-hint">
        识别 http(s) 链接与裸域名（如 example.com/path）。裸域名按常见后缀判断，
        文件名（file.txt / readme.md）不会被当成网址，冷门新后缀可能漏掉。
        单次最多处理 {EXTRACT_MAX_INPUT_CHARS} 个字符 —— 超出的部分不会解析。
      </p>

      <div className="devtool-time-checks">
        <div className="form-check">
          <input
            className="form-check-input"
            type="checkbox"
            id="extract-dedupe"
            checked={dedupe}
            onChange={(event) => setDedupe(event.target.checked)}
          />
          <label className="form-check-label" htmlFor="extract-dedupe">
            去重
          </label>
        </div>
        <div className="form-check">
          <input
            className="form-check-input"
            type="checkbox"
            id="extract-ignore-case"
            checked={ignoreCase}
            disabled={!dedupe}
            onChange={(event) => setIgnoreCase(event.target.checked)}
          />
          <label className="form-check-label" htmlFor="extract-ignore-case">
            忽略大小写去重
          </label>
        </div>
        <div className="form-check">
          <input
            className="form-check-input"
            type="checkbox"
            id="extract-strip-tracking"
            checked={stripTracking}
            onChange={(event) => setStripTracking(event.target.checked)}
          />
          <label className="form-check-label" htmlFor="extract-strip-tracking">
            去掉跟踪参数（utm_* / fbclid / gclid 等）
          </label>
        </div>
        <div className="form-check">
          <input
            className="form-check-input"
            type="checkbox"
            id="extract-sort"
            checked={sort}
            onChange={(event) => setSort(event.target.checked)}
          />
          <label className="form-check-label" htmlFor="extract-sort">
            排序
          </label>
        </div>
        <div className="form-check">
          <input
            className="form-check-input"
            type="checkbox"
            id="extract-domains-only"
            checked={domainsOnly}
            onChange={(event) => setDomainsOnly(event.target.checked)}
          />
          <label className="form-check-label" htmlFor="extract-domains-only">
            只保留域名
          </label>
        </div>
      </div>

      <div className="devtool-bar">
        <div className="devtool-time-badges">
          <span className="devtool-badge devtool-badge--info">命中 {result.totalFound} 条</span>
          <span className="devtool-badge">去重后 {result.urls.length} 条</span>
          {result.truncated && <span className="devtool-badge devtool-badge--warn">输入超长，已截断</span>}
          {result.limited && <span className="devtool-badge devtool-badge--warn">结果超过上限，只保留前 5000 条</span>}
        </div>
        <button
          type="button"
          className="btn btn-sm btn-outline-secondary devtool-bar__spacer"
          onClick={copyAll}
          disabled={result.urls.length === 0}
        >
          复制全部
        </button>
      </div>

      {text.trim() === '' ? (
        <p className="devtool-time-empty">粘贴文本后，提取到的链接会出现在这里。</p>
      ) : result.urls.length === 0 ? (
        <p className="devtool-time-empty">没有提取到网址。</p>
      ) : (
        <>
          <div className="devtool-list">
            {shown.map((value, index) => (
              <div className="devtool-row devtool-time-row" key={`${index}-${value}`}>
                <span className="devtool-time-index">{index + 1}</span>
                <span className="devtool-time-row__value mono">{value}</span>
                <button
                  type="button"
                  className="btn btn-sm btn-outline-secondary"
                  onClick={() => copyOne(value)}
                >
                  复制
                </button>
              </div>
            ))}
          </div>
          {result.urls.length > DISPLAY_LIMIT && (
            <p className="devtool-hint">
              结果共 {result.urls.length} 条，列表只显示前 {DISPLAY_LIMIT} 条；「复制全部」会复制完整结果。
            </p>
          )}
        </>
      )}

      {status !== '' && <p className="devtool-status">{status}</p>}
    </div>
  );
}
