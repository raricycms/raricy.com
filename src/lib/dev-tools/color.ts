// ─────────────────────────────────────────────────────────────────────────────
// color.ts —— 「颜色转换」的纯逻辑（HEX ↔ RGB ↔ HSL、WCAG 对比度）
//
// 【为什么是零依赖】页面在浏览器里实时换算，单测在 node 里直接 import；不取「现在」、
// 不碰 DOM。
//
// 【解析口径】
//   · 接受 `#RGB` / `#RGBA` / `#RRGGBB` / `#RRGGBBAA`、`rgb()` / `rgba()`、
//     `hsl()` / `hsla()`；也接受 CSS Color 4 的空格式法（`rgb(255 0 0 / 50%)`、
//     `hsl(0 100% 50%)`），因为现代浏览器的 computed style 就长这样。
//   · rgb 通道支持百分数（`50%` = 127.5 → 128）；alpha 支持 `0.5` 与 `50%`。
//   · hsl 的 s / l 必须是百分数（或 0–100 的数）；h 支持 `deg` 后缀，也接受负数
//     与超过 360 的值（按 360 取模）。`hsl(0, 0%, 100%)` 这类灰阶照样能转。
//   · 解析失败返回 `{ ok: false, error }`，错误文案直接给用户看：**哪一段不合法**
//     要说得出，不能只说「格式错误」。
//
// 【对比度口径】WCAG 2.x：先按 sRGB 相对亮度公式算亮度，比值 = (亮 + 0.05) / (暗 + 0.05)。
// 半透明色（alpha < 1）先**合成到给定背景上**再比 —— 直接拿半透明色算亮度是错的，
// 屏幕上看到的颜色不是它本身。AA/AAA 的阈值：正文 4.5 / 7，大字 3 / 4.5。
// ─────────────────────────────────────────────────────────────────────────────

export interface Rgba {
  /** 0–255 的整数。 */
  r: number;
  g: number;
  b: number;
  /** 0–1。 */
  a: number;
}

export type ColorParseResult = { ok: true; color: Rgba } | { ok: false; error: string };

export interface ColorFormats {
  /** `#rrggbb`，alpha < 1 时是 `#rrggbbaa`。 */
  hex: string;
  /** `rgb(r, g, b)` / `rgba(r, g, b, a)`。 */
  rgb: string;
  /** `hsl(h, s%, l%)` / `hsla(h, s%, l%, a)`。 */
  hsl: string;
}

export interface Hsl {
  /** 0–360。 */
  h: number;
  /** 0–100。 */
  s: number;
  /** 0–100。 */
  l: number;
  /** 0–1。 */
  a: number;
}

