'use client';

// 逐字对齐原 Flask 模板 tool/html.html（纯前端计算）。
import Link from 'next/link';
import { useState } from 'react';

const namedMap: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&apos;',
  ' ': '&nbsp;',
};

export default function HtmlToolPage() {
  const [left, setLeft] = useState('');
  const [right, setRight] = useState('');
  const [status, setStatus] = useState('');
  // useNamed 原模板存在但 encodeHTML 未据其分支（基本实体始终命名）；保留以对齐 UI。
  const [useNamed, setUseNamed] = useState(true);
  const [encodeNonAscii, setEncodeNonAscii] = useState(true);

  function encodeHTML(text: string): string {
    let out = '';
    for (const ch of text) {
      if (namedMap[ch]) {
        // Always encode the basic HTML entities, regardless of the checkbox
        out += namedMap[ch];
      } else if (encodeNonAscii && ch.charCodeAt(0) > 0x7f) {
        const code = (ch.codePointAt(0) as number).toString(16).toUpperCase();
        out += `&#x${code};`;
      } else {
        out += ch;
      }
    }
    return out;
  }

  function decodeHTML(text: string): string {
    const div = document.createElement('div');
    div.innerHTML = text;
    return div.textContent || (div as HTMLElement).innerText || '';
  }

  const encodeLeftToRight = () => {
    setRight(encodeHTML(left || ''));
    setStatus('完成');
  };
  const decodeRightToLeft = () => {
    setLeft(decodeHTML(right || ''));
    setStatus('完成');
  };
  const swap = () => {
    setLeft(right);
    setRight(left);
  };
  const copyRight = async () => {
    try {
      await navigator.clipboard.writeText(right || '');
      setStatus('已复制');
    } catch {
      setStatus('复制失败');
    }
  };

  return (
    <section className="py-4 base-tool-page">
      <div className="container">
        <div className="d-flex align-items-center mb-3" style={{ gap: '.5rem' }}>
          <Link
            href="/tool"
            className="text-decoration-none"
            style={{ color: 'var(--color-text-secondary)', display: 'inline-flex' }}
          >
            <span
              className="icon icon-arrow-left"
              style={{ width: '1.25rem', height: '1.25rem' }}
            ></span>
          </Link>
          <h1 className="mb-0 section-title">HTML 实体编码 / 解码</h1>
        </div>
        <p className="text-muted mb-3">
          支持常见 HTML 实体（如 &amp;amp; &amp;lt; &amp;gt; &amp;quot; &amp;apos; &amp;nbsp;）的转义与还原。
        </p>

        <div className="row g-4 align-items-stretch">
          <div className="col-12 col-lg-5">
            <div className="p-3 rounded tool-panel h-100">
              <label className="form-label fw-semibold">左侧（原文）</label>
              <textarea
                className="form-control mono result-area"
                rows={12}
                value={left}
                onChange={(e) => setLeft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.ctrlKey && e.key === 'Enter') {
                    e.preventDefault();
                    encodeLeftToRight();
                  }
                }}
                placeholder="原文在此输入。编码时 → 右侧，解码结果将从右侧 → 左侧"
              />
              <div className="mt-3">
                <label className="form-label fw-semibold">选项</label>
                <div className="row g-2">
                  <div className="col-12 col-md-6">
                    <div className="form-check">
                      <input
                        className="form-check-input"
                        type="checkbox"
                        id="useNamed"
                        checked={useNamed}
                        onChange={(e) => setUseNamed(e.target.checked)}
                      />
                      <label className="form-check-label" htmlFor="useNamed">
                        优先使用命名实体（如 &amp;amp;），否则使用数字实体
                      </label>
                    </div>
                  </div>
                  <div className="col-12 col-md-6">
                    <div className="form-check">
                      <input
                        className="form-check-input"
                        type="checkbox"
                        id="encodeNonAscii"
                        checked={encodeNonAscii}
                        onChange={(e) => setEncodeNonAscii(e.target.checked)}
                      />
                      <label className="form-check-label" htmlFor="encodeNonAscii">
                        编码非 ASCII 字符（如中文 → &amp;#xXXXX;）
                      </label>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div className="col-12 col-lg-2">
            <div className="mid-actions h-100">
              <div className="d-flex flex-column gap-3 w-100 align-items-center">
                <button className="btn btn-primary" onClick={encodeLeftToRight}>
                  编码 →
                </button>
                <button className="btn btn-outline-primary" onClick={decodeRightToLeft}>
                  ← 解码
                </button>
                <button className="btn btn-outline-secondary" onClick={swap}>
                  ⇄ 交换两侧
                </button>
              </div>
            </div>
          </div>

          <div className="col-12 col-lg-5">
            <div className="p-3 rounded tool-panel h-100 position-relative">
              <label className="form-label fw-semibold">右侧（编码文本）</label>
              <button
                className="btn btn-sm btn-outline-secondary btn-copy"
                onClick={copyRight}
              >
                复制
              </button>
              <textarea
                className="form-control mono result-area"
                rows={12}
                value={right}
                onChange={(e) => setRight(e.target.value)}
                onKeyDown={(e) => {
                  if (e.ctrlKey && e.key === 'Enter') {
                    e.preventDefault();
                    decodeRightToLeft();
                  }
                }}
                placeholder="编码文本在此显示或粘贴以解码"
              />
              <div className="d-flex justify-content-between mt-2">
                <small className="text-muted">
                  快捷键：<span className="kbd">Ctrl</span> +{' '}
                  <span className="kbd">Enter</span> 编码（左 → 右）
                </small>
                <span className="text-muted">{status}</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
