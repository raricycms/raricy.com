'use client';

// DNS 查询（DNS over HTTPS）。
//
// 【为什么走 DoH + 浏览器直连】普通 DNS（UDP 53）在浏览器里做不了；DoH 是普通 HTTPS，
// Cloudflare / Google 都允许跨域，所以查询由**浏览器直连**第三方，本站不转发、不记录。
// 【降级顺序】先 Cloudflare；网络 / HTTP / JSON 解析失败才回退 Google。
// **NXDOMAIN 与 SERVFAIL 不回退** —— 那是「这个域名/类型确实没有记录」的答案，
// 换一家再问一遍只会把同一个答案再拿一次，还会掩盖问题的归因。
// 【必须标注】查询经第三方 DoH 服务；域名会发送给它们。

import { useState } from 'react';

const DNS_TYPES = ['A', 'AAAA', 'CNAME', 'MX', 'NS', 'TXT', 'SOA', 'CAA', 'SRV'] as const;
type DnsType = (typeof DNS_TYPES)[number];

type DohSource = 'Cloudflare' | 'Google';

const DOH_TIMEOUT_MS = 8000;

/** 记录类型编号 → 名字（展示用；Answer 里给的是数字）。 */
const TYPE_NAMES: Readonly<Record<number, string>> = {
  1: 'A',
  2: 'NS',
  5: 'CNAME',
  6: 'SOA',
  12: 'PTR',
  15: 'MX',
  16: 'TXT',
  28: 'AAAA',
  33: 'SRV',
  257: 'CAA',
};

interface DnsRecordRow {
  name: string;
  type: string;
  ttl: string;
  data: string;
  priority: string;
  weight: string;
  port: string;
}

interface ParsedAnswer {
  rows: DnsRecordRow[];
  /** 是否至少有一条 MX（决定表格要不要多一列）。 */
  hasMx: boolean;
  /** 是否至少有一条 SRV。 */
  hasSrv: boolean;
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

/** MX 的 data 形如 "10 mail.example.com."。 */
function parseMx(data: string): { priority: string; data: string } {
  const match = /^(\d+)\s+(.+)$/.exec(data.trim());
  return match ? { priority: match[1], data: match[2] } : { priority: '', data };
}

/** SRV 的 data 形如 "10 5 5060 sip.example.com."。 */
function parseSrv(data: string): { priority: string; weight: string; port: string; data: string } {
  const match = /^(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/.exec(data.trim());
  return match
    ? { priority: match[1], weight: match[2], port: match[3], data: match[4] }
    : { priority: '', weight: '', port: '', data };
}

function parseAnswers(raw: unknown): ParsedAnswer {
  const answers = Array.isArray(raw) ? raw : [];
  const rows: DnsRecordRow[] = [];
  let hasMx = false;
  let hasSrv = false;

  for (const item of answers) {
    const entry = asRecord(item);
    if (!entry) continue;
    const typeNumber = readNumber(entry, 'type');
    const typeName = typeNumber === null ? '' : (TYPE_NAMES[typeNumber] ?? `type-${typeNumber}`);
    const name = readString(entry, 'name');
    const data = readString(entry, 'data');
    const ttl = readNumber(entry, 'TTL');

    if (typeName === 'MX') {
      hasMx = true;
      const mx = parseMx(data);
      rows.push({
        name,
        type: `MX`,
        ttl: ttl === null ? '' : String(ttl),
        data: mx.data,
        priority: mx.priority,
        weight: '',
        port: '',
      });
      continue;
    }
    if (typeName === 'SRV') {
      hasSrv = true;
      const srv = parseSrv(data);
      rows.push({
        name,
        type: 'SRV',
        ttl: ttl === null ? '' : String(ttl),
        data: srv.data,
        priority: srv.priority,
        weight: srv.weight,
        port: srv.port,
      });
      continue;
    }
    // 其它记录直接把 data 放进「数据」列
    rows.push({
      name,
      type: typeName,
      ttl: ttl === null ? '' : String(ttl),
      data,
      priority: '',
      weight: '',
      port: '',
    });
  }

  return { rows, hasMx, hasSrv };
}

function statusMessage(status: number | null): string {
  switch (status) {
    case 0:
      return '';
    case 2:
      return 'SERVFAIL：DNS 服务器处理查询时出错（域名可能配置有误）';
    case 3:
      return 'NXDOMAIN：域名不存在（检查拼写，或该域名尚未注册）';
    case 5:
      return 'REFUSED：DNS 服务器拒绝回答这次查询';
    default:
      return `DNS 返回状态码 ${status}，没有可展示的记录`;
  }
}

async function queryDoh(
  source: DohSource,
  name: string,
  type: DnsType,
  signal: AbortSignal
): Promise<unknown> {
  const url =
    source === 'Cloudflare'
      ? `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=${type}`
      : `https://dns.google/resolve?name=${encodeURIComponent(name)}&type=${type}`;
  const response = await fetch(url, {
    signal,
    headers: { accept: 'application/dns-json' },
  });
  if (!response.ok) throw new Error(`${source} 返回 HTTP ${response.status}`);
  return (await response.json()) as unknown;
}

export default function DnsTool() {
  const [name, setName] = useState('raricy.com');
  const [type, setType] = useState<DnsType>('A');
  const [rows, setRows] = useState<DnsRecordRow[]>([]);
  const [hasMx, setHasMx] = useState(false);
  const [hasSrv, setHasSrv] = useState(false);
  const [source, setSource] = useState<DohSource | null>(null);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [queried, setQueried] = useState('');

  async function lookup(): Promise<void> {
    const domain = name.trim();
    if (!domain) {
      setError('请输入要查询的域名');
      return;
    }

    setBusy(true);
    setError('');
    setMessage('');
    setRows([]);
    setSource(null);

    let responseJson: unknown = null;
    let used: DohSource = 'Cloudflare';

    for (const candidate of ['Cloudflare', 'Google'] as const) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), DOH_TIMEOUT_MS);
      try {
        responseJson = await queryDoh(candidate, domain, type, controller.signal);
        used = candidate;
        break;
      } catch {
        // 这一家不可用 → 试下一家；两家的失败原因不合并，最后一律给「都不可用」
        responseJson = null;
      } finally {
        clearTimeout(timer);
      }
    }