export interface WcagLevels {
  /** 正文（< 18pt 或 < 14pt 粗体）AA：≥ 4.5。 */
  aaNormal: boolean;
  /** 正文 AAA：≥ 7。 */
  aaaNormal: boolean;
  /** 大字 AA：≥ 3。 */
  aaLarge: boolean;
  /** 大字 AAA：≥ 4.5。 */
  aaaLarge: boolean;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function round(value: number): number {
  return Math.round(value);
}

/** 每两位十六进制 → 0–255；调用方已保证长度与字符合法。 */
function parseHexPair(pair: string): number {
  return parseInt(pair, 16);
}

function parseAlpha(raw: string): number | null {
  const text = raw.trim();
  if (text === '') return null;
  const value = text.endsWith('%') ? Number(text.slice(0, -1)) / 100 : Number(text);
  if (!Number.isFinite(value)) return null;
  return clamp(value, 0, 1);
}

/** 解析一个 0–255 的 rgb 通道（支持 `50%`）。 */
function parseChannel(raw: string): number | null {
  const text = raw.trim();
  if (text === '') return null;
  const value = text.endsWith('%') ? (Number(text.slice(0, -1)) / 100) * 255 : Number(text);
  if (!Number.isFinite(value)) return null;
  return clamp(Math.round(value), 0, 255);
}

/** 解析 s / l 这类百分数（允许不带 `%` 的 0–100）。 */
function parsePercentage(raw: string): number | null {
  const text = raw.trim();
  if (text === '') return null;
  const value = text.endsWith('%') ? Number(text.slice(0, -1)) : Number(text);
  if (!Number.isFinite(value)) return null;
  return clamp(value, 0, 100);
}

function parseHue(raw: string): number | null {
  const text = raw.trim().replace(/deg$/i, '');
  if (text === '') return null;
  const value = Number(text);
  if (!Number.isFinite(value)) return null;
  // 允许负数与 > 360：按 360 取模（CSS 也是这个语义）。
  return ((value % 360) + 360) % 360;
}

/** 把函数式颜色的内部参数切成通道与 alpha：同时支持逗号法与空格 + `/` 法。 */
function splitColorArgs(inner: string): { channels: string[]; alpha: string | null } {
  const slashParts = inner.split('/');
  const head = slashParts[0];
  const alpha = slashParts.length > 1 ? slashParts[1] : null;
  const channels = head.includes(',')
    ? head.split(',').map((part) => part.trim())
    : head
        .trim()
        .split(/\s+/)
        .filter((part) => part !== '');
  return { channels, alpha };
}

/**
 * 解析任意一种受支持的颜色写法。失败时 `error` 是给用户看的中文说明。
 */
export function parseColor(input: string): ColorParseResult {
  const text = input.trim();
  if (text === '') return { ok: false, error: '请输入颜色值，例如 #2563eb、rgb(37, 99, 235) 或 hsl(221, 83%, 53%)。' };

  // ── HEX ────────────────────────────────────────────────────────────────────
  const hexMatch = /^#([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.exec(text);
  if (hexMatch) {
    const hex = hexMatch[1].toLowerCase();
    const expand = (ch: string) => parseHexPair(ch + ch);
    if (hex.length === 3 || hex.length === 4) {
      return {
        ok: true,
        color: {
          r: expand(hex[0]),
          g: expand(hex[1]),
          b: expand(hex[2]),
          a: hex.length === 4 ? expand(hex[3]) / 255 : 1,
        },
      };
    }
    return {
      ok: true,
      color: {
        r: parseHexPair(hex.slice(0, 2)),
        g: parseHexPair(hex.slice(2, 4)),
        b: parseHexPair(hex.slice(4, 6)),
        a: hex.length === 8 ? parseHexPair(hex.slice(6, 8)) / 255 : 1,
      },
    };
  }

  // ── rgb() / rgba() ─────────────────────────────────────────────────────────
  const rgbMatch = /^rgba?\s*\(([^)]*)\)$/i.exec(text);
  if (rgbMatch) {
    const { channels, alpha } = splitColorArgs(rgbMatch[1]);
    if (channels.length !== 3) {
      return { ok: false, error: 'rgb()/rgba() 需要 3 个颜色通道，例如 rgb(255, 0, 0) 或 rgb(255 0 0 / 50%)。' };
    }
    const [r, g, b] = channels.map(parseChannel);
    if (r === null || g === null || b === null) {
      return { ok: false, error: `rgb() 的通道值不合法：${channels.join(', ')}。通道应为 0–255 的整数或百分数。` };
    }
    const a = alpha === null ? 1 : parseAlpha(alpha);
    if (a === null) {
      return { ok: false, error: `alpha 值不合法：${alpha ?? ''}。应为 0–1 的小数或百分数。` };
    }
    return { ok: true, color: { r, g, b, a } };
  }

