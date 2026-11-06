'use client';

// 条形码生成器：EAN-13 / Code 128 / Code 39。
// 编码逻辑在 `@/lib/dev-tools/barcode.ts`（零 DOM，单测覆盖校验位与编码表）；
// 这里只做表单、预览与 SVG 下载。
//
// 预览与下载**共用** `barcodeBars()` 的矩形列表 —— 不能各写一套，
// 否则最容易出现「预览对、下载错一位」这种不报错的坏法。

import { useEffect, useState } from 'react';
import {
  BARCODE_FORMATS,
  BARCODE_QUIET_MODULES,
  barcodeBars,
  barcodeSvg,
  encodeBarcode,
  findBarcodeFormat,
  type BarcodeFormat,
  type BarcodeSymbol,
} from '@/lib/dev-tools/barcode';
import { errorText } from '@/lib/dev-tools/response-read';

/** 预览的每模块像素宽（viewBox 坐标）。 */
const PREVIEW_MODULE_WIDTH = 3;
/** 预览条高（viewBox 坐标）。 */
const PREVIEW_BAR_HEIGHT = 70;
/** 预览文本区高度。 */
const PREVIEW_TEXT_HEIGHT = 22;
/** 下载 SVG 的每模块像素宽。 */
const DOWNLOAD_MODULE_WIDTH = 4;
/** 下载 SVG 的条高。 */
const DOWNLOAD_BAR_HEIGHT = 120;

function downloadBlobUrl(url: string, filename: string): void {
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export default function BarcodeTool() {
  const [format, setFormat] = useState<BarcodeFormat>('ean13');
  const [value, setValue] = useState(findBarcodeFormat('ean13').example);
  const [symbol, setSymbol] = useState<BarcodeSymbol | null>(null);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');

  useEffect(() => {
    try {
      setSymbol(encodeBarcode('ean13', findBarcodeFormat('ean13').example));
    } catch {
      // 内置示例必然合法
    }
  }, []);

  function generate(nextFormat: BarcodeFormat = format, nextValue: string = value): void {
    try {
      const encoded = encodeBarcode(nextFormat, nextValue);
      setSymbol(encoded);
      setError('');
      setStatus(`${encoded.label}：${encoded.modules.length} 个模块`);
    } catch (e) {
      setSymbol(null);
      setStatus('');
      setError(errorText(e));
    }
  }

  function useExample(): void {
    const example = findBarcodeFormat(format).example;
    setValue(example);
    generate(format, example);
  }

  function downloadSvg(): void {
    if (!symbol) {
      setError('请先生成条形码');
      return;
    }
    const svg = barcodeSvg(symbol, {
      moduleWidth: DOWNLOAD_MODULE_WIDTH,
      barHeight: DOWNLOAD_BAR_HEIGHT,
      textHeight: 26,
      quietModules: BARCODE_QUIET_MODULES,
      showText: true,
    });
    const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
    downloadBlobUrl(URL.createObjectURL(blob), `${symbol.format}.svg`);
    setError(''); // 成功必须清掉旧错误，否则「已导出」会被上一条错误压住
    setStatus('已导出 SVG');
  }

  const def = findBarcodeFormat(format);
  const bars = symbol ? barcodeBars(symbol, BARCODE_QUIET_MODULES) : null;
  const previewWidth = bars ? bars.totalWidth * PREVIEW_MODULE_WIDTH : 0;
  const previewHeight = PREVIEW_BAR_HEIGHT + PREVIEW_TEXT_HEIGHT;

  return (
    <div className="devtool-split devtool-split--left">
      <div className="tool-panel p-3">
        <div className="devtool-net-field">
          <label className="form-label" htmlFor="barcode-format">
            格式
          </label>
          <select
            id="barcode-format"
            className="form-select"
            value={format}
            onChange={(e) => {
              const next = e.target.value as BarcodeFormat;
              setFormat(next);
              // 预览 / 下载必须跟着格式走：不清 symbol 会继续导出上一个格式的图（R3-483）。
              setSymbol(null);
              setError('');
              setStatus('');
            }}
          >
            {BARCODE_FORMATS.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </select>
          <p className="devtool-hint">{def.hint}</p>
          <p className="devtool-hint">校验规则：{def.checkDigit}</p>
        </div>

        <div className="devtool-net-field">
          <label className="form-label" htmlFor="barcode-value">
            内容
          </label>
          <input
            id="barcode-value"
            type="text"
            className="form-control mono"
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              // 内容变了，旧结果（含旧错误）立即失效。
              setSymbol(null);
              setError('');
              setStatus('');
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                generate();
              }
            }}
            placeholder={def.example}
          />
        </div>

        <div className="devtool-bar">
          <button type="button" className="btn btn-primary" onClick={() => generate()}>
            生成条形码
          </button>
          <button type="button" className="btn btn-outline-secondary" onClick={downloadSvg}>
            下载 SVG
          </button>
          <button type="button" className="btn btn-outline-secondary btn-sm" onClick={useExample}>
            填入示例
          </button>
        </div>

        {error ? <p className="devtool-error">{error}</p> : null}
        {status && !error ? <p className="devtool-hint devtool-status">{status}</p> : null}
      </div>

      <div className="tool-panel p-3">
        <h2 className="devtool-net-heading">预览</h2>
        {symbol && bars ? (
          <>
            <div className="devtool-preview">
              <svg
                className="devtool-net-barcode-svg"
                viewBox={`0 0 ${previewWidth} ${previewHeight}`}
                role="img"
                aria-label={`${symbol.label} 条形码：${symbol.text}`}
              >
                <rect x={0} y={0} width={previewWidth} height={previewHeight} fill="#ffffff" />
                {bars.bars.map((bar) => (
                  <rect
                    key={`${bar.x}-${bar.width}`}
                    x={bar.x * PREVIEW_MODULE_WIDTH}
                    y={0}
                    width={bar.width * PREVIEW_MODULE_WIDTH}
                    height={PREVIEW_BAR_HEIGHT}
                    fill="#000000"
                  />
                ))}
                <text
                  x={previewWidth / 2}
                  y={PREVIEW_BAR_HEIGHT + 16}
                  textAnchor="middle"
                  fontFamily="monospace"
                  fontSize={14}
                  fill="#000000"
                >
                  {symbol.text}
                </text>
              </svg>
            </div>
            <dl className="devtool-kv">
              <dt>内容</dt>
              <dd className="mono">{symbol.text}</dd>
              <dt>编码宽度</dt>
              <dd>{symbol.modules.length} 模块（不含两侧各 {BARCODE_QUIET_MODULES} 模块静区）</dd>
            </dl>
            <p className="devtool-hint">{symbol.note}</p>
          </>
        ) : (
          <p className="devtool-hint">还没有生成结果。</p>
        )}
      </div>
    </div>
  );
}
