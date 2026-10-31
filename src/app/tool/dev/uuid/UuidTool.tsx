'use client';

import { useState } from 'react';
import { formatUuid, uuidV4, uuidV7, type UuidFormatOptions } from './uuid';

type UuidVersion = 'v4' | 'v7';

const MAX_COUNT = 100;

export default function UuidTool() {
  const [version, setVersion] = useState<UuidVersion>('v4');
  const [countText, setCountText] = useState('5');
  const [uppercase, setUppercase] = useState(false);
  const [noHyphens, setNoHyphens] = useState(false);
  const [list, setList] = useState<string[]>([]);
  const [status, setStatus] = useState('');

  function generate() {
    const parsedCount = Number.parseInt(countText, 10);
    const count = Number.isFinite(parsedCount) ? Math.min(MAX_COUNT, Math.max(1, parsedCount)) : 5;
    const options: UuidFormatOptions = { uppercase, noHyphens };
    // v7 的时间戳先存成一个变量：同一批 UUID 共用同一个毫秒，字典序只由随机位决定。
    const now = Date.now();
    const random = (size: number): Uint8Array => {
      const bytes = new Uint8Array(size);
      crypto.getRandomValues(bytes);
      return bytes;
    };

    const next: string[] = [];
    for (let i = 0; i < count; i++) {
      if (version === 'v7') {
        next.push(uuidV7(now, random, options));
      } else if (typeof crypto.randomUUID === 'function') {
        next.push(formatUuid(crypto.randomUUID().replace(/-/g, ''), options));
      } else {
        next.push(uuidV4(random, options));
      }
    }

    setList(next);
    setCountText(String(count));
    setStatus(`已生成 ${count} 个 UUID ${version}`);
  }

  async function copyOne(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setStatus(`已复制 ${value}`);
    } catch {
      setStatus('复制失败：浏览器拒绝了剪贴板访问');
    }
  }

  async function copyAll() {
    try {
      await navigator.clipboard.writeText(list.join('\n'));
      setStatus(`已复制全部 ${list.length} 个 UUID`);
    } catch {
      setStatus('复制失败：浏览器拒绝了剪贴板访问');
    }
  }

  return (
    <div>
      <div className="devtool-bar">
        <select
          className="form-select devtool-time-select"
          value={version}
          onChange={(event) => setVersion(event.target.value === 'v7' ? 'v7' : 'v4')}
          aria-label="UUID 版本"
        >
          <option value="v4">UUID v4（全随机）</option>
          <option value="v7">UUID v7（时间戳 + 随机）</option>
        </select>
        <input
          className="form-control devtool-time-count"
          type="number"
          min={1}
          max={MAX_COUNT}
          value={countText}
          onChange={(event) => setCountText(event.target.value)}
          aria-label="生成数量"
        />
        <div className="form-check">
          <input
            className="form-check-input"
            type="checkbox"
            id="uuid-uppercase"
            checked={uppercase}
            onChange={(event) => setUppercase(event.target.checked)}
          />
          <label className="form-check-label" htmlFor="uuid-uppercase">
            大写
          </label>
        </div>
        <div className="form-check">
          <input
            className="form-check-input"
            type="checkbox"
            id="uuid-no-hyphens"
            checked={noHyphens}
            onChange={(event) => setNoHyphens(event.target.checked)}
          />
          <label className="form-check-label" htmlFor="uuid-no-hyphens">
            去掉连字符
          </label>
        </div>
        <button type="button" className="btn btn-primary" onClick={generate}>
          生成
        </button>
      </div>
      <p className="devtool-hint">
        数量 1–100。v4 走 <span className="mono">crypto.randomUUID()</span>；v7 前 48 位是毫秒时间戳，
        同一毫秒内按随机位排序，适合当数据库主键（比 v4 的索引局部性更好）。
      </p>

      <div className="devtool-bar">
        <h2 className="devtool-time-title">生成结果</h2>
        <button
          type="button"
          className="btn btn-sm btn-outline-secondary devtool-bar__spacer"
          onClick={copyAll}
          disabled={list.length === 0}
        >
          复制全部
        </button>
      </div>

      {list.length === 0 ? (
        <p className="devtool-time-empty">还没有生成。选好版本与数量后点「生成」。</p>
      ) : (
        <div className="devtool-list">
          {list.map((value, index) => (
            <div className="devtool-row devtool-time-row" key={`${index}-${value}`}>
              <span className="devtool-time-index">{index + 1}</span>
              <span className="devtool-time-row__value mono">{value}</span>
              <button
                type="button"
                className="btn btn-sm btn-outline-secondary"
                onClick={() => copyOne(value)}
              >
                复制
              </button>
            </div>
          ))}
        </div>
      )}

      {status !== '' && <p className="devtool-status">{status}</p>}
    </div>
  );
}