    try {
      if (responseJson === null) {
        throw new Error(
          'Cloudflare 与 Google 的 DoH 服务都无法访问（网络错误或超时），本次没有拿到任何结果'
        );
      }

      const root = asRecord(responseJson);
      if (!root) throw new Error('DoH 服务返回了无法解析的数据');

      const status = readNumber(root, 'Status');
      if (status !== null && status !== 0) {
        const text = statusMessage(status);
        setSource(used);
        setQueried(`${domain} · ${type}`);
        if (status === 3) {
          // NXDOMAIN 是「这个域名不存在」的确定答案，当作错误明确展示
          setError(text);
        } else {
          setMessage(text || '没有可展示的记录');
        }
        return;
      }

      const parsed = parseAnswers(root.Answer);
      setRows(parsed.rows);
      setHasMx(parsed.hasMx);
      setHasSrv(parsed.hasSrv);
      setSource(used);
      setQueried(`${domain} · ${type}`);
      if (parsed.rows.length === 0) {
        setMessage(`NOERROR：域名存在，但没有 ${type} 类型的记录`);
      }
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="devtool-split devtool-split--right">
      <div className="tool-panel p-3">
        <div className="devtool-net-field">
          <label className="form-label" htmlFor="dns-name">
            域名
          </label>
          <div className="devtool-net-input-row">
            <input
              id="dns-name"
              type="text"
              className="form-control mono"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  void lookup();
                }
              }}
              placeholder="例如 raricy.com"
            />
            <select
              className="form-select"
              aria-label="记录类型"
              value={type}
              onChange={(e) => setType(e.target.value as DnsType)}
            >
              {DNS_TYPES.map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </select>
            <button type="button" className="btn btn-primary" onClick={() => void lookup()} disabled={busy}>
              {busy ? '查询中…' : '查询'}
            </button>
          </div>
        </div>

        <p className="devtool-hint">
          查询经第三方 DoH 服务（Cloudflare，失败时回退 Google）；域名会发送给它们。
          本站服务端不接收也不记录这次查询。
        </p>

        {error ? <p className="devtool-error">{error}</p> : null}
        {message && !error ? <p className="devtool-hint">{message}</p> : null}
      </div>

      <div className="tool-panel p-3">
        <h2 className="devtool-net-heading">查询结果</h2>
        {queried ? (
          <p className="devtool-hint">
            查询对象：<span className="mono">{queried}</span>
            {source ? ` · 来源：${source}` : ''}
          </p>
        ) : null}

        {rows.length > 0 ? (
          <div className="devtool-table-wrap">
            <table className="devtool-table devtool-net-table">
              <thead>
                <tr>
                  <th>名称</th>
                  <th>类型</th>
                  <th>TTL（秒）</th>
                  {hasMx ? <th>优先级</th> : null}
                  {hasSrv ? (
                    <>
                      <th>优先级</th>
                      <th>权重</th>
                      <th>端口</th>
                    </>
                  ) : null}
                  <th>数据</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row, index) => (
                  <tr key={`${row.type}-${index}`}>
                    <td className="mono">{row.name || '—'}</td>
                    <td className="mono">{row.type}</td>
                    <td className="mono">{row.ttl || '—'}</td>
                    {hasMx ? <td className="mono">{row.priority || '—'}</td> : null}
                    {hasSrv ? (
                      <>
                        <td className="mono">{row.priority || '—'}</td>
                        <td className="mono">{row.weight || '—'}</td>
                        <td className="mono">{row.port || '—'}</td>
                      </>
                    ) : null}
                    <td className="mono">{row.data}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="devtool-hint">尚未查询，或该类型没有记录。</p>
        )}
      </div>
    </div>
  );
}
