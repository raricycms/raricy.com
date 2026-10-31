'use client';

// JSON 路径查询：点号 / 括号路径与 JSONPath 子集。
//
// 支持与不支持的语法**列在页面上**（见 `JSON_PATH_SUPPORTED_SYNTAX` /
// `JSON_PATH_UNSUPPORTED`）：解析器会拒绝过滤器、切片、函数这些没实现的语法，
// 而不是把它们当成「没命中」——那两件事在界面上长得一样，是最容易误导人的地方。
import { Fragment, useState } from 'react';
import {
  JSON_PATH_RESULT_LIMIT,
  JSON_PATH_SUPPORTED_SYNTAX,
  JSON_PATH_UNSUPPORTED,
  parseJsonPath,
  parseJsonText,
  queryJsonPath,
  type JsonPathHit,
} from '@/lib/dev-tools/json';

interface QueryState {
  hits: JsonPathHit[];
}

function valueText(value: unknown): string {
  const text = JSON.stringify(value, null, 2);
  return text === undefined ? 'undefined' : text;
}

export default function JsonPathTool() {
  const [jsonText, setJsonText] = useState('');
  const [pathText, setPathText] = useState('$');
  const [onlyPaths, setOnlyPaths] = useState(false);
  const [query, setQuery] = useState<QueryState | null>(null);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');

  function runQuery() {
    setStatus('');
    if (jsonText.trim() === '') {
      setError('先粘贴要查询的 JSON');
      setQuery(null);
      return;
    }
    const parsedJson = parseJsonText(jsonText);
    if (!parsedJson.ok) {
      const where = parsedJson.location
        ? `（第 ${parsedJson.location.line} 行第 ${parsedJson.location.column} 列）`
        : '';
      setError(`JSON 解析失败：${parsedJson.message}${where}`);
      setQuery(null);
      return;
    }
    const parsedPath = parseJsonPath(pathText);
    if (!parsedPath.ok) {
      setError(parsedPath.message);
      setQuery(null);
      return;
    }
    const hits = queryJsonPath(parsedJson.value, parsedPath.tokens);
    setError('');
    setQuery({ hits });
    setStatus(`命中 ${hits.length} 处`);
  }

  async function copyPaths() {
    if (!query || query.hits.length === 0) {
      setStatus('还没有可复制的路径');
      return;
    }
    try {
      await navigator.clipboard.writeText(query.hits.map((hit) => hit.path).join('\n'));
      setStatus('已复制命中的路径');
    } catch {
      setStatus('复制失败');
    }
  }

  const shownHits = query === null ? [] : query.hits.slice(0, JSON_PATH_RESULT_LIMIT);

  return (
    <div className="devtool-stack">
      <div className="devtool-split devtool-split--left">
        <div className="tool-panel">
          <div className="devtool-bar">
            <label className="form-label" htmlFor="devtool-path-json">
              JSON
            </label>
          </div>
          <textarea
            id="devtool-path-json"
            className="devtool-input"
            rows={18}
            value={jsonText}
            spellCheck={false}
            onChange={(event) => {
              setJsonText(event.target.value);
              setQuery(null);
              setError('');
              setStatus('');
            }}
            placeholder="粘贴 JSON 数据"
          />
        </div>

        <div className="tool-panel">
          <div className="devtool-bar">
            <label className="form-label" htmlFor="devtool-path-input">
              路径
            </label>
            <input
              id="devtool-path-input"
              className="form-control mono devtool-path__input"
              type="text"
              value={pathText}
              spellCheck={false}
              onChange={(event) => {
                setPathText(event.target.value);
                setQuery(null);
                setError('');
                setStatus('');
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  runQuery();
                }
              }}
              placeholder="$.items[0].name"
            />
          </div>

          <div className="devtool-bar">
            <button type="button" className="btn btn-primary" onClick={runQuery}>
              查询
            </button>
            <button type="button" className="btn btn-outline-secondary" onClick={copyPaths}>
              复制命中路径
            </button>
            <div className="form-check">
              <input
                className="form-check-input"
                type="checkbox"
                id="devtool-path-only"
                checked={onlyPaths}
                onChange={(event) => setOnlyPaths(event.target.checked)}
              />
              <label className="form-check-label" htmlFor="devtool-path-only">
                只列路径
              </label>
            </div>
            <span className="devtool-bar__spacer" />
            <span className="devtool-status">{status}</span>
          </div>

          {error !== '' && <p className="devtool-error">{error}</p>}

          {query !== null && (
            <>
              <p className="devtool-hint">
                <span className="devtool-badge">命中 {query.hits.length} 处</span>
                {query.hits.length > JSON_PATH_RESULT_LIMIT && (
                  <>
                    {' '}
                    <span className="devtool-badge devtool-badge--warn">
                      只显示前 {JSON_PATH_RESULT_LIMIT} 处
                    </span>
                  </>
                )}
              </p>
              {query.hits.length === 0 ? (
                <p className="devtool-hint">没有命中任何节点。检查一下路径，或点下面的「支持的写法」。</p>
              ) : (
                <div className="devtool-list">
                  {shownHits.map((hit, index) => (
                    <div className="devtool-path__hit" key={`${index}-${hit.path}`}>
                      <code className="devtool-path__path mono">{hit.path}</code>
                      {!onlyPaths && <pre className="devtool-output devtool-path__value">{valueText(hit.value)}</pre>}
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </div>

      <section className="tool-panel">
        <h2 className="devtool-subtitle">支持的写法</h2>
        <dl className="devtool-kv">
          {JSON_PATH_SUPPORTED_SYNTAX.map((item) => (
            <Fragment key={item.syntax}>
              <dt>
                <code className="mono">{item.syntax}</code>
              </dt>
              <dd>{item.meaning}</dd>
            </Fragment>
          ))}
        </dl>
        <h2 className="devtool-subtitle">不支持的操作</h2>
        <ul className="devtool-notes">
          {JSON_PATH_UNSUPPORTED.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
        <p className="devtool-hint">路径必须以 $ 开头；遇到不支持的语法会报错，而不是静默返回空结果。</p>
      </section>
    </div>
  );
}
