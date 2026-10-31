'use client';

// 正则表达式测试：实时高亮、捕获组（含具名组）与替换预览。
//
// 计算全部在浏览器里做，输入不会离开本页。这里刻意**不做**「超时保护」的假承诺：
// JS 正则跑在主线程，灾难性回溯会把页面卡住，Worker 也没有可中断的正则执行 API。
// 页面提示里如实说「先拿小样本试」，而不是放一个永远触发不了的超时按钮。
import { useMemo, useState } from 'react';

const FLAG_OPTIONS = [
  { value: 'g', label: 'g 全局' },
  { value: 'i', label: 'i 忽略大小写' },
  { value: 'm', label: 'm 多行' },
  { value: 's', label: 's 点匹配换行' },
  { value: 'u', label: 'u Unicode' },
  { value: 'y', label: 'y 粘性' },
] as const;

type RegexFlag = (typeof FLAG_OPTIONS)[number]['value'];
type FlagState = Record<RegexFlag, boolean>;

const DEFAULT_FLAGS: FlagState = { g: true, i: false, m: false, s: false, u: false, y: false };

/** 单页最多列出的匹配数：防止一段极端输入把页面渲染卡死（不是超时，是截断）。 */
const MAX_MATCHES = 1000;

interface CaptureGroup {
  label: string;
  value: string;
}

interface MatchEntry {
  index: number;
  value: string;
  groups: CaptureGroup[];
}

interface Segment {
  text: string;
  hit: boolean;
}

interface Analysis {
  error: string | null;
  matches: MatchEntry[];
  truncated: boolean;
  segments: Segment[];
  replaced: string | null;
}

function collectGroups(match: RegExpExecArray): CaptureGroup[] {
  const groups: CaptureGroup[] = [];
  for (let i = 1; i < match.length; i += 1) {
    groups.push({ label: `$${i}`, value: match[i] ?? '' });
  }
  for (const [name, value] of Object.entries(match.groups ?? {})) {
    groups.push({ label: `$<${name}>`, value: value ?? '' });
  }
  return groups;
}

function buildSegments(text: string, matches: MatchEntry[]): Segment[] {
  if (text === '') return [];
  const segments: Segment[] = [];
  let cursor = 0;
  for (const match of matches) {
    if (match.index > cursor) segments.push({ text: text.slice(cursor, match.index), hit: false });
    // 零长度匹配没有可高亮的文本，跳过（它仍然会出现在下面的匹配列表里）。
    if (match.value.length > 0) {
      segments.push({ text: match.value, hit: true });
      cursor = match.index + match.value.length;
    } else {
      cursor = match.index;
    }
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor), hit: false });
  return segments;
}

function analyze(pattern: string, flags: string, text: string, replacement: string): Analysis {
  if (pattern === '') {
    return { error: null, matches: [], truncated: false, segments: buildSegments(text, []), replaced: null };
  }

  let regex: RegExp;
  try {
    regex = new RegExp(pattern, flags);
  } catch (error) {
    return {
      error: error instanceof Error && error.message ? error.message : '正则表达式无效',
      matches: [],
      truncated: false,
      segments: buildSegments(text, []),
      replaced: null,
    };
  }

  const matches: MatchEntry[] = [];
  let truncated = false;

  if (regex.global) {
    let match = regex.exec(text);
    while (match !== null) {
      matches.push({ index: match.index, value: match[0], groups: collectGroups(match) });
      if (matches.length >= MAX_MATCHES) {
        truncated = regex.lastIndex < text.length;
        break;
      }
      if (match[0].length === 0) {
        regex.lastIndex += 1;
        if (regex.lastIndex > text.length) break;
      }
      match = regex.exec(text);
    }
  } else {
    const match = regex.exec(text);
    if (match !== null) matches.push({ index: match.index, value: match[0], groups: collectGroups(match) });
  }

  // 替换预览用一份**新的**正则：`String.replace` 会按自己的规则处理 lastIndex，
  // 直接复用上面跑过的实例容易踩到状态残留。
  const replaced = text.replace(new RegExp(pattern, flags), replacement);

  return { error: null, matches, truncated, segments: buildSegments(text, matches), replaced };
}

