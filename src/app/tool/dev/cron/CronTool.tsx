'use client';

import { useEffect, useState } from 'react';
import { nextRuns, parseCron } from '@/lib/dev-tools/cron';
import { formatInTimeZone, formatSiteTime, weekdayUtc8 } from '@/lib/dev-tools/datetime';

const EXAMPLES: ReadonlyArray<{ label: string; expr: string }> = [
  { label: '每天 0 点', expr: '0 0 * * *' },
  { label: '工作日 9 点', expr: '0 9 * * 1-5' },
  { label: '每 15 分钟', expr: '*/15 * * * *' },
  { label: '每月 1 号', expr: '0 0 1 * *' },
  { label: '@daily', expr: '@daily' },
  { label: '@weekly', expr: '@weekly' },
];

export default function CronTool() {
  const [expr, setExpr] = useState('0 9 * * 1-5');
  // 首帧不取时间：服务端渲染与客户端首帧都算「还没算」，避免水合前后数字不一致。
  const [nowMs, setNowMs] = useState<number | null>(null);

  useEffect(() => {
    setNowMs(Date.now());
  }, []);

  const parsed = parseCron(expr);
  const runsResult = nowMs !== null && parsed.ok ? nextRuns(expr, nowMs, 8) : null;
  const runs = runsResult !== null && runsResult.ok ? runsResult.runs : [];
  const exhausted = runsResult !== null && runsResult.ok ? runsResult.exhausted : false;

  return (
    <div>
      <div className="devtool-bar">
        <input
          className="form-control devtool-time-grow mono"
          value={expr}
          onChange={(event) => setExpr(event.target.value)}
          placeholder="分 时 日 月 周，例如 0 9 * * 1-5"
          aria-label="Cron 表达式"
          spellCheck={false}
        />
        <button type="button" className="btn btn-outline-secondary" onClick={() => setNowMs(Date.now())}>
          重新计算
        </button>
      </div>

      <div className="devtool-actions">
        {EXAMPLES.map((example) => (
          <button
            type="button"
            key={example.expr}
            className="btn btn-sm btn-outline-secondary"
            onClick={() => setExpr(example.expr)}
          >
            {example.label}
          </button>
        ))}
      </div>

      <p className="devtool-hint">
        5 字段写法（分 时 日 月 周）。支持 <span className="mono">*</span>、
        <span className="mono"> a-b</span>、<span className="mono"> a,b</span>、
        <span className="mono"> */n</span>、<span className="mono"> a-b/n</span>、月份名 JAN–DEC、
        星期名 SUN–SAT、<span className="mono">?</span>（视为 <span className="mono">*</span>）与
        <span className="mono"> @yearly/@monthly/@weekly/@daily/@midnight/@hourly</span>。
      </p>
      <p className="devtool-hint">
        下次执行时间一律按站点时区 <strong>UTC+8</strong> 计算，并同时给出对应的 UTC 时间。
        日与星期都被限定时取「或」（Vixie cron 语义）：例如第 13 号与周五，两者都会触发。
      </p>

      {!parsed.ok ? (
        <ul className="devtool-time-error-list">
          {parsed.errors.map((error) => (
            <li className="devtool-error" key={error}>
              {error}
            </li>
          ))}
        </ul>
      ) : (
        <>
          <div className="devtool-time-badges">
            <span className="devtool-badge devtool-badge--info">展开后：{parsed.expanded}</span>
            {parsed.macro !== null && (
              <span className="devtool-badge">{parsed.macro} 是宏写法</span>
            )}
          </div>

          <h2 className="devtool-time-title">字段含义</h2>
          <div className="devtool-table-wrap">
            <table className="devtool-table">
              <thead>
                <tr>
                  <th>字段</th>
                  <th>写法</th>
                  <th>含义</th>
                </tr>
              </thead>
              <tbody>
                {parsed.fields.map((field) => (
                  <tr key={field.name}>
                    <td>{field.label}</td>
                    <td className="mono">{field.raw}</td>
                    <td>{field.description}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <h2 className="devtool-time-title">接下来 8 次执行（站点时区 UTC+8）</h2>
          {runs.length === 0 ? (
            <p className="devtool-hint">
              {nowMs === null
                ? '正在按当前时间计算…'
                : '在接下来 10 年内找不到符合该表达式的时刻（例如 2 月 30 日这种永远不存在的日期）。'}
            </p>
          ) : (
            <div className="devtool-table-wrap">
              <table className="devtool-table">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>站点时间（UTC+8）</th>
                    <th>星期</th>
                    <th>UTC</th>
                  </tr>
                </thead>
                <tbody>
                  {runs.map((run, index) => (
                    <tr key={run}>
                      <td>{index + 1}</td>
                      <td className="mono">{formatSiteTime(run)}</td>
                      <td>{weekdayUtc8(run)}</td>
                      <td className="mono">{formatInTimeZone(run, 'UTC')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {exhausted && runs.length > 0 && (
            <p className="devtool-hint">搜索上限内只找到 {runs.length} 次执行，之后的时刻可能间隔很长。</p>
          )}
        </>
      )}
    </div>
  );
}
