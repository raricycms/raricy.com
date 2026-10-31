'use client';

import { Fragment, useMemo, useState } from 'react';
import { buildUtmUrl, UTM_PRESETS } from '@/lib/dev-tools/url-tools';

const FIELDS: ReadonlyArray<{ key: 'source' | 'medium' | 'campaign' | 'term' | 'content'; label: string; hint: string }> = [
  { key: 'source', label: '来源 source', hint: '例如 google / wechat / newsletter' },
  { key: 'medium', label: '媒介 medium', hint: '例如 cpc / social / email' },
  { key: 'campaign', label: '活动 campaign', hint: '例如 spring_sale' },
  { key: 'term', label: '关键词 term（非必填）', hint: '付费搜索的关键词' },
  { key: 'content', label: '内容 content（非必填）', hint: '用于区分同一活动里的不同素材' },
];

export default function UtmTool() {
  const [base, setBase] = useState('https://example.com/landing');
  const [values, setValues] = useState({
    source: '',
    medium: '',
    campaign: '',
    term: '',
    content: '',
  });
  const [status, setStatus] = useState('');

  const built = useMemo(
    () =>
      buildUtmUrl(base, {
        source: values.source,
        medium: values.medium,
        campaign: values.campaign,
        term: values.term,
        content: values.content,
      }),
    [base, values]
  );

  function updateField(key: keyof typeof values, value: string) {
    setValues((prev) => ({ ...prev, [key]: value }));
  }

  function applyPreset(source: string, medium: string) {
    setValues((prev) => ({ ...prev, source, medium }));
    setStatus(`已填入预设：${source} / ${medium}`);
  }

  async function copyResult() {
    if (!built.ok) return;
    try {
      await navigator.clipboard.writeText(built.url);
      setStatus('已复制推广链接');
    } catch {
      setStatus('复制失败：浏览器拒绝了剪贴板访问');
    }
  }

  return (
    <div>
      <div className="devtool-bar">
        <input
          className="form-control devtool-time-grow"
          value={base}
          onChange={(event) => setBase(event.target.value)}
          placeholder="基础链接，例如 example.com/landing"
          aria-label="基础链接"
          spellCheck={false}
        />
      </div>
      <p className="devtool-hint">基础链接没写协议时按 https 补全；非必填字段留空就不会拼进链接。</p>

      <div className="devtool-actions">
        {UTM_PRESETS.map((preset) => (
          <button
            type="button"
            key={preset.label}
            className="btn btn-sm btn-outline-secondary"
            onClick={() => applyPreset(preset.source, preset.medium)}
          >
            {preset.label}
          </button>
        ))}
      </div>

      <h2 className="devtool-time-title">参数</h2>
      <div className="devtool-time-fields">
        {FIELDS.map((field) => (
          <div className="devtool-time-field" key={field.key}>
            <label className="form-label" htmlFor={`utm-${field.key}`}>
              {field.label}
            </label>
            <input
              className="form-control mono"
              id={`utm-${field.key}`}
              value={values[field.key]}
              onChange={(event) => updateField(field.key, event.target.value)}
              placeholder={field.hint}
              spellCheck={false}
            />
          </div>
        ))}
      </div>

      <div className="devtool-bar">
        <h2 className="devtool-time-title">生成的链接</h2>
        <button
          type="button"
          className="btn btn-sm btn-outline-secondary devtool-bar__spacer"
          onClick={copyResult}
          disabled={!built.ok}
        >
          复制
        </button>
      </div>

      {built.ok ? (
        <>
          <pre className="devtool-output">{built.url}</pre>
          <h2 className="devtool-time-title">拆解</h2>
          <dl className="devtool-kv">
            <dt>基础链接</dt>
            <dd className="mono">{built.base}</dd>
            {built.params.map((param) => (
              <Fragment key={param.key}>
                <dt className="mono">{param.key}</dt>
                <dd className="mono">{param.value}</dd>
              </Fragment>
            ))}
          </dl>
        </>
      ) : (
        <p className="devtool-error">{built.error}</p>
      )}

      {status !== '' && <p className="devtool-status">{status}</p>}
    </div>
  );
}
