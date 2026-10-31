'use client';

// 子网计算器：CIDR（或 IP + 前缀）→ IPv4 / IPv6 子网信息。
// 计算逻辑在 `@/lib/dev-tools/subnet.ts`（纯函数、node 可测）。
//
// IPv6 的地址总数是 2^(128-prefix)，**必须用 BigInt**（页面里不经 Number 中转）——
// 中转一次就是静默丢精度，看着还是个像样的数字。

import { useEffect, useState } from 'react';
import { parseSubnetInput, type SubnetResult } from '@/lib/dev-tools/subnet';

const EXAMPLES: readonly string[] = [
  '192.168.1.0/24',
  '10.0.0.0/8',
  '203.0.113.5/32',
  '2001:db8::/32',
  'fd00::/8',
];

/** 给十进制数字加千位分隔（不能用 toLocaleString：全站禁本地化时间/数字 API）。 */
function groupThousands(value: string): string {
  return value.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function errorText(e: unknown): string {
  return e instanceof Error && e.message ? e.message : '未知错误';
}

export default function SubnetTool() {
  const [input, setInput] = useState('192.168.1.0/24');
  const [result, setResult] = useState<SubnetResult | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    try {
      setResult(parseSubnetInput('192.168.1.0/24'));
    } catch {
      // 内置示例必然合法
    }
  }, []);

  function compute(nextInput: string = input): void {
    try {
      const parsed = parseSubnetInput(nextInput);
      setResult(parsed);
      setError('');
    } catch (e) {
      setResult(null);
      setError(errorText(e));
    }
  }

  return (
    <div className="devtool-split devtool-split--left">
      <div className="tool-panel p-3">
        <div className="devtool-net-field">
          <label className="form-label" htmlFor="subnet-input">
            CIDR 或「IP + 前缀」（IPv4 / IPv6）
          </label>
          <div className="devtool-net-input-row">
            <input
              id="subnet-input"
              type="text"
              className="form-control mono"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  compute();
                }
              }}
              placeholder="例如 192.168.1.0/24 或 2001:db8::/32"
            />
            <button type="button" className="btn btn-primary" onClick={() => compute()}>
              计算
            </button>
          </div>
          <p className="devtool-hint">
            也支持空格写法（<span className="mono">192.168.1.0 24</span>）。IPv4 前缀 0–32，
            IPv6 前缀 0–128。
          </p>
        </div>

        <div className="devtool-net-field">
          <span className="form-label">常用示例</span>
          <div className="devtool-bar">
            {EXAMPLES.map((example) => (
              <button
                key={example}
                type="button"
                className="btn btn-outline-secondary btn-sm mono"
                onClick={() => {
                  setInput(example);
                  compute(example);
                }}
              >
                {example}
              </button>
            ))}
          </div>
        </div>

        {error ? <p className="devtool-error">{error}</p> : null}
      </div>

      <div className="tool-panel p-3">
        <h2 className="devtool-net-heading">计算结果</h2>
        {result && result.version === 4 ? (
          <>
            <dl className="devtool-kv">
              <dt>CIDR</dt>
              <dd className="mono">{result.cidr}</dd>
              <dt>网络地址</dt>
              <dd className="mono">{result.network}</dd>
              <dt>广播地址</dt>
              <dd className="mono">{result.broadcast}</dd>
              <dt>子网掩码</dt>
              <dd className="mono">{result.netmask}</dd>
              <dt>通配符掩码</dt>
              <dd className="mono">{result.wildcard}</dd>
              <dt>首个可用地址</dt>
              <dd className="mono">{result.firstHost}</dd>
              <dt>最后可用地址</dt>
              <dd className="mono">{result.lastHost}</dd>
              <dt>可用主机数</dt>
              <dd className="mono">{groupThousands(String(result.usableHosts))}</dd>
              <dt>地址总数</dt>
              <dd className="mono">{groupThousands(String(result.totalAddresses))}</dd>
              <dt>地址类别</dt>
              <dd>{result.addressClass}</dd>
            </dl>
            {result.note ? <p className="devtool-hint">{result.note}</p> : null}
          </>
        ) : null}

        {result && result.version === 6 ? (
          <>
            <dl className="devtool-kv">
              <dt>规范化前缀</dt>
              <dd className="mono">{result.cidr}</dd>
              <dt>网络地址</dt>
              <dd className="mono">{result.network}</dd>
              <dt>首地址</dt>
              <dd className="mono">{result.firstAddress}</dd>
              <dt>尾地址</dt>
              <dd className="mono">{result.lastAddress}</dd>
              <dt>地址总数</dt>
              <dd className="mono">{groupThousands(result.totalAddresses.toString())}</dd>
              <dt>总数公式</dt>
              <dd className="mono">2^(128 - {result.prefix})</dd>
            </dl>
            <p className="devtool-hint">
              IPv6 没有广播地址；尾地址是主机位全 1 的最后一个地址。
              地址总数用 BigInt 精确计算，没有经过浮点数中转。
            </p>
            {result.note ? <p className="devtool-hint">{result.note}</p> : null}
          </>
        ) : null}

        {!result ? <p className="devtool-hint">输入 CIDR 后点「计算」。</p> : null}
      </div>
    </div>
  );
}
