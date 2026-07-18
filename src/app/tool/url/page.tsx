'use client';

// 逐字对齐原 Flask 模板 tool/url.html（纯前端计算）。
import Link from 'next/link';
import { useState } from 'react';

export default function UrlToolPage() {
  const [left, setLeft] = useState('');
  const [right, setRight] = useState('');
  const [status, setStatus] = useState('');
  const [useEncodeURI, setUseEncodeURI] = useState(true);
  const [spacePlus, setSpacePlus] = useState(false);
  const [preserveSlash, setPreserveSlash] = useState(false);
  const [lowercaseHex, setLowercaseHex] = useState(false);

  function customEncode(input: string): string {
    const encoder = useEncodeURI ? encodeURIComponent : encodeURI;
    let encoded = encoder(input);
    if (preserveSlash) {
      encoded = encoded.replace(/%2F/gi, '/');
    }
    if (spacePlus) {
      encoded = encoded.replace(/%20/g, '+');
    }
    if (lowercaseHex) {
      encoded = encoded.replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase());
    }
    return encoded;
  }

  function customDecode(input: string): string {
    let text = input || '';
    if (spacePlus) {
      text = text.replace(/\+/g, '%20');
    }
    const decoder = useEncodeURI ? decodeURIComponent : decodeURI;
    try {
      return decoder(text);
    } catch (e) {
      return '[解码失败] ' + ((e as Error).message || '');
    }
  }

  const encodeLeftToRight = () => {
    setRight(customEncode(left || ''));
    setStatus('完成');
  };
  const decodeRightToLeft = () => {
    setLeft(customDecode(right || ''));
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
          <h1 className="mb-0 section-title">URL 编码 / 解码</h1>
        </div>
        <p className="text-muted mb-3">
          支持 encodeURIComponent / encodeURI，空格用 + 或 %20，保留斜杠等选项。
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
                        id="useEncodeURI"
                        checked={useEncodeURI}
                        onChange={(e) => setUseEncodeURI(e.target.checked)}
                      />
                      <label className="form-check-label" htmlFor="useEncodeURI">
                        使用 encodeURIComponent（取消选中使用 encodeURI）
                      </label>
                    </div>
                  </div>
                  <div className="col-12 col-md-6">
                    <div className="form-check">
                      <input
                        className="form-check-input"
                        type="checkbox"
                        id="spacePlus"
                        checked={spacePlus}
                        onChange={(e) => setSpacePlus(e.target.checked)}
                      />
                      <label className="form-check-label" htmlFor="spacePlus">
                        空格编码为 + （适用于 application/x-www-form-urlencoded）
                      </label>
                    </div>
                  </div>
                  <div className="col-12 col-md-6">
                    <div className="form-check">
                      <input
                        className="form-check-input"
                        type="checkbox"
                        id="preserveSlash"
                        checked={preserveSlash}
                        onChange={(e) => setPreserveSlash(e.target.checked)}
                      />
                      <label className="form-check-label" htmlFor="preserveSlash">
                        保留斜杠 / 不编码
                      </label>
                    </div>
                  </div>
                  <div className="col-12 col-md-6">
                    <div className="form-check">
                      <input
                        className="form-check-input"
                        type="checkbox"
                        id="lowercaseHex"
                        checked={lowercaseHex}
                        onChange={(e) => setLowercaseHex(e.target.checked)}
                      />
                      <label className="form-check-label" htmlFor="lowercaseHex">
                        百分号转义使用小写十六进制（%2f 而非 %2F）
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
