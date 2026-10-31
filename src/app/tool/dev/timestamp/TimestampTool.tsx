'use client';

import { useState } from 'react';
import {
  describeTimestamp,
  parseTimestamp,
  timeZoneTable,
  type TimestampDisplay,
} from '@/lib/dev-tools/datetime';

const INPUT_HINT =
  '支持 10 位 Unix 秒、13 位毫秒、16 位微秒、19 位纳秒（微秒 / 纳秒截断到毫秒），' +
  '以及 ISO 8601 / YYYY-MM-DD HH:mm:ss。没写时区的日期按站点时区 UTC+8 解释。';

export default function TimestampTool() {
  const [input, setInput] = useState('');
  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  const [status, setStatus] = useState('');

  const trimmed = input.trim();
  const parsed = parseTimestamp(input, nowMs);
  const display: TimestampDisplay | null = parsed.ok
    ? describeTimestamp(parsed.epochMs, nowMs)
    : null;
  const zones = parsed.ok ? timeZoneTable(parsed.epochMs) : [];

  async function copy(label: string, text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setStatus(`已复制${label}`);
    } catch {
      setStatus('复制失败：浏览器拒绝了剪贴板访问');
    }
  }

  function handleInput(value: string) {
    setInput(value);
    // 每次输入都刷新「现在」，相对时间不会停在上一次输入的那一刻。
    setNowMs(Date.now());
  }

  function useNow() {
    const now = Date.now();
    setNowMs(now);
    setInput(String(Math.floor(now / 1000)));
    setStatus('已填入当前 Unix 秒');
  }

  const rows: { label: string; value: string }[] = display
    ? [
        { label: 'Unix 秒', value: display.unixSeconds },
        { label: 'Unix 毫秒', value: display.unixMillis },
        { label: 'ISO 8601（UTC）', value: display.isoUtc },
        { label: '站点时间（UTC+8）', value: display.siteTime },
        { label: `读者本地时间（${display.localZone}）`, value: display.localTime },
        { label: '相对时间', value: display.relative },
      ]
    : [];

  return (
    <div>
      <div className="devtool-bar">
        <input
          className="form-control devtool-time-grow"
          value={input}
          onChange={(event) => handleInput(event.target.value)}
          placeholder="粘贴时间戳或日期，例如 1700000000 / 2024-01-15 12:00:00"
          aria-label="时间戳或日期"
          spellCheck={false}
        />
        <button type="button" className="btn btn-primary" onClick={useNow}>
          现在
        </button>
      </div>
      <p className="devtool-hint">{INPUT_HINT}</p>

      {trimmed === '' ? (
        <p className="devtool-hint">
          输入后这里会同时给出 Unix 秒 / 毫秒、ISO 8601、站点时间（UTC+8）、读者本地时间与相对时间。
        </p>
      ) : !parsed.ok ? (
        <p className="devtool-error">{parsed.error}</p>
      ) : (
        <>
          <p className="devtool-hint">{parsed.note}</p>
          <div className="devtool-list">
            {rows.map((row) => (
              <div className="devtool-row devtool-time-row" key={row.label}>
                <span className="devtool-time-row__label">{row.label}</span>
                <span className="devtool-time-row__value mono">{row.value}</span>
                <button
                  type="button"
                  className="btn btn-sm btn-outline-secondary"
                  onClick={() => copy(`（${row.label}）`, row.value)}
                >
                  复制
                </button>
              </div>
            ))}
          </div>

          <h2 className="devtool-time-title">常用时区</h2>
          <div className="devtool-table-wrap">
            <table className="devtool-table">
              <thead>
                <tr>
                  <th>时区</th>
                  <th>时间</th>
                  <th>相对 UTC</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {zones.map((zone) => (
                  <tr key={zone.zone}>
                    <td>{zone.label}</td>
                    <td className="mono">{zone.time}</td>
                    <td>{zone.offset === 'GMT' ? 'UTC+0' : zone.offset}</td>
                    <td>
                      <button
                        type="button"
                        className="btn btn-sm btn-outline-secondary"
                        onClick={() => copy(`（${zone.label}）`, `${zone.time} ${zone.offset}`)}
                      >
                        复制
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="devtool-hint">
            时区表由 Intl.DateTimeFormat 的 formatToParts 现算，不依赖浏览器 / 服务器的本地时区。
          </p>
        </>
      )}

      {status !== '' && <p className="devtool-status">{status}</p>}
    </div>
  );
}
