'use client';

// IP 地址信息查询。
//
// 【数据来源】第三方服务 `ipwho.is`，由**浏览器直连**（CORS 允许）—— 本站服务端
// 不转发、也不记录用户查了什么 IP。
// 【必须标注】查询会把目标 IP（留空时是用户的出口 IP）发送给 ipwho.is。这是页面上
// 必须写清的第三方依赖，不是可选的补充说明。
// 【降级要诚实】服务不可用 / 被限频 / 返回 success:false 时显示明确错误，
// 绝不拿上一次结果或猜测值冒充成功。

import { useState } from 'react';

const LOOKUP_TIMEOUT_MS = 8000;

interface IpInfo {
  ip: string;
  type: string;
  country: string;
  region: string;
  city: string;
  latitude: string;
  longitude: string;
  timezone: string;
  asn: string;
  isp: string;
  org: string;
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

/** ipwho.is 的 JSON → 展示用的扁平结构（缺字段一律空串，不编值）。 */
function parseIpResponse(raw: unknown): IpInfo {
  const root = asRecord(raw);
  if (!root) throw new Error('查询服务返回了无法解析的数据');

  if (root.success === false) {
    const message = readString(root, 'message');
    throw new Error(message ? `查询失败：${message}` : '查询失败：服务拒绝了这次查询');
  }

  const connection = asRecord(root.connection);
  const timezone = asRecord(root.timezone);
  const latitude = readNumber(root, 'latitude');
  const longitude = readNumber(root, 'longitude');
  const asn = connection ? readNumber(connection, 'asn') : null;

  return {
    ip: readString(root, 'ip'),
    type: readString(root, 'type'),
    country: readString(root, 'country'),
    region: readString(root, 'region'),
    city: readString(root, 'city'),
    latitude: latitude === null ? '' : latitude.toFixed(4),
    longitude: longitude === null ? '' : longitude.toFixed(4),
    timezone:
      timezone && readString(timezone, 'id')
        ? `${readString(timezone, 'id')}${readString(timezone, 'utc') ? `（UTC${readString(timezone, 'utc')}）` : ''}`
        : '',
    asn: asn === null ? '' : `AS${asn}`,
    isp: connection ? readString(connection, 'isp') : '',
    org: connection ? readString(connection, 'org') : '',
  };
}

export default function IpTool() {
  const [ip, setIp] = useState('');
  const [info, setInfo] = useState<IpInfo | null>(null);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);

  async function lookup(): Promise<void> {
    const target = ip.trim();
    setBusy(true);
    setError('');
    setStatus('正在查询…');
    setInfo(null);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), LOOKUP_TIMEOUT_MS);
    try {
      const url = `https://ipwho.is/${encodeURIComponent(target)}`;
      const response = await fetch(url, {
        signal: controller.signal,
        headers: { accept: 'application/json' },
      });
      if (response.status === 429) {
        throw new Error('查询服务限频（HTTP 429），请稍后再试');
      }
      if (!response.ok) {
        throw new Error(`查询服务返回 HTTP ${response.status}，请稍后再试`);
      }
      const data = parseIpResponse((await response.json()) as unknown);
      setInfo(data);
      setStatus('查询完成');
    } catch (e) {
      setStatus('');
      if (e instanceof Error && e.name === 'AbortError') {
        setError(`查询超时（${LOOKUP_TIMEOUT_MS / 1000} 秒）：ipwho.is 没有及时响应，请稍后再试`);
      } else if (e instanceof TypeError) {
        setError(
          '查询服务不可用：无法连接 ipwho.is（网络错误或被浏览器拦截）。本工具没有备用数据源，请稍后再试。'
        );
      } else {
        setError(errorText(e));
      }
    } finally {
      clearTimeout(timer);
      setBusy(false);
    }
  }

  function reset(): void {
    setIp('');
    setInfo(null);
    setError('');
    setStatus('');
  }

  return (
    <div className="devtool-split devtool-split--left">
      <div className="tool-panel p-3">
        <div className="devtool-net-field">
          <label className="form-label" htmlFor="ip-query">
            IP 地址（IPv4 / IPv6；留空查询本机出口 IP）
          </label>
          <div className="devtool-net-input-row">
            <input
              id="ip-query"
              type="text"
              className="form-control mono"
              value={ip}
              onChange={(e) => {
                setIp(e.target.value);
                setStatus('');
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  void lookup();
                }
              }}
              placeholder="例如 8.8.8.8 或 2001:4860:4860::8888"
              disabled={busy}
            />
            <button type="button" className="btn btn-primary" onClick={() => void lookup()} disabled={busy}>
              {busy ? '查询中…' : '查询'}
            </button>
            <button type="button" className="btn btn-outline-secondary btn-sm" onClick={reset}>
              清空
            </button>
          </div>
        </div>

        <p className="devtool-hint">
          数据来源：第三方服务 <span className="mono">ipwho.is</span>。查询会把目标 IP
          发送给该服务；留空时发送的是你的出口 IP。本站服务端不接收也不记录这次查询。
        </p>
        <p className="devtool-hint">
          该服务免费额度有限，被限频时会给出明确提示；服务不可用时本工具会直接报错，
          不会拿别处的数据冒充结果。
        </p>

        {error ? <p className="devtool-error">{error}</p> : null}
        {status && !error && !info ? <p className="devtool-hint devtool-status">{status}</p> : null}
      </div>

      <div className="tool-panel p-3">
        <h2 className="devtool-net-heading">查询结果</h2>
        {info ? (
          <>
            <dl className="devtool-kv">
              <dt>IP</dt>
              <dd className="mono">{info.ip || '—'}</dd>
              <dt>协议</dt>
              <dd>{info.type || '—'}</dd>
              <dt>国家 / 地区</dt>
              <dd>{[info.country, info.region].filter(Boolean).join(' / ') || '—'}</dd>
              <dt>城市</dt>
              <dd>{info.city || '—'}</dd>
              <dt>经纬度</dt>
              <dd className="mono">
                {info.latitude || info.longitude ? `${info.latitude}, ${info.longitude}` : '—'}
              </dd>
              <dt>时区</dt>
              <dd>{info.timezone || '—'}</dd>
              <dt>ASN</dt>
              <dd className="mono">{info.asn || '—'}</dd>
              <dt>ISP</dt>
              <dd>{info.isp || '—'}</dd>
              <dt>组织</dt>
              <dd>{info.org || '—'}</dd>
            </dl>
            <p className="devtool-hint">
              这是第三方服务的定位数据，城市级精度，不代表设备的真实物理位置。
            </p>
          </>
        ) : (
          <p className="devtool-hint">输入 IP 后点「查询」，或直接留空查自己的出口 IP。</p>
        )}
      </div>
    </div>
  );
}
