'use client';

import { useEffect, useState } from 'react';
import { formatIsoUtc } from '@/lib/dev-tools/datetime';
import {
  buildClaimRows,
  decodeJwt,
  type JwtTimeState,
} from '@/lib/dev-tools/jwt';

/** exp / nbf 的状态 → 徽章配色。 */
function timeBadgeClass(state: JwtTimeState): string {
  if (state === 'expired' || state === 'invalid') return 'devtool-badge devtool-badge--danger';
  if (state === 'valid') return 'devtool-badge devtool-badge--ok';
  if (state === 'future') return 'devtool-badge devtool-badge--warn';
  return 'devtool-badge';
}

export default function JwtTool() {
  const [token, setToken] = useState('');
  // 「现在」首帧不取：服务端与客户端首帧都显示「还没算」，避免水合前后时间对不上。
  const [nowMs, setNowMs] = useState<number | null>(null);
  const [status, setStatus] = useState('');

  useEffect(() => {
    setNowMs(Date.now());
  }, []);

  const effectiveNow = nowMs ?? 0;
  const trimmed = token.trim();
  const result = decodeJwt(token, effectiveNow);

  async function copy(label: string, text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setStatus(`已复制${label}`);
    } catch {
      setStatus('复制失败：浏览器拒绝了剪贴板访问');
    }
  }

  function handleToken(value: string) {
    setToken(value);
    setNowMs(Date.now());
  }

  return (
    <div>
      <div className="devtool-bar">
        <button type="button" className="btn btn-outline-secondary" onClick={() => setNowMs(Date.now())}>
          刷新当前时间
        </button>
        <span className="devtool-status">
          过期 / 生效状态基于：{nowMs === null ? '正在取当前时间…' : formatIsoUtc(nowMs)}
        </span>
      </div>

      <textarea
        className="devtool-input"
        value={token}
        onChange={(event) => handleToken(event.target.value)}
        placeholder="粘贴 JWT（header.payload.signature，可带 Bearer 前缀）"
        aria-label="JWT"
        spellCheck={false}
      />
      <p className="devtool-hint">
        只做解码，<strong>不验证签名</strong>，因此不能据此信任内容 —— 签名是否正确、是否被篡改，
        这里都看不出来。需要验证请用密钥 / 公钥在服务端做。
      </p>

      {trimmed === '' ? (
        <p className="devtool-hint">粘贴后这里会显示头部、载荷、声明表与过期状态。</p>
      ) : !result.ok ? (
        <p className="devtool-error">{result.error}</p>
      ) : (
        <>
          <div className="devtool-time-badges">
            <span className="devtool-badge devtool-badge--info">alg: {result.decoded.alg ?? '未声明'}</span>
            <span className={timeBadgeClass(result.decoded.exp.state)}>exp：{result.decoded.exp.text}</span>
            <span className={timeBadgeClass(result.decoded.nbf.state)}>nbf：{result.decoded.nbf.text}</span>
            <span className="devtool-badge">
              签名段：{result.decoded.signaturePresent ? `已提供（${result.decoded.signature.length} 字符，未验证）` : '没有'}
            </span>
          </div>

          {result.decoded.warnings.length > 0 && (
            <div className="devtool-time-badges">
              {result.decoded.warnings.map((warning) => (
                <span className="devtool-badge devtool-badge--warn" key={warning}>
                  {warning}
                </span>
              ))}
            </div>
          )}

          <div className="devtool-split">
            <section className="tool-panel">
              <div className="devtool-bar">
                <h2 className="devtool-time-title">头部 Header</h2>
                <button
                  type="button"
                  className="btn btn-sm btn-outline-secondary devtool-bar__spacer"
                  onClick={() => copy('（头部）', result.decoded.headerJson)}
                >
                  复制
                </button>
              </div>
              <pre className="devtool-output">{result.decoded.headerJson}</pre>
            </section>

            <section className="tool-panel">
              <div className="devtool-bar">
                <h2 className="devtool-time-title">载荷 Payload</h2>
                <button
                  type="button"
                  className="btn btn-sm btn-outline-secondary devtool-bar__spacer"
                  onClick={() => copy('（载荷）', result.decoded.payloadJson)}
                >
                  复制
                </button>
              </div>
              <pre className="devtool-output">{result.decoded.payloadJson}</pre>
            </section>
          </div>

          <h2 className="devtool-time-title">声明表</h2>
          <div className="devtool-table-wrap">
            <table className="devtool-table">
              <thead>
                <tr>
                  <th>声明</th>
                  <th>含义</th>
                  <th>值</th>
                </tr>
              </thead>
              <tbody>
                {buildClaimRows(result.decoded.payload, effectiveNow).map((row) => (
                  <tr key={row.key}>
                    <td className="mono">{row.key}</td>
                    <td>{row.label}</td>
                    <td className="mono">{row.value}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {status !== '' && <p className="devtool-status">{status}</p>}
    </div>
  );
}
