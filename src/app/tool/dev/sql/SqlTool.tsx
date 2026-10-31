'use client';

// SQL 格式化：基于词法的缩进与换行（不做语义重写）。
//
// 方言只影响三件事：关键字集合、`#` 是否算注释（MySQL）、单引号里的反斜杠是否转义
// （MySQL）。字符串 / 注释 / 引号标识符的内容原样保留 —— 这是本工具最重要的不变式。
import { useMemo, useState } from 'react';
import { formatSql, SQL_DIALECTS, type SqlDialect } from '@/lib/dev-tools/sql-format';

const SAMPLE = `select u.id, u.name, count(o.id) as order_count
from users u
left join orders o on o.user_id = u.id
where u.active = 1 and u.age >= 18
group by u.id, u.name
order by order_count desc
limit 20;`;

export default function SqlTool() {
  const [source, setSource] = useState('');
  const [dialect, setDialect] = useState<SqlDialect>('generic');
  const [uppercase, setUppercase] = useState(true);
  const [indentSize, setIndentSize] = useState<2 | 4>(2);
  const [status, setStatus] = useState('');

  const output = useMemo(
    () => formatSql(source, { dialect, uppercaseKeywords: uppercase, indentSize }),
    [source, dialect, uppercase, indentSize]
  );

  const dialectDef = SQL_DIALECTS.find((entry) => entry.value === dialect);

  async function copyOutput(): Promise<void> {
    if (output === '') return;
    try {
      await navigator.clipboard.writeText(output);
      setStatus('已复制格式化结果');
    } catch {
      setStatus('复制失败（浏览器未授予剪贴板权限）');
    }
  }

  return (
    <div>
      <div className="devtool-bar">
        <label className="form-label" htmlFor="sql-dialect">
          方言
        </label>
        <select
          id="sql-dialect"
          className="form-select devtool-field--select"
          value={dialect}
          onChange={(event) => setDialect(event.target.value as SqlDialect)}
        >
          {SQL_DIALECTS.map((entry) => (
            <option value={entry.value} key={entry.value}>
              {entry.label}
            </option>
          ))}
        </select>

        <label className="form-label" htmlFor="sql-indent">
          缩进
        </label>
        <select
          id="sql-indent"
          className="form-select devtool-field--select"
          value={indentSize}
          onChange={(event) => setIndentSize(event.target.value === '4' ? 4 : 2)}
        >
          <option value={2}>2 空格</option>
          <option value={4}>4 空格</option>
        </select>

        <span className="form-check">
          <input
            className="form-check-input"
            type="checkbox"
            id="sql-uppercase"
            checked={uppercase}
            onChange={(event) => setUppercase(event.target.checked)}
          />
          <label className="form-check-label" htmlFor="sql-uppercase">
            关键字大写
          </label>
        </span>

        <span className="devtool-bar__spacer" />
        <button type="button" className="btn btn-sm btn-outline-secondary" onClick={() => setSource(SAMPLE)}>
          填入示例
        </button>
        <button
          type="button"
          className="btn btn-sm btn-outline-secondary"
          onClick={() => {
            setSource('');
            setStatus('');
          }}
        >
          清空
        </button>
      </div>

      <p className="devtool-hint">{dialectDef?.hint}</p>

      <div className="devtool-split devtool-split--left">
        <div>
          <label className="form-label" htmlFor="sql-source">
            原始 SQL
          </label>
          <textarea
            id="sql-source"
            className="devtool-input"
            rows={14}
            value={source}
            onChange={(event) => setSource(event.target.value)}
            placeholder="粘贴 SQL；字符串、注释与引号标识符里的内容不会被改动"
            spellCheck={false}
          />
        </div>
        <div>
          <div className="devtool-bar">
            <label className="form-label">格式化结果</label>
            <button
              type="button"
              className="btn btn-sm btn-outline-secondary devtool-bar__spacer"
              onClick={copyOutput}
              disabled={output === ''}
            >
              复制
            </button>
          </div>
          <pre className="devtool-output">{output}</pre>
        </div>
      </div>

      <p className="devtool-hint">
        这是基于词法的缩进与换行：按子句分行、按层级缩进，不做语义级重写（不解析 AST、
        不判断列名 / 类型名）。复杂 DDL 或方言扩展语法可能只做到「能看」，做不到「漂亮」。
      </p>
      <p className="devtool-status">{status}</p>
    </div>
  );
}
