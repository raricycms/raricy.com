'use client';

import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { buildUrl, parseUrlParts } from '@/lib/dev-tools/url-tools';

interface ParamRow {
  id: number;
  key: string;
  value: string;
  encode: boolean;
}

interface Draft {
  protocol: string;
  host: string;
  pathname: string;
  hash: string;
}

const INITIAL_URL = 'https://example.com/search?q=hello%20world&tag=a&tag=b#top';

function initialDraft(): Draft {
  const parsed = parseUrlParts(INITIAL_URL);
  if (!parsed.ok) return { protocol: 'https', host: '', pathname: '/', hash: '' };
  return {
    protocol: parsed.parts.protocol,
    host: parsed.parts.host,
    pathname: parsed.parts.pathname,
    hash: parsed.parts.hash,
  };
}

function initialRows(): ParamRow[] {
  const parsed = parseUrlParts(INITIAL_URL);
  if (!parsed.ok) return [];
  return parsed.parts.params.map((param, index) => ({
    id: index + 1,
    key: param.key,
    value: param.value,
    encode: true,
  }));
}

export default function UrlParamsTool() {
  const [urlInput, setUrlInput] = useState(INITIAL_URL);
  const [draft, setDraft] = useState<Draft>(initialDraft);
  const [rows, setRows] = useState<ParamRow[]>(initialRows);
  const [note, setNote] = useState('');
  const [status, setStatus] = useState('');
  const nextId = useRef(1000);

  const built = useMemo(
    () =>
      buildUrl({
        protocol: draft.protocol,
        host: draft.host,
        pathname: draft.pathname,
        hash: draft.hash,
        params: rows.map((row) => ({ key: row.key, value: row.value, encode: row.encode })),
      }),
    [draft, rows]
  );

  function applyParse() {
    const parsed = parseUrlParts(urlInput);
    if (!parsed.ok) {
      setNote('');
      setStatus(`解析失败：${parsed.error}`);
      return;
    }
    setDraft({
      protocol: parsed.parts.protocol,
      host: parsed.parts.host,
      pathname: parsed.parts.pathname,
      hash: parsed.parts.hash,
    });
    setRows(
      parsed.parts.params.map((param, index) => ({
        id: index + 1,
        key: param.key,
        value: param.value,
        encode: true,
      }))
    );
    nextId.current = parsed.parts.params.length + 1;
    setNote(parsed.parts.assumedProtocol ? '输入没写协议，已按 https 解析。' : '');
    setStatus(`已解析出 ${parsed.parts.params.length} 个查询参数`);
  }

  function updateRow(id: number, patch: Partial<Omit<ParamRow, 'id'>>) {
    setRows((prev) => prev.map((row) => (row.id === id ? { ...row, ...patch } : row)));
  }

  function addRow() {
    const id = nextId.current;
    nextId.current += 1;
    setRows((prev) => [...prev, { id, key: '', value: '', encode: true }]);
  }

  function removeRow(id: number) {
    setRows((prev) => prev.filter((row) => row.id !== id));
  }

  function moveRow(id: number, delta: number) {
    setRows((prev) => {
      const index = prev.findIndex((row) => row.id === id);
      const target = index + delta;
      if (index < 0 || target < 0 || target >= prev.length) return prev;
      const next = [...prev];
      const current = next[index];
      next[index] = next[target];
      next[target] = current;
      return next;
    });
  }

  async function copyResult() {
    if (!built.ok) return;
    try {
      await navigator.clipboard.writeText(built.url);
      setStatus('已复制重建后的 URL');
    } catch {
      setStatus('复制失败：浏览器拒绝了剪贴板访问');
    }
  }

  return (
    <div>
      <div className="devtool-bar">
        <input
          className="form-control devtool-time-grow"
          value={urlInput}
          onChange={(event) => setUrlInput(event.target.value)}
          placeholder="粘贴完整 URL，例如 https://example.com/path?a=1&a=2"
          aria-label="URL"
          spellCheck={false}
        />
        <button type="button" className="btn btn-primary" onClick={applyParse}>
          解析
        </button>
      </div>
      <p className="devtool-hint">
        没写协议时按 https 解析。参数值显示「解码后」的文本；每行的「编码」决定拼回时是否重新
        percent-encode（关掉可以观察未编码的效果）。重复键与顺序都会保留。
      </p>
      {note !== '' && <p className="devtool-hint">{note}</p>}

      <h2 className="devtool-time-title">组成部分</h2>
      <div className="devtool-time-subgrid">
        <div className="devtool-time-field">
          <label className="form-label" htmlFor="urlparams-protocol">
            协议
          </label>
          <input
            className="form-control mono"
            id="urlparams-protocol"
            value={draft.protocol}
            onChange={(event) => setDraft((prev) => ({ ...prev, protocol: event.target.value }))}
            spellCheck={false}
          />
        </div>
        <div className="devtool-time-field">
          <label className="form-label" htmlFor="urlparams-host">
            主机
          </label>
          <input
            className="form-control mono"
            id="urlparams-host"
            value={draft.host}
            onChange={(event) => setDraft((prev) => ({ ...prev, host: event.target.value }))}
            spellCheck={false}
          />
        </div>
        <div className="devtool-time-field">
          <label className="form-label" htmlFor="urlparams-path">
            路径
          </label>
          <input
            className="form-control mono"
            id="urlparams-path"
            value={draft.pathname}
            onChange={(event) => setDraft((prev) => ({ ...prev, pathname: event.target.value }))}
            spellCheck={false}
          />
        </div>
        <div className="devtool-time-field">
          <label className="form-label" htmlFor="urlparams-hash">
            锚点（#）
          </label>
          <input
            className="form-control mono"
            id="urlparams-hash"
            value={draft.hash}
            onChange={(event) => setDraft((prev) => ({ ...prev, hash: event.target.value }))}
            spellCheck={false}
          />
        </div>
      </div>

      <div className="devtool-bar">
        <h2 className="devtool-time-title">查询参数（{rows.length}）</h2>
        <button
          type="button"
          className="btn btn-sm btn-outline-secondary devtool-bar__spacer"
          onClick={addRow}
        >
          <Plus aria-hidden="true" /> 加一行
        </button>
      </div>

      {rows.length === 0 ? (
        <p className="devtool-time-empty">这个 URL 还没有查询参数，点「加一行」开始编辑。</p>
      ) : (
        <div className="devtool-list">
          {rows.map((row) => (
            <div className="devtool-time-param" key={row.id}>
              <input
                className="form-control mono"
                value={row.key}
                onChange={(event) => updateRow(row.id, { key: event.target.value })}
                placeholder="键"
                aria-label={`参数键 ${row.id}`}
                spellCheck={false}
              />
              <input
                className="form-control mono"
                value={row.value}
                onChange={(event) => updateRow(row.id, { value: event.target.value })}
                placeholder="值（解码后）"
                aria-label={`参数值 ${row.id}`}
                spellCheck={false}
              />
              <div className="form-check devtool-time-param__check">
                <input
                  className="form-check-input"
                  type="checkbox"
                  id={`urlparams-encode-${row.id}`}
                  checked={row.encode}
                  onChange={(event) => updateRow(row.id, { encode: event.target.checked })}
                />
                <label className="form-check-label" htmlFor={`urlparams-encode-${row.id}`}>
                  编码
                </label>
              </div>
              <div className="devtool-time-param__actions">
                <button
                  type="button"
                  className="btn btn-sm btn-outline-secondary"
                  onClick={() => moveRow(row.id, -1)}
                  aria-label="上移"
                >
                  <ArrowUp aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className="btn btn-sm btn-outline-secondary"
                  onClick={() => moveRow(row.id, 1)}
                  aria-label="下移"
                >
                  <ArrowDown aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className="btn btn-sm btn-outline-secondary"
                  onClick={() => removeRow(row.id)}
                  aria-label="删除这一行"
                >
                  <Trash2 aria-hidden="true" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="devtool-bar">
        <h2 className="devtool-time-title">重建结果</h2>
        <button
          type="button"
          className="btn btn-sm btn-outline-secondary devtool-bar__spacer"
          onClick={copyResult}
          disabled={!built.ok}
        >
          复制
        </button>
      </div>
      {built.ok ? (
        <pre className="devtool-output">{built.url}</pre>
      ) : (
        <p className="devtool-error">{built.error}</p>
      )}

      {status !== '' && <p className="devtool-status">{status}</p>}
    </div>
  );
}
