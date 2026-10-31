'use client';

// 网站响应头查看：输入网址 → 本站 `/api/tool/http-headers` → 展示状态、响应头与重定向链。
//
// 【为什么必须走服务端】浏览器跨域拿不到任意站点的响应头（CORS 只暴露白名单头）。
// 代价是这个工具是**本站唯一代用户发起外网请求**的地方，防护与限制都写在那条路由里；
// 这个页面只负责把限制如实告诉用户，并把接口的 message 原样展示出来（不要自己编文案
// 覆盖服务端的判据说明）。SSRF 永远在**服务端**判，前端的任何拼接都不可信。

import { useState } from 'react';

interface HeaderEntry {
  name: string;
  value: string;
}

interface RedirectHop {
  url: string;
  status: number;
}

interface HeaderResult {
  url: string;
  status: number;
  statusText: string;
  headers: HeaderEntry[];
  redirects: RedirectHop[];
  durationMs: number;
}

function errorText(e: unknown): string {
  return e instanceof Error && e.message ? e.message : '未知错误';
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readString(source: Record<string, unknown>, key: string): string {
  const value = source[key];
  return typeof value === 'string' ? value : '';
}

function readNumber(source: Record<string, unknown>, key: string): number | null {
  const value = source[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readHeaders(raw: unknown): HeaderEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: HeaderEntry[] = [];
  for (const item of raw) {
    const entry = asRecord(item);
    if (!entry) continue;
    out.push({ name: readString(entry, 'name'), value: readString(entry, 'value') });
  }
  return out;
}

function readRedirects(raw: unknown): RedirectHop[] {
  if (!Array.isArray(raw)) return [];
  const out: RedirectHop[] = [];
  for (const item of raw) {
    const entry = asRecord(item);
    if (!entry) continue;
    const status = readNumber(entry, 'status');
    out.push({ url: readString(entry, 'url'), status: status === null ? 0 : status });
  }
  return out;
}

/** 用户常常只输入 `example.com`；补成 https:// 再交给服务端（服务端只收绝对地址）。 */
function normalizeUrlInput(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

/** 状态码 → 徽章配色（稳定映射，不按「>=400 就是错误」一刀切）。 */
function statusBadgeClass(status: number): string {
  if (status >= 200 && status < 300) return 'devtool-badge devtool-badge--ok';
  if (status >= 300 && status < 400) return 'devtool-badge devtool-badge--info';
  if (status >= 400 && status < 500) return 'devtool-badge devtool-badge--warn';
  return 'devtool-badge devtool-badge--danger';
}

export default function HttpHeadersTool() {
  const [input, setInput] = useState('https://example.com');
  const [result, setResult] = useState<HeaderResult | null>(null);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);

  async function check(): Promise<void> {
    const target = normalizeUrlInput(input);
    if (!target) {
      setError('请输入网址');
      return;
    }
    setBusy(true);
    setError('');
    setResult(null);
    setStatus('正在请求…');

    try {
      const response = await fetch(`/api/tool/http-headers?url=${encodeURIComponent(target)}`, {
        headers: { accept: 'application/json' },
      });
      const raw: unknown = await response.json();
      const payload = asRecord(raw);
      if (!payload) throw new Error('接口返回了无法解析的数据');

      const message = readString(payload, 'message');
      if (!response.ok) {
        // 直接展示服务端的判据说明（SSRF / 超时 / 限频都靠它）
        throw new Error(message || `接口返回 HTTP ${response.status}`);
      }

      const finalUrl = readString(payload, 'url');
      const statusCode = readNumber(payload, 'status');
      if (!finalUrl || statusCode === null) throw new Error(message || '接口返回的数据不完整');

      setResult({
        url: finalUrl,
        status: statusCode,
        statusText: readString(payload, 'statusText'),
        headers: readHeaders(payload.headers),
        redirects: readRedirects(payload.redirects),
        durationMs: readNumber(payload, 'durationMs') ?? 0,
      });
      setStatus('完成');
    } catch (e) {
      setStatus('');
      if (e instanceof TypeError) {
        setError('无法连接本站接口（网络错误），请稍后再试');
      } else {
        setError(errorText(e));
      }
    } finally {
      setBusy(false);
    }
  }

  async function copyAllHeaders(): Promise<void> {
    if (!result) return;
    const text = result.headers.map((header) => `${header.name}: ${header.value}`).join('\n');
    try {
      await navigator.clipboard.writeText(text);
      setStatus('已复制全部响应头');
    } catch {
      setStatus('复制失败：浏览器拒绝访问剪贴板');
    }
  }

  return (
    <div className="devtool-split devtool-split--right">
      <div className="tool-panel p-3">
        <div className="devtool-net-field">
          <label className="form-label" htmlFor="http-headers-url">
            网址
          </label>
          <div className="devtool-net-input-row">
            <input
              id="http-headers-url"
              type="text"
              className="form-control mono"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  void check();
                }
              }}
              placeholder="例如 example.com 或 https://example.com/"
              disabled={busy}
            />
            <button type="button" className="btn btn-primary" onClick={() => void check()} disabled={busy}>
              {busy ? '请求中…' : '查看响应头'}
            </button>
          </div>
        </div>

        <p className="devtool-hint">
          请求由本站<strong>服务端</strong>发起（浏览器跨域拿不到响应头）。仅支持 http / https
          的 80 / 443 端口；私网、回环与保留地址会被拒绝；按 IP 限频；最多跟随 3 次重定向；
          单次超时 8 秒。
        </p>
        <p className="devtool-hint">
          只读取响应头，不下载页面内容，也不回显 <span className="mono">set-cookie</span>
          （那是目标站点的会话凭据）。
        </p>

        {status && !error ? <p className="devtool-hint devtool-status">{status}</p> : null}
      </div>

      <div className="tool-panel p-3">
        <h2 className="devtool-net-heading">结果</h2>
        {error ? <p className="devtool-error">{error}</p> : null}

        {result ? (
          <>
            <dl className="devtool-kv">
              <dt>最终 URL</dt>
              <dd className="mono">{result.url}</dd>
              <dt>HTTP 状态</dt>
              <dd>
                <span className={statusBadgeClass(result.status)}>
                  {result.status} {result.statusText || ''}
                </span>
              </dd>
              <dt>耗时</dt>
              <dd className="mono">{result.durationMs}ms</dd>
            </dl>

            {result.redirects.length > 0 ? (
              <div className="devtool-net-section">
                <h3 className="devtool-net-heading">重定向链</h3>
                <div className="devtool-list">
                  {result.redirects.map((hop, index) => (
                    <div className="devtool-row" key={`${hop.url}-${index}`}>
                      <span className="devtool-badge">{hop.status}</span>
                      <span className="mono">{hop.url}</span>
                    </div>
                  ))}
                  <div className="devtool-row">
                    <span className="devtool-badge devtool-badge--ok">{result.status}</span>
                    <span className="mono">{result.url}</span>
                  </div>
                </div>
              </div>
            ) : null}

            <div className="devtool-net-section">
              <div className="devtool-bar">
                <h3 className="devtool-net-heading">响应头（{result.headers.length}）</h3>
                <button
                  type="button"
                  className="btn btn-outline-secondary btn-sm"
                  onClick={() => void copyAllHeaders()}
                >
                  复制全部
                </button>
              </div>
              {result.headers.length > 0 ? (
                <div className="devtool-table-wrap">
                  <table className="devtool-table devtool-net-table">
                    <thead>
                      <tr>
                        <th>名称</th>
                        <th>值</th>
                      </tr>
                    </thead>
                    <tbody>
                      {result.headers.map((header, index) => (
                        <tr key={`${header.name}-${index}`}>
                          <td className="mono">{header.name}</td>
                          <td className="mono">{header.value}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="devtool-hint">该响应没有任何响应头。</p>
              )}
            </div>
          </>
        ) : (
          !error && <p className="devtool-hint">输入网址后点「查看响应头」。</p>
        )}
      </div>
    </div>
  );
}
