'use client';

// 二维码生成器的客户端组件。真正的编码 / 布局逻辑在 `@/lib/dev-tools/qr.ts`
// （零 DOM、node 可测），这里只负责表单、预览与下载。
//
// 【下载 PNG 为什么要过 canvas】`qrcode-generator` 的 `createDataURL()` 产出的是
// **GIF** data URL。把 GIF 字节直接存成 `.png` 是静默的假文件（扩展名对了、内容不对），
// 所以这里把预览图重新画进 canvas、再 `toBlob('image/png')`，得到真正的 PNG。
// SVG 下载则直接落 `renderQr()` 返回的矢量源码。

import { useEffect, useState } from 'react';
import {
  QR_ERROR_LEVELS,
  QR_ERROR_LEVEL_LABELS,
  QR_MAX_MARGIN_MODULES,
  QR_MAX_SIZE,
  QR_MIN_MARGIN_MODULES,
  QR_MIN_SIZE,
  renderQr,
  type QrErrorLevel,
  type QrRender,
} from '@/lib/dev-tools/qr';
import { errorText } from '@/lib/dev-tools/response-read';

const DEFAULT_TEXT = 'https://raricy.com';

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('二维码图片解码失败'));
    img.src = src;
  });
}

/** 触发浏览器下载一个 Blob URL（用完即回收）。 */
function downloadBlobUrl(url: string, filename: string): void {
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // 立刻 revoke 在部分浏览器上会让下载失败，留一拍再回收
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export default function QrTool() {
  const [text, setText] = useState(DEFAULT_TEXT);
  const [level, setLevel] = useState<QrErrorLevel>('M');
  const [size, setSize] = useState(256);
  const [margin, setMargin] = useState(QR_MIN_MARGIN_MODULES);
  const [result, setResult] = useState<QrRender | null>(null);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');

  useEffect(() => {
    try {
      setResult(renderQr(DEFAULT_TEXT, { level: 'M', size: 256, marginModules: QR_MIN_MARGIN_MODULES }));
    } catch {
      // 默认内容必然合法；这里只是防御，不覆盖页面上的错误提示
    }
  }, []);

  function generate(): void {
    try {
      const rendered = renderQr(text, { level, size, marginModules: margin });
      setResult(rendered);
      setError('');
      setStatus(`已生成：${rendered.moduleCount}×${rendered.moduleCount} 模块`);
    } catch (e) {
      setResult(null);
      setStatus('');
      setError(errorText(e));
    }
  }

  async function copyText(): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      setStatus('内容已复制');
    } catch {
      setStatus('复制失败：浏览器拒绝访问剪贴板');
    }
  }

  async function downloadPng(): Promise<void> {
    if (!result) {
      setError('请先生成二维码');
      return;
    }
    try {
      const img = await loadImage(result.dataUrl);
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth || result.pixelSize;
      canvas.height = img.naturalHeight || result.pixelSize;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('当前浏览器不支持 Canvas，无法导出 PNG');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(img, 0, 0);
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
      if (!blob) throw new Error('PNG 编码失败');
      downloadBlobUrl(URL.createObjectURL(blob), 'qrcode.png');
      setStatus('已导出 PNG');
    } catch (e) {
      setError('导出 PNG 失败：' + errorText(e));
    }
  }

  function downloadSvg(): void {
    if (!result) {
      setError('请先生成二维码');
      return;
    }
    const blob = new Blob([result.svg], { type: 'image/svg+xml;charset=utf-8' });
    downloadBlobUrl(URL.createObjectURL(blob), 'qrcode.svg');
    setStatus('已导出 SVG');
  }

  return (
    <div className="devtool-split devtool-split--left">
      <div className="tool-panel p-3">
        <label className="form-label" htmlFor="qr-text">
          内容（链接 / 文本 / 中文都可以）
        </label>
        <textarea
          id="qr-text"
          className="devtool-input"
          rows={6}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setStatus('');
          }}
          onKeyDown={(e) => {
            if (e.ctrlKey && e.key === 'Enter') {
              e.preventDefault();
              generate();
            }
          }}
          placeholder="输入要编码的文本或网址"
        />

        <div className="devtool-net-field">
          <label className="form-label" htmlFor="qr-level">
            纠错级别
          </label>
          <select
            id="qr-level"
            className="form-select"
            value={level}
            onChange={(e) => {
              setLevel(e.target.value as QrErrorLevel);
              setStatus('');
            }}
          >
            {QR_ERROR_LEVELS.map((value) => (
              <option key={value} value={value}>
                {QR_ERROR_LEVEL_LABELS[value]}
              </option>
            ))}
          </select>
        </div>

        <div className="devtool-net-field">
          <label className="form-label" htmlFor="qr-size">
            尺寸：{size}px（{QR_MIN_SIZE}–{QR_MAX_SIZE}）
          </label>
          <input
            id="qr-size"
            type="range"
            min={QR_MIN_SIZE}
            max={QR_MAX_SIZE}
            step={8}
            value={size}
            onChange={(e) => {
              setSize(Number(e.target.value));
              setStatus('');
            }}
          />
        </div>

        <div className="devtool-net-field">
          <label className="form-label" htmlFor="qr-margin">
            静区边距：{margin} 模块（{QR_MIN_MARGIN_MODULES}–{QR_MAX_MARGIN_MODULES}）
          </label>
          <input
            id="qr-margin"
            type="range"
            min={QR_MIN_MARGIN_MODULES}
            max={QR_MAX_MARGIN_MODULES}
            step={1}
            value={margin}
            onChange={(e) => {
              setMargin(Number(e.target.value));
              setStatus('');
            }}
          />
          <p className="devtool-hint">
            静区低于 4 个模块时部分扫码器会识别失败，所以这里不提供更小的值。
          </p>
        </div>

        <div className="devtool-bar">
          <button type="button" className="btn btn-primary" onClick={generate}>
            生成二维码
          </button>
          <button type="button" className="btn btn-outline-secondary" onClick={downloadPng}>
            下载 PNG
          </button>
          <button type="button" className="btn btn-outline-secondary" onClick={downloadSvg}>
            下载 SVG
          </button>
          <button type="button" className="btn btn-outline-secondary btn-sm" onClick={copyText}>
            复制内容
          </button>
        </div>

        {error ? <p className="devtool-error">{error}</p> : null}
        {status && !error ? <p className="devtool-hint devtool-status">{status}</p> : null}
      </div>

      <div className="tool-panel p-3">
        <h2 className="devtool-net-heading">预览</h2>
        {result ? (
          <>
            <div className="devtool-preview">
              <img
                src={result.dataUrl}
                width={result.pixelSize}
                height={result.pixelSize}
                alt="二维码预览"
              />
            </div>
            <dl className="devtool-kv">
              <dt>模块数</dt>
              <dd>
                {result.moduleCount} × {result.moduleCount}
              </dd>
              <dt>输出像素</dt>
              <dd>
                {result.pixelSize} × {result.pixelSize}px
              </dd>
              <dt>纠错级别</dt>
              <dd>{result.level}</dd>
            </dl>
            <p className="devtool-hint">
              预览图是 GIF data URL（库的默认输出）；下载 PNG 时会重新编码成真正的 PNG。
            </p>
          </>
        ) : (
          <p className="devtool-hint">还没有生成结果。</p>
        )}
      </div>
    </div>
  );
}
