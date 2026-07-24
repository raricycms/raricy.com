'use client';

// 逐字对齐原 Flask 模板 tool/qp.html（纯前端计算）。
import Link from 'next/link';
import { useState } from 'react';

export default function QpToolPage() {
  const [left, setLeft] = useState('');
  const [right, setRight] = useState('');
  const [status, setStatus] = useState('');
  const [softLineBreak, setSoftLineBreak] = useState(true);
  const [escapeTrailingSpaces, setEscapeTrailingSpaces] = useState(true);
  const [crlf, setCrlf] = useState(true);

  function qpEncode(input: string): string {
    const lines = input.split(/\r?\n/);
    const out: string[] = [];
    const eol = crlf ? '\r\n' : '\n';
    for (let line of lines) {
      let encoded = '';
      for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        const code = ch.charCodeAt(0);
        // Per RFC 2045, tab(9) and space(32) are safe unless at EOL.
        // Other safe chars are 33-60 and 62-126.
        const safe =
          code === 9 || code === 32 || (code >= 33 && code <= 60) || (code >= 62 && code <= 126);
        if (safe) encoded += ch;
        else encoded += '=' + code.toString(16).toUpperCase().padStart(2, '0');
      }
      if (escapeTrailingSpaces) {
        encoded = encoded.replace(/[ \t]+$/g, (m) =>
          m
            .split('')
            .map((c) => '=' + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0'))
            .join('')
        );
      }
      if (softLineBreak) {
        // fold to <=76 characters using soft break
        while (encoded.length > 76) {
          out.push(encoded.slice(0, 75) + '=');
          encoded = encoded.slice(75);
        }
      }
      out.push(encoded);
    }
    return out.join(eol);
  }

  function qpDecode(input: string): string {
    // Join soft breaks
    const eolNormalized = input.replace(/=\r?\n/g, '');
    const bytes: number[] = [];
    for (let i = 0; i < eolNormalized.length; i++) {
      const ch = eolNormalized[i];
      if (ch === '=') {
        const hex = eolNormalized.slice(i + 1, i + 3);
        if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
          bytes.push(parseInt(hex, 16));
          i += 2;
        } else {
          // invalid sequence, keep '='
          bytes.push('='.charCodeAt(0));
        }
      } else {
        bytes.push(ch.charCodeAt(0));
      }
    }
    try {
      return new TextDecoder().decode(new Uint8Array(bytes));
    } catch {
      return '[解码失败]';
    }
  }

  const encodeLeftToRight = () => {
    setRight(qpEncode(left || ''));
    setStatus('完成');
  };
  const decodeRightToLeft = () => {
    setLeft(qpDecode(right || ''));
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
          <h1 className="mb-0 tool-new-hero__title">Quoted-Printable 编码 / 解码</h1>
        </div>
        <p className="tool-new-hero__description mb-3">
          符合 RFC 2045 的 QP 编码，支持软换行（软回车）与尾空格处理。
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
                        id="softLineBreak"
                        checked={softLineBreak}
                        onChange={(e) => setSoftLineBreak(e.target.checked)}
                      />
                      <label className="form-check-label" htmlFor="softLineBreak">
                        软换行（在行末添加 =\r\n）
                      </label>
                    </div>
                  </div>
                  <div className="col-12 col-md-6">
                    <div className="form-check">
                      <input
                        className="form-check-input"
                        type="checkbox"
                        id="escapeTrailingSpaces"
                        checked={escapeTrailingSpaces}
                        onChange={(e) => setEscapeTrailingSpaces(e.target.checked)}
                      />
                      <label className="form-check-label" htmlFor="escapeTrailingSpaces">
                        转义行尾空格和制表符
                      </label>
                    </div>
                  </div>
                  <div className="col-12 col-md-6">
                    <div className="form-check">
                      <input
                        className="form-check-input"
                        type="checkbox"
                        id="crlf"
                        checked={crlf}
                        onChange={(e) => setCrlf(e.target.checked)}
                      />
                      <label className="form-check-label" htmlFor="crlf">
                        使用 CRLF 作为换行（\r\n）
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