  // ── hsl() / hsla() ─────────────────────────────────────────────────────────
  const hslMatch = /^hsla?\s*\(([^)]*)\)$/i.exec(text);
  if (hslMatch) {
    const { channels, alpha } = splitColorArgs(hslMatch[1]);
    if (channels.length !== 3) {
      return { ok: false, error: 'hsl()/hsla() 需要 3 个参数，例如 hsl(221, 83%, 53%)。' };
    }
    const h = parseHue(channels[0]);
    const s = parsePercentage(channels[1]);
    const l = parsePercentage(channels[2]);
    if (h === null || s === null || l === null) {
      return {
        ok: false,
        error: `hsl() 的参数不合法：${channels.join(', ')}。色相是 0–360 的数，饱和度与亮度是百分数。`,
      };
    }
    const a = alpha === null ? 1 : parseAlpha(alpha);
    if (a === null) {
      return { ok: false, error: `alpha 值不合法：${alpha ?? ''}。应为 0–1 的小数或百分数。` };
    }
    return { ok: true, color: { ...hslToRgba({ h, s, l, a }) } };
  }

  return {
    ok: false,
    error: '无法识别的颜色格式。支持 #RGB / #RRGGBB / #RRGGBBAA、rgb()/rgba()、hsl()/hsla()。',
  };
}

/** HSL → RGB（输入 s/l 为百分数）。 */
export function hslToRgba(hsl: Hsl): Rgba {
  const h = ((hsl.h % 360) + 360) % 360;
  const s = clamp(hsl.s, 0, 100) / 100;
  const l = clamp(hsl.l, 0, 100) / 100;

  if (s === 0) {
    const value = round(l * 255);
    return { r: value, g: value, b: value, a: hsl.a };
  }

  const chroma = (1 - Math.abs(2 * l - 1)) * s;
  const hp = h / 60;
  const x = chroma * (1 - Math.abs((hp % 2) - 1));
  const m = l - chroma / 2;

  let rp = 0;
  let gp = 0;
  let bp = 0;
  if (hp < 1) {
    rp = chroma;
    gp = x;
  } else if (hp < 2) {
    rp = x;
    gp = chroma;
  } else if (hp < 3) {
    gp = chroma;
    bp = x;
  } else if (hp < 4) {
    gp = x;
    bp = chroma;
  } else if (hp < 5) {
    rp = x;
    bp = chroma;
  } else {
    rp = chroma;
    bp = x;
  }

  return {
    r: clamp(round((rp + m) * 255), 0, 255),
    g: clamp(round((gp + m) * 255), 0, 255),
    b: clamp(round((bp + m) * 255), 0, 255),
    a: clamp(hsl.a, 0, 1),
  };
}