export default function RegexTool() {
  const [pattern, setPattern] = useState('\\b\\w+\\b');
  const [text, setText] = useState('Hello world，这是一段用来测试正则的文本。');
  const [replacement, setReplacement] = useState('[$&]');
  const [flags, setFlags] = useState<FlagState>(DEFAULT_FLAGS);
  const [status, setStatus] = useState('');

  const flagString = FLAG_OPTIONS.filter((option) => flags[option.value])
    .map((option) => option.value)
    .join('');

  const analysis = useMemo(
    () => analyze(pattern, flagString, text, replacement),
    [pattern, flagString, text, replacement]
  );

  function toggleFlag(flag: RegexFlag, checked: boolean): void {
    setFlags((prev) => {
      const next = { ...prev };
      next[flag] = checked;
      return next;
    });
  }

  async function copyReplaced(): Promise<void> {
    if (analysis.replaced === null) return;
    try {
      await navigator.clipboard.writeText(analysis.replaced);
      setStatus('已复制替换结果');
    } catch {
      setStatus('复制失败（浏览器未授予剪贴板权限）');
    }
  }

  return (
    <div>
      <div className="devtool-bar">
        <label className="form-label" htmlFor="regex-pattern">
          正则表达式
        </label>
        <input
          id="regex-pattern"
          className="form-control mono devtool-regex__pattern"
          value={pattern}
          onChange={(event) => setPattern(event.target.value)}
          placeholder="例如 \b\w+\b"
          spellCheck={false}
        />
        <span className="devtool-badge">{flagString === '' ? '没有标志' : flagString}</span>
      </div>

      <div className="devtool-bar">
        <span className="devtool-status">标志：</span>
        {FLAG_OPTIONS.map((option) => (
          <span className="form-check" key={option.value}>
            <input
              className="form-check-input"
              type="checkbox"
              id={`regex-flag-${option.value}`}
              checked={flags[option.value]}
              onChange={(event) => toggleFlag(option.value, event.target.checked)}
            />
            <label className="form-check-label" htmlFor={`regex-flag-${option.value}`}>
              {option.label}
            </label>
          </span>
        ))}
      </div>

      <div className="devtool-split">
        <div>
          <label className="form-label" htmlFor="regex-text">
            测试文本
          </label>
          <textarea
            id="regex-text"
            className="devtool-input"
            rows={8}
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder="在这里粘贴要匹配的文本"
            spellCheck={false}
          />
        </div>
        <div>
          <label className="form-label">匹配高亮</label>
          <div className="devtool-regex__highlight">
            {analysis.segments.length === 0 ? (
              <span className="devtool-hint">没有可高亮的文本。</span>
            ) : (
              analysis.segments.map((segment, index) =>
                segment.hit ? (
                  <mark className="devtool-regex__hit" key={index}>
                    {segment.text}
                  </mark>
                ) : (
                  <span key={index}>{segment.text}</span>
                )
              )
            )}
          </div>
        </div>
      </div>

      {analysis.error !== null ? (
        <p className="devtool-error">正则无效：{analysis.error}</p>
      ) : (
        <p className="devtool-status">
          匹配 {analysis.matches.length} 处
          {analysis.truncated ? `（超过 ${MAX_MATCHES} 处，列表与高亮已截断）` : ''}
        </p>
      )}

      <h2 className="devtool-code__subhead">匹配详情</h2>
      {analysis.matches.length === 0 ? (
        <p className="devtool-hint">
          {pattern === '' ? '输入正则表达式后实时匹配。' : '当前文本里没有匹配。'}
        </p>
      ) : (
        <div className="devtool-list devtool-scroll devtool-regex__matches">
          {analysis.matches.map((match, index) => (
            <div className="devtool-row" key={`${match.index}-${index}`}>
              <span className="devtool-badge">#{index + 1}</span>
              <div className="devtool-regex__match">
                <div className="devtool-regex__meta">
                  index {match.index} · 长度 {match.value.length} ·{' '}
                  <span className="mono">{JSON.stringify(match.value)}</span>
                </div>
                {match.groups.length > 0 ? (
                  <div className="devtool-regex__groups">
                    {match.groups.map((group, groupIndex) => (
                      <div className="devtool-regex__group" key={`${group.label}-${groupIndex}`}>
                        <span className="devtool-regex__group-name">{group.label}</span>
                        <span className="devtool-regex__group-value">
                          {group.value === '' ? '（未参与匹配 / 空）' : group.value}
                        </span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="devtool-regex__meta">没有捕获组</div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      <h2 className="devtool-code__subhead">替换预览</h2>
      <div className="devtool-bar">
        <label className="form-label" htmlFor="regex-replacement">
          替换为
        </label>
        <input
          id="regex-replacement"
          className="form-control mono devtool-regex__pattern"
          value={replacement}
          onChange={(event) => setReplacement(event.target.value)}
          placeholder="支持 $1、$&amp;、$<name>；留空表示删除匹配"
          spellCheck={false}
        />
        <button type="button" className="btn btn-sm btn-outline-secondary" onClick={copyReplaced}>
          复制替换结果
        </button>
      </div>
      {analysis.replaced === null ? (
        <p className="devtool-hint">输入正则与文本后显示替换结果。</p>
      ) : (
        <pre className="devtool-output">{analysis.replaced}</pre>
      )}

      <p className="devtool-hint">
        提示：正则执行在浏览器主线程，灾难性回溯（例如嵌套量词搭配长文本）会让页面卡住，本页
        没有「超时」可承诺。请先拿小样本试，确认没问题再放到长文本上。
      </p>
      <p className="devtool-status">{status}</p>
    </div>
  );
}
