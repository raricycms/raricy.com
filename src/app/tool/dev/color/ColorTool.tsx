'use client';

// 颜色转换：HEX / RGB / HSL 互转、色块预览、与白底 / 黑底的 WCAG 对比度。
//
// 解析与换算全在 `src/lib/dev-tools/color.ts`（纯函数、可单测）；这里只负责展示。
// 半透明色（alpha < 1）的对比度按「合成到该背景之后」计算 —— 直接拿半透明色算亮度
// 是错的，屏幕上看到的不是它本身。
import { useMemo, useState } from 'react';
import {
  colorFormats,
  contrastAgainst,
  formatContrast,
  parseColor,
  readableTextOn,
  rgbaToCss,
  wcagLevels,
  type Rgba,
} from '@/lib/dev-tools/color';

const WHITE: Rgba = { r: 255, g: 255, b: 255, a: 1 };
const BLACK: Rgba = { r: 0, g: 0, b: 0, a: 1 };

const FORMAT_LABELS = [
  { key: 'hex', label: 'HEX' },
  { key: 'rgb', label: 'RGB' },
  { key: 'hsl', label: 'HSL' },
] as const;

const CONTRAST_BACKDROPS = [
  { key: 'white', label: '白底', background: WHITE },
  { key: 'black', label: '黑底', background: BLACK },
] as const;

export default function ColorTool() {
  const [input, setInput] = useState('#2563eb');
  const [status, setStatus] = useState('');

  const parsed = useMemo(() => parseColor(input), [input]);

  async function copyValue(label: string, value: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(value);
      setStatus(`已复制 ${label}`);
    } catch {
      setStatus('复制失败（浏览器未授予剪贴板权限）');
    }
  }

  return (
    <div>
      <div className="devtool-bar">
        <label className="form-label" htmlFor="color-input">
          颜色值
        </label>
        <input
          id="color-input"
          className="form-control mono devtool-color__input"
          value={input}
          onChange={(event) => setInput(event.target.value)}
          placeholder="#2563eb、rgb(37, 99, 235) 或 hsl(221, 83%, 53%)"
          spellCheck={false}
        />
      </div>
      <p className="devtool-hint">
        支持 #RGB / #RGBA / #RRGGBB / #RRGGBBAA、rgb()/rgba()、hsl()/hsla()；也接受
        CSS Color 4 的空格式法（例如 <span className="mono">rgb(37 99 235 / 50%)</span>）。
      </p>

      {parsed.ok ? (
        <>
          <div
            className="devtool-color__swatch"
            style={{ backgroundColor: rgbaToCss(parsed.color) }}
          >
            <span className="devtool-color__swatch-label mono">{colorFormats(parsed.color).hex}</span>
          </div>

          <div className="devtool-color__value-list">
            {FORMAT_LABELS.map((format) => {
              const value = colorFormats(parsed.color)[format.key];
              return (
                <div className="devtool-color__value-row" key={format.key}>
                  <span className="devtool-color__value-label">{format.label}</span>
                  <code className="devtool-color__value">{value}</code>
                  <button
                    type="button"
                    className="btn btn-sm btn-outline-secondary"
                    onClick={() => copyValue(format.label, value)}
                  >
                    复制
                  </button>
                </div>
              );
            })}
          </div>

          <h2 className="devtool-code__subhead">WCAG 对比度</h2>
          <div className="devtool-color__contrast-grid">
            {CONTRAST_BACKDROPS.map((item) => {
              const ratio = contrastAgainst(parsed.color, item.background);
              const levels = wcagLevels(ratio);
              return (
                <div
                  className="devtool-color__contrast-card"
                  key={item.key}
                  style={{
                    backgroundColor: rgbaToCss(item.background),
                    color: readableTextOn(item.background),
                  }}
                >
                  <div className="devtool-color__contrast-title">与{item.label}的对比度</div>
                  <div className="devtool-color__ratio">{formatContrast(ratio)}</div>
                  <div className="devtool-color__level-row">
                    <span className={levels.aaNormal ? 'devtool-badge devtool-badge--ok' : 'devtool-badge devtool-badge--danger'}>
                      正文 AA {levels.aaNormal ? '通过' : '未通过'}
                    </span>
                    <span className={levels.aaaNormal ? 'devtool-badge devtool-badge--ok' : 'devtool-badge devtool-badge--danger'}>
                      正文 AAA {levels.aaaNormal ? '通过' : '未通过'}
                    </span>
                    <span className={levels.aaLarge ? 'devtool-badge devtool-badge--ok' : 'devtool-badge devtool-badge--danger'}>
                      大字 AA {levels.aaLarge ? '通过' : '未通过'}
                    </span>
                    <span className={levels.aaaLarge ? 'devtool-badge devtool-badge--ok' : 'devtool-badge devtool-badge--danger'}>
                      大字 AAA {levels.aaaLarge ? '通过' : '未通过'}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
          <p className="devtool-hint">
            正文阈值为 4.5（AA）/ 7（AAA），大字（≥ 24px 或 ≥ 18.66px 粗体）为 3 / 4.5。
            {parsed.color.a < 1 ? ' 当前颜色带透明度，对比度按合成到各背景上的实际颜色计算。' : ''}
          </p>
        </>
      ) : (
        <p className="devtool-error">{parsed.error}</p>
      )}

      <p className="devtool-status">{status}</p>
    </div>
  );
}