/** RGB → HSL。返回的 h 在 0–360，s/l 是 0–100 的百分数（保留 1 位小数）。 */
export function rgbaToHsl(color: Rgba): Hsl {
  const r = clamp(color.r, 0, 255) / 255;
  const g = clamp(color.g, 0, 255) / 255;
  const b = clamp(color.b, 0, 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  const l = (max + min) / 2;

  let h = 0;
  if (delta !== 0) {
    if (max === r) h = ((g - b) / delta) % 6;
    else if (max === g) h = (b - r) / delta + 2;
    else h = (r - g) / delta + 4;
    h *= 60;
    if (h < 0) h += 360;
  }

  const s = delta === 0 ? 0 : delta / (1 - Math.abs(2 * l - 1));

  return {
    h: round1(h),
    s: percent1(s),
    l: percent1(l),
    a: clamp(color.a, 0, 1),
  };
}

/** 保留 1 位小数（颜色的展示精度）。 */
function round1(value: number): number {
  return Number(value.toFixed(1));
}

/** 0–1 的分量 → 0–100 的百分数，保留 1 位小数。 */
function percent1(value: number): number {
  return Number((value * 100).toFixed(1));
}

/** 格式化 alpha：最多 3 位小数，去掉多余的 0。 */
function formatAlpha(alpha: number): string {
  return String(Number(clamp(alpha, 0, 1).toFixed(3)));
}

function roundChannel(value: number): number {
  return clamp(round(value), 0, 255);
}

/** RGB(A) → `#rrggbb` / `#rrggbbaa`。 */
export function rgbaToHex(color: Rgba): string {
  const r = roundChannel(color.r).toString(16).padStart(2, '0');
  const g = roundChannel(color.g).toString(16).padStart(2, '0');
  const b = roundChannel(color.b).toString(16).padStart(2, '0');
  const a = clamp(color.a, 0, 1);
  if (a >= 1) return `#${r}${g}${b}`;
  const alpha = round(clamp(a, 0, 1) * 255)
    .toString(16)
    .padStart(2, '0');
  return `#${r}${g}${b}${alpha}`;
}

/** RGB(A) → CSS 的 `rgb()` / `rgba()`。 */
export function rgbaToCss(color: Rgba): string {
  const r = roundChannel(color.r);
  const g = roundChannel(color.g);
  const b = roundChannel(color.b);
  const a = clamp(color.a, 0, 1);
  return a >= 1 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${formatAlpha(a)})`;
}

/** HSL(A) → CSS 的 `hsl()` / `hsla()`。 */
export function hslToCss(hsl: Hsl): string {
  const h = round1((((hsl.h % 360) + 360) % 360));
  const s = round1(clamp(hsl.s, 0, 100));
  const l = round1(clamp(hsl.l, 0, 100));
  const a = clamp(hsl.a, 0, 1);
  return a >= 1 ? `hsl(${h}, ${s}%, ${l}%)` : `hsla(${h}, ${s}%, ${l}%, ${formatAlpha(a)})`;
}

/** 一次拿到三种常用写法。 */
export function colorFormats(color: Rgba): ColorFormats {
  return {
    hex: rgbaToHex(color),
    rgb: rgbaToCss(color),
    hsl: hslToCss(rgbaToHsl(color)),
  };
}

// ── 对比度 ──────────────────────────────────────────────────────────────────

/** sRGB 单通道 → 线性光（WCAG 2.x 定义）。 */
function linearize(channel255: number): number {
  const c = clamp(channel255, 0, 255) / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** 相对亮度（忽略 alpha；半透明请先 `compositeOver` 到背景再算）。 */
export function relativeLuminance(color: Rgba): number {
  return 0.2126 * linearize(color.r) + 0.7152 * linearize(color.g) + 0.0722 * linearize(color.b);
}

/** 把（可能半透明的）前景色合成到不透明背景上。 */
export function compositeOver(foreground: Rgba, background: Rgba): Rgba {
  const a = clamp(foreground.a, 0, 1);
  return {
    r: roundChannel(foreground.r * a + background.r * (1 - a)),
    g: roundChannel(foreground.g * a + background.g * (1 - a)),
    b: roundChannel(foreground.b * a + background.b * (1 - a)),
    a: 1,
  };
}

/** 两个不透明颜色的对比度，1–21。 */
export function contrastRatio(a: Rgba, b: Rgba): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

/** 前景色（可半透明）叠在给定背景上的实际对比度。 */
export function contrastAgainst(foreground: Rgba, background: Rgba): number {
  return contrastRatio(compositeOver(foreground, background), { ...background, a: 1 });
}

/** WCAG AA / AAA 判定（正文与大字）。 */
export function wcagLevels(ratio: number): WcagLevels {
  return {
    aaNormal: ratio >= 4.5,
    aaaNormal: ratio >= 7,
    aaLarge: ratio >= 3,
    aaaLarge: ratio >= 4.5,
  };
}

/** 对比度展示文案：`4.52:1`。 */
export function formatContrast(ratio: number): string {
  return `${ratio.toFixed(2)}:1`;
}

/** 在给定底色上，用黑字还是白字更清楚（供色块上的文字用）。 */
export function readableTextOn(background: Rgba): '#000000' | '#ffffff' {
  const black: Rgba = { r: 0, g: 0, b: 0, a: 1 };
  const white: Rgba = { r: 255, g: 255, b: 255, a: 1 };
  return contrastAgainst(black, background) >= contrastAgainst(white, background) ? '#000000' : '#ffffff';
}
