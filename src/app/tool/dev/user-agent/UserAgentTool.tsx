'use client';

// User-Agent 解析：浏览器 / 内核 / 系统 / 设备类型。
//
// 解析规则（识别顺序、iOS 强制 WebKit、Windows 版本映射等）全在
// `src/lib/dev-tools/user-agent.ts`。页面必须写明：UA 由客户端自己发、可以随意伪造，
// 结果只能当线索，不能当鉴权或风控依据。
import { Fragment, useMemo, useState } from 'react';
import {
  parseUserAgent,
  UA_DEVICE_LABELS,
  userAgentRows,
  type UaDeviceType,
} from '@/lib/dev-tools/user-agent';

const DEVICE_BADGE: Record<UaDeviceType, string> = {
  desktop: 'devtool-badge devtool-badge--ok',
  mobile: 'devtool-badge devtool-badge--info',
  tablet: 'devtool-badge devtool-badge--info',
  bot: 'devtool-badge devtool-badge--warn',
  console: 'devtool-badge devtool-badge--danger',
  other: 'devtool-badge',
};

const SAMPLE =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

export default function UserAgentTool() {
  const [ua, setUa] = useState('');
  const [status, setStatus] = useState('');

  const info = useMemo(() => (ua.trim() === '' ? null : parseUserAgent(ua)), [ua]);
  const rows = useMemo(() => (info === null ? [] : userAgentRows(info)), [info]);

  async function copyUa(): Promise<void> {
    if (ua.trim() === '') return;
    try {
      await navigator.clipboard.writeText(ua);
      setStatus('已复制原始 UA');
    } catch {
      setStatus('复制失败（浏览器未授予剪贴板权限）');
    }
  }

  return (
    <div>
      <div className="devtool-bar">
        <button
          type="button"
          className="btn btn-sm btn-primary"
          onClick={() => {
            setUa(navigator.userAgent);
            setStatus('');
          }}
        >
          填入当前浏览器 UA
        </button>
        <button type="button" className="btn btn-sm btn-outline-secondary" onClick={() => setUa(SAMPLE)}>
          填入示例
        </button>
        <button
          type="button"
          className="btn btn-sm btn-outline-secondary"
          onClick={() => {
            setUa('');
            setStatus('');
          }}
          disabled={ua === ''}
        >
          清空
        </button>
        <span className="devtool-bar__spacer" />
        <button type="button" className="btn btn-sm btn-outline-secondary" onClick={copyUa} disabled={ua.trim() === ''}>
          复制原始 UA
        </button>
      </div>

      <label className="form-label" htmlFor="ua-source">
        User-Agent
      </label>
      <textarea
        id="ua-source"
        className="devtool-input"
        rows={5}
        value={ua}
        onChange={(event) => setUa(event.target.value)}
        placeholder="粘贴一条 User-Agent；服务器日志、浏览器开发者工具里都能复制到"
        spellCheck={false}
      />

      {info === null ? (
        <p className="devtool-hint">粘贴 UA 后实时解析；空输入时不显示任何猜测结果。</p>
      ) : (
        <>
          <div className="devtool-bar">
            <span className={DEVICE_BADGE[info.device]}>{UA_DEVICE_LABELS[info.device]}</span>
            <span className="devtool-status">原始 UA 共 {ua.length} 个字符</span>
          </div>
          <dl className="devtool-kv">
            {rows.map((row) => (
              <Fragment key={row.label}>
                <dt>{row.label}</dt>
                <dd>{row.value}</dd>
              </Fragment>
            ))}
          </dl>
        </>
      )}

      <p className="devtool-hint">
        UA 是客户端自己发送的字符串，<strong>可以随意伪造</strong>；许多应用会把它改成别的
        浏览器标识。这里的解析结果只作参考，不能用于鉴权、风控或统计唯一用户。
      </p>
      <p className="devtool-status">{status}</p>
    </div>
  );
}
