// ─────────────────────────────────────────────────────────────────────────────
// poster.ts — 画报 / 收款码的 SVG 构造（**纯函数**：不碰 prisma、不碰 sharp、不碰 fs）
//
// 两种画报共用一套版式语言（750 宽、圆角、渐变底、白色二维码卡片）：
//   • 个人主页画报 —— **深底**深蓝主题，二维码指向 ${SITE_URL}/u/<id>
//   • 鱼干收款码   —— **浅底**暖金主题，二维码指向 ${SITE_URL}/fish/collect?to=<username>
//
// 两张的底色深浅是**刻意不同**的（收款码原本也是深底，后按站长要求翻成浅底）：
// 浅底那张的每个前景色都要自己保证在奶油底上看得清，别再拿深底那张的色值直接套。
// 二维码卡片两张都是白底，所以解码对比度不受底色深浅影响 —— 换底色不必重测扫码。
//
// 高度按内容算出来（卡片高度取决于二维码模块数），不做成常量 —— 内容少时不留大片空白。
//
// 【铁律一：二维码必须是矢量矩形，永远不能是文字】
// 整张画报里只有二维码这一处是「不依赖服务器字体」的。sharp 走 librsvg + fontconfig，
// 服务器缺中文字体时所有文字都会变豆腐块 —— 那时二维码仍必须能扫，所以它的深色模块
// 一律拼成 <rect>，绝不走字体、也绝不走 <image>。
//
// 【铁律二：纠错等级必须 H】
// 二维码中心压了一个 logo，等于主动挖掉一块。H 级能容忍约 30% 的遮挡，
// 降到 M/Q 就可能出现「图好看但扫不出来」—— 这种故障最难排查。
//
// 【铁律三：单元尺寸必须取整、静默区必须 ≥ 4 模块】
// 这两条是实测出来的（曾用 jsQR 解不出来）：
//   • 模块尺寸非整数 → 边缘发虚，解码器在阈值化时丢模块；
//   • 静默区不够 → 短链接的模块更大，固定像素的内边距反而不够 4 个模块。
// 所以 cell 由 `floor(卡片宽 / (模块数 + 9))` 算出（取整 + 左右各留 4.5 模块），
// 一切尺寸从 cell 推出来，不再写死像素。
//
// 【铁律四：所有动态文本都要转义】
// 简介与用户名是用户可控的。少转义一个 < 就能让整张画报渲染失败（sharp 直接抛），
// 或者更糟 —— 把用户写的东西当成 SVG 结构执行。
// ─────────────────────────────────────────────────────────────────────────────

import qrcode from 'qrcode-generator';

/** 逻辑画布宽度。路由按 density=144（2×）光栅化。 */
export const POSTER_WIDTH = 750;
/** 二维码卡片的宽度（两种画报一致）。 */
export const CARD_WIDTH = 420;

/**
 * 中文字体栈 —— 服务器缺这些字体时**整张画报的文字都会变成豆腐块**。
 * 部署要求见 docs/deploy.md；`npm run diagnose` 有探针会提前告警。
 */
const FONT =
  "'Noto Sans SC','Source Han Sans SC','Source Han Sans CN','WenQuanYi Micro Hei'," +
  "'Microsoft YaHei','PingFang SC','Hiragino Sans GB',sans-serif";

/** 纠错等级 —— 见「铁律二」，不要改。 */
const QR_ECC = 'H';
/** 中心 logo 边长占二维码边长的比例（H 级容忍度约 30%，这里留足余量）。 */
const QR_LOGO_RATIO = 0.16;
/** 静默区：规范要求 4 个模块，这里留 4.5 的余量。 */
const QUIET_MODULES = 4.5;

/** 小鱼干图标（public/static/img/icons/fish.svg 的 path 与变换链）。
 *  直接内联成 <path> 而不是嵌 <image>：librsvg 处理嵌套图片的兼容性不值得赌，
 *  而内联后还能自由改颜色（原图是写死的 #6DD400 绿）。 */
const FISH_PATH =
  'M1247.75404,909.299224 C1251.55457,909.299224 1254.83026,911.546347 1256.32493,914.784426 ' +
  'L1256.43939,915.042205 C1255.00163,918.418705 1251.6542,920.785186 1247.75404,920.785186 ' +
  'C1247.12003,920.785186 1246.50062,920.72265 1245.90166,920.603409 C1246.69005,918.913347 ' +
  '1247.13004,917.029159 1247.13004,915.042205 C1247.13004,913.055204 1246.69003,911.170973 ' +
  '1245.90213,909.481636 C1246.50075,909.361748 1247.12009,909.299224 1247.75404,909.299224 Z ' +
  'M1261.40251,909.876255 L1261.40251,920.208156 L1256.43939,915.042205 L1261.40251,909.876255 Z ' +
  'M1244.40249,909.912488 C1245.16401,911.459856 1245.59174,913.201079 1245.59174,915.042205 ' +
  'C1245.59174,916.883331 1245.16401,918.624554 1244.40249,920.171923 C1242.00145,919.259378 ' +
  '1240.07072,917.396087 1239.06887,915.042311 C1240.06411,912.704661 1241.97474,910.851153 ' +
  '1244.35041,909.931849 Z M1242.78628,914.0364 C1242.23077,914.0364 1241.78044,914.4867 ' +
  '1241.78044,915.0422 C1241.78044,915.5977 1242.23077,916.048 1242.78628,916.048 ' +
  'C1243.3418,916.048 1243.79213,915.5977 1243.79213,915.0422 C1243.79213,914.4867 ' +
  '1243.3418,914.0364 1242.78628,914.0364 Z';
const FISH_TRANSFORM =
  'translate(12,9) rotate(135) translate(-11.236,-6.042) translate(-1239.000000,-909.000000)';

/**
 * 主题配色。深蓝对主页、暖金对鱼干。
 *
 * 底色的深浅两张不同（主页深、收款码浅），但**二维码卡片两张都是纯白**，
 * 二维码本身永远画在白卡上、用深色模块 —— 底色再怎么调都不影响解码对比度。
 *
 * 两边的字段**不要求对称**：`accent` / `logo` 只服务小鱼干图标，主页画报改用站点 logo
 * 之后就不需要了（留着会变成「这个颜色是干嘛的」式的死字段）。
 */
export const THEMES = {
  profile: {
    bg: ['#0B1220', '#152A4A', '#0B1220'],
    glow: '#2563EB',
    brand: '#E8EEF9',
    title: '#F4F8FF',
    muted: '#8FA2BC',
    faint: '#5C6B82',
    ring: 'rgba(96,165,250,0.55)',
    chipBg: 'rgba(96,165,250,0.16)',
    chipFg: '#BFDBFE',
    qrDark: '#0F172A',
  },
  collect: {
    bg: ['#FFF3DA', '#FFE1AB', '#FFF3DA'],
    glow: '#FFC65C',
    brand: '#8A5A12',
    accent: '#E09A00',
    title: '#5A3A0C',
    muted: '#A07B3E',
    faint: '#9C7B42',
    ring: 'rgba(224,154,0,0.5)',
    chipBg: 'rgba(224,154,0,0.16)',
    chipFg: '#8A5A12',
    qrDark: '#3B2A12',
    logo: '#B8860B',
  },
} as const;

type Theme = (typeof THEMES)['profile'] | (typeof THEMES)['collect'];

// ── 文本工具 ────────────────────────────────────────────────────────────────

/**
 * 去掉 XML 1.0 不允许的控制字符（保留 \t 与 \n）—— 简介里粘进一个 \x00
 * 就能让整张画报渲染失败。**故意不写成正则**：控制字符的字面量会让整个源文件
 * 变成「二进制文件」，grep / diff 从此都不好使。
 */
export function stripControlChars(s: string): string {
  let out = '';
  for (const ch of s) {
    const code = ch.codePointAt(0) ?? 0;
    const isControl = code < 0x20 ? ch !== '\t' && ch !== '\n' : code === 0x7f;
    if (!isControl) out += ch;
  }
  return out;
}

/** XML 转义。**任何进入 SVG 的动态文本都必须过这一道。** */
export function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** 转义 + 去控制字符的合体，进 SVG 的文本一律用它。 */
function t(s: string): string {
  return escapeXml(stripControlChars(s));
}

/**
 * 估算一个字符占几个 em。SVG 没有自动断行，只能按字宽估算 ——
 * 中日韩全角按 1em，ASCII 按 0.55em，其余按 0.8em。够排版用，不追求精确。
 */
function charEm(ch: string): number {
  const c = ch.codePointAt(0) ?? 0;
  if (c <= 0x7f) return 0.55;
  if (
    (c >= 0x2e80 && c <= 0x9fff) || // 中日韩部首 / 假名 / 汉字
    (c >= 0x3000 && c <= 0x303f) || // 中日韩标点
    (c >= 0xac00 && c <= 0xd7af) || // 谚文
    (c >= 0xf900 && c <= 0xfaff) ||
    (c >= 0xff00 && c <= 0xffef) // 全角形式
  ) {
    return 1;
  }
  return 0.8;
}

/**
 * 一段文本占几个 em（排版的唯一度量）。**导出是为了让用例能用同一把尺子去断言
 * 「放得下」** —— 用例里另抄一份估算规则就等于把度量变成了两份真相。
 */
export function estimatedEm(s: string): number {
  return Array.from(s).reduce((n, c) => n + charEm(c), 0);
}

/**
 * 按估算字宽折行；超过 maxLines 时在最后一行截断加省略号。
 * maxEm 是「以字号为单位的可用宽度」—— 字号 24、可用 560px 就是 560/24 ≈ 23。
 */
export function wrapText(input: string, maxEm: number, maxLines = Infinity): string[] {
  const all: string[] = [];
  let cur = '';
  let curEm = 0;
  const flush = () => {
    all.push(cur);
    cur = '';
    curEm = 0;
  };
  for (const ch of Array.from(input)) {
    if (ch === '\n') {
      flush();
      continue;
    }
    const em = charEm(ch);
    if (curEm + em > maxEm && cur) flush();
    cur += ch;
    curEm += em;
  }
  flush();

  if (all.length <= maxLines) return all;

  const kept = all.slice(0, maxLines);
  let last = kept[maxLines - 1];
  while (last && estimatedEm(last) + 1 > maxEm) {
    last = Array.from(last).slice(0, -1).join('');
  }
  kept[maxLines - 1] = last + '…';
  return kept;
}

/** 单行自适应字号：放不下就缩，缩到下限还放不下就截断加省略号。 */
export function fitLine(
  text: string,
  maxWidth: number,
  baseSize: number,
  minSize = 20
): { size: number; text: string } {
  const em = estimatedEm(text) || 1;
  if (em * baseSize <= maxWidth) return { size: baseSize, text };

  const ideal = maxWidth / em;
  if (ideal >= minSize) return { size: Math.floor(ideal), text };

  const maxEm = maxWidth / minSize;
  let s = '';
  let used = 0;
  for (const ch of Array.from(text)) {
    const e = charEm(ch);
    if (used + e + 1 > maxEm) break;
    s += ch;
    used += e;
  }
  return { size: minSize, text: s + '…' };
}

// ── 图形片段 ────────────────────────────────────────────────────────────────

/** 数值格式化：SVG 里不需要 15 位小数，短一点也让产物可读。 */
function round(n: number, digits = 2): number {
  return Number(n.toFixed(digits));
}

/**
 * 站点 logo（以 (cx,cy) 为中心、边长 size）—— `public/static/img/favicon.png` 的**矢量复刻**。
 *
 * 不嵌那张 60KB 的 PNG，理由有三：矢量在任何尺寸都清晰（画报要按 2× 光栅化）、
 * SVG 体积小得多、且**不依赖 public/ 在运行时读得到**（`output: 'standalone'` 部署下
 * public/ 是要另外拷的，用 fs 去读它在生产上是个隐患）。
 *
 * 几何是量出来的：原图 200×200，四个形状的包围盒与取色见下（改 favicon 时要同步）。
 */
export function siteLogo(cx: number, cy: number, size: number): string {
  const s = size / 200;
  return (
    `<g transform="translate(${round(cx - size / 2)},${round(cy - size / 2)}) scale(${round(s, 5)})">` +
    `<circle cx="67.5" cy="72.5" r="47" fill="#63BCFC"/>` + // 大蓝圆
    `<circle cx="149" cy="48" r="22.5" fill="#FB797C"/>` + // 小红圆
    `<path d="M135 86 L168 144 L102 144 Z" fill="#FFDB6F"/>` + // 黄三角
    `<rect x="46" y="135" width="46" height="46" fill="#36CEBC"/>` + // 青方块
    `</g>`
  );
}

/** 小鱼干图标（以 (cx,cy) 为中心、边长 size）。收款码用它（那边鱼干才是主角）。 */
export function fishGlyph(cx: number, cy: number, size: number, color: string): string {
  const s = size / 21;
  return (
    `<g transform="translate(${round(cx - size / 2)},${round(cy - size / 2)}) scale(${round(s, 4)})" fill="${color}">` +
    `<g transform="${FISH_TRANSFORM}"><path d="${FISH_PATH}"/></g></g>`
  );
}

/**
 * 五角星图标（以 (cx,cy) 为中心、边长 size）。收藏夹分享画报用它。
 *
 * 路径取自 Bootstrap Icons 的 star-fill（MIT，与站内 icons/ 里那批同源，
 * 也见 public/static/img/icons/star-fill.svg）。16×16 的 viewBox 需要缩放到 size。
 */
export function starGlyph(cx: number, cy: number, size: number, color: string): string {
  const s = size / 16;
  return (
    `<g transform="translate(${round(cx - size / 2)},${round(cy - size / 2)}) scale(${round(s, 4)})" fill="${color}">` +
    `<path d="M3.612 15.443c-.386.198-.824-.149-.746-.592l.83-4.73L.173 6.765c-.329-.314-.158-.888.283-.95l4.898-.696L7.538.792c.197-.39.73-.39.927 0l2.184 4.327 4.898.696c.441.062.612.636.282.95l-3.522 3.356.83 4.73c.078.443-.36.79-.746.592L8 13.187l-4.389 2.256z"/>` +
    `</g>`
  );
}

/** 圆角矩形。 */
function rect(
  x: number,
  y: number,
  w: number,
  h: number,
  fill: string,
  rx = 0,
  extra = ''
): string {
  return `<rect x="${round(x)}" y="${round(y)}" width="${round(w)}" height="${round(h)}" rx="${round(rx)}" fill="${fill}"${extra}/>`;
}

/** 文本行（anchor 默认居中）。 */
function text(
  x: number,
  y: number,
  content: string,
  size: number,
  fill: string,
  weight = 400,
  anchor = 'middle',
  letterSpacing = 0
): string {
  const ls = letterSpacing ? ` letter-spacing="${letterSpacing}"` : '';
  return (
    `<text x="${round(x)}" y="${round(y)}" text-anchor="${anchor}" font-size="${size}" ` +
    `font-weight="${weight}" fill="${fill}"${ls}>${t(content)}</text>`
  );
}

/** 药丸徽章（居中于 cx，垂直中心 cy）。 */
function pill(
  cx: number,
  cy: number,
  label: string,
  size: number,
  bg: string,
  fg: string
): string {
  const w = estimatedEm(label) * size + size * 1.6;
  const h = size * 1.9;
  return (
    rect(cx - w / 2, cy - h / 2, w, h, bg, h / 2) +
    text(cx, cy + size * 0.36, label, size, fg, 500)
  );
}

/** 头像：8% 圆角（站点约定，不用 50%）+ 描边环 + 裁剪。 */
function avatarBlock(
  dataUri: string,
  clipId: string,
  cx: number,
  cy: number,
  size: number,
  ring: string
): string {
  const x = cx - size / 2;
  const y = cy - size / 2;
  const r = size * 0.08;
  return (
    `<clipPath id="${clipId}"><rect x="${round(x)}" y="${round(y)}" width="${size}" height="${size}" rx="${round(r)}"/></clipPath>` +
    rect(x - 3, y - 3, size + 6, size + 6, 'none', r + 3, ` stroke="${ring}" stroke-width="3"`) +
    // href 与 xlink:href 同时给：新版 librsvg 认前者，老版本只认后者
    `<image href="${dataUri}" xlink:href="${dataUri}" x="${round(x)}" y="${round(y)}" width="${size}" height="${size}" preserveAspectRatio="xMidYMid slice" clip-path="url(#${clipId})"/>`
  );
}

// ── 二维码 ──────────────────────────────────────────────────────────────────

/** 二维码的模块数（版本 × 4 + 17）。内容是错误纠正等级与字节数决定的，短内容模块更少。 */
export function qrModuleCount(content: string): number {
  const qr = qrcode(0, QR_ECC);
  qr.addData(content);
  qr.make();
  return qr.getModuleCount();
}

/**
 * 二维码卡片的几何：卡片宽固定，**单元尺寸由模块数反推并取整**（见「铁律三」）。
 * 返回的 svg 已含绝对坐标（卡片居中于画布）。
 */
export interface QrCardResult {
  svg: string;
  /** 卡片总高（调用方用它往下排页脚） */
  height: number;
  /** 卡片顶部 y */
  top: number;
  /** 二维码边长 */
  size: number;
  /** 模块尺寸（整数） */
  cell: number;
}

export function qrCard(opts: {
  top: number;
  content: string;
  dark: string;
  caption: string;
  hint: string | null;
  logo?: (cx: number, cy: number, size: number) => string;
}): QrCardResult {
  const qr = qrcode(0, QR_ECC);
  qr.addData(opts.content);
  qr.make();
  const n = qr.getModuleCount();

  // 单元取整，且卡片宽里要同时塞下 n 个模块与左右各 4.5 模块的静默区
  const cell = Math.max(3, Math.floor(CARD_WIDTH / (n + QUIET_MODULES * 2)));
  const size = cell * n;
  const quiet = Math.ceil(cell * QUIET_MODULES);
  const topPad = Math.max(46, quiet);
  const gap = Math.max(46, quiet);

  const cardX = (POSTER_WIDTH - CARD_WIDTH) / 2;
  const qrX = (POSTER_WIDTH - size) / 2;
  const qrY = opts.top + topPad;
  const captionY = qrY + size + gap + 26;
  const hintY = captionY + 36;
  const height = topPad + size + gap + 26 + (opts.hint ? 36 : 0) + 34;

  const parts: string[] = [rect(cardX, opts.top, CARD_WIDTH, height, '#FFFFFF', 30)];

  // 深色模块：同一行连续的合并成一个宽矩形，元素数少一个数量级。
  // 浅色模块不画 —— 卡片本身就是白底，那同时就是它的静默区。
  const rects: string[] = [];
  for (let r = 0; r < n; r++) {
    let c = 0;
    while (c < n) {
      if (!qr.isDark(r, c)) {
        c++;
        continue;
      }
      let run = 1;
      while (c + run < n && qr.isDark(r, c + run)) run++;
      rects.push(`<rect x="${c}" y="${r}" width="${run}" height="1"/>`);
      c += run;
    }
  }
  // 在模块坐标系里画、整体靠 scale 缩放：cell 是整数，逐模块不会累积舍入误差
  parts.push(
    `<g transform="translate(${round(qrX)},${round(qrY)}) scale(${cell})" fill="${opts.dark}">${rects.join('')}</g>`
  );

  if (opts.logo) {
    const ls = size * QR_LOGO_RATIO;
    const cx = qrX + size / 2;
    const cy = qrY + size / 2;
    const box = ls * 1.4;
    parts.push(rect(cx - box / 2, cy - box / 2, box, box, '#FFFFFF', box * 0.28));
    parts.push(opts.logo(cx, cy, ls));
  }

  parts.push(text(POSTER_WIDTH / 2, captionY, opts.caption, 26, '#0F172A', 600));

  if (opts.hint) {
    // 提示行是**长度不可控**的那一行：主页画报印的是 `raricy.com/u/<id>`，
    // 光一个 uuid 就 36 字符，19px 下算下来约 512px，而卡片只有 420px —— 直接顶出去。
    // 所以按卡片内的可用宽度自适应：先缩字号，缩到下限还放不下才截断加省略号。
    // （QR 本身才是真正承载链接的东西，这行只是给人看的，截断无所谓。）
    const hintLine = fitLine(opts.hint, CARD_WIDTH - 2 * 32, 19, 13);
    parts.push(text(POSTER_WIDTH / 2, hintY, hintLine.text, hintLine.size, '#8A7A96'));
  }

  return { svg: parts.join(''), height, top: opts.top, size, cell };
}

// ── 版式外壳 ────────────────────────────────────────────────────────────────

function defs(theme: Theme): string {
  return (
    `<defs>` +
    `<linearGradient id="bg" x1="0" y1="0" x2="0.4" y2="1">` +
    `<stop offset="0%" stop-color="${theme.bg[0]}"/>` +
    `<stop offset="55%" stop-color="${theme.bg[1]}"/>` +
    `<stop offset="100%" stop-color="${theme.bg[2]}"/>` +
    `</linearGradient>` +
    `<radialGradient id="glow" cx="0.5" cy="0.2" r="0.75">` +
    `<stop offset="0%" stop-color="${theme.glow}" stop-opacity="0.42"/>` +
    `<stop offset="100%" stop-color="${theme.glow}" stop-opacity="0"/>` +
    `</radialGradient>` +
    `</defs>`
  );
}

/**
 * 收尾：算好的高度回填进 <svg>（高度是算出来的，见文件头）。
 *
 * ⚠️ 背景**不做圆角、整幅满出血**。曾经给背景矩形加过 rx=28，结果四个角是透明的：
 * 弹窗里（浅灰底）会露出四个灰色小月牙，下载到手机上换个深色底看也是破的。
 * 图片文件本身就是方的，在方图里抠圆角只会把角抠漏 —— 要圆角是**展示端**的事
 * （`.poster-frame__img` 的 border-radius 就够），不该烧进像素里。
 * tests/unit/poster.test.ts 有一条用例盯着四角的不透明度。
 */
function finish(theme: Theme, body: string[], height: number, width = POSTER_WIDTH): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" ` +
    `width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" ` +
    `font-family="${FONT}">` +
    defs(theme) +
    // 直角、满出血 —— 见上面 finish() 的注释，别再加 rx
    rect(0, 0, width, height, 'url(#bg)') +
    rect(0, 0, width, height, 'url(#glow)') +
    body.join('') +
    '</svg>'
  );
}

/** 页脚与卡片之间的间距 */
const FOOTER_GAP = 58;
/** 页脚基线到画布底边 */
const FOOTER_BASELINE = 34;

// ── 个人主页画报 ────────────────────────────────────────────────────────────

export interface ProfilePosterData {
  username: string;
  /** 角色徽章文案（如「核心用户」）。空串 = 不画徽章。 */
  roleLabel: string;
  bio: string;
  /** 注册年份（如「2024」）。空串 = 不画。 */
  joinedYear: string;
  blogs: number;
  likes: number;
  comments: number;
  /** 二维码内容（绝对 URL）。 */
  qrText: string;
  /** data:image/png;base64,... */
  avatarDataUri: string;
}

/** 个人主页画报：头像 / 昵称 / 角色 / 简介 / 三格统计 / 二维码卡片。 */
export function buildProfilePosterSvg(data: ProfilePosterData): string {
  const c = THEMES.profile;
  const cx = POSTER_WIDTH / 2;
  const name = fitLine(data.username, 620, 46, 24);
  const body: string[] = [];

  // 品牌行 —— 用站点 logo，不用小鱼干图标：这是「聪明山的主页画报」，
  // 鱼干是货币图标，出现在主页画报上是跑错片场（收款码那张才该有鱼）。
  body.push(siteLogo(58, 66, 32));
  body.push(text(82, 74, '聪明山', 26, c.brand, 600, 'start'));
  body.push(text(POSTER_WIDTH - 56, 74, 'raricy.com', 22, c.faint, 400, 'end'));

  // 头像
  body.push(avatarBlock(data.avatarDataUri, 'av', cx, 228, 180, c.ring));

  // 昵称 + 角色徽章
  body.push(text(cx, 380, name.text, name.size, c.title, 700));
  if (data.roleLabel) body.push(pill(cx, 416, data.roleLabel, 21, c.chipBg, c.chipFg));

  // 简介（最多两行）—— 没有简介就整块留白，不写占位文案
  let cursor = 452;
  const bioLines = data.bio.trim() ? wrapText(data.bio.trim(), 22, 2) : [];
  if (bioLines.length) {
    bioLines.forEach((line, i) => {
      body.push(text(cx, cursor + 26 + i * 34, line, 24, c.muted));
    });
    cursor += 26 + (bioLines.length - 1) * 34 + 40;
  } else {
    cursor += 40;
  }

  // 三格统计
  const statsTop = cursor;
  const statsBottom = statsTop + 80;
  const cells: Array<[number, string]> = [
    [data.blogs, '文章'],
    [data.likes, '获赞'],
    [data.comments, '评论'],
  ];
  cells.forEach(([value, label], i) => {
    const x = cx + (i - 1) * 200;
    body.push(text(x, statsTop + 34, String(value), 36, c.title, 700));
    body.push(text(x, statsTop + 62, label, 20, c.muted));
  });
  for (const dx of [-100, 100]) {
    body.push(
      `<line x1="${cx + dx}" y1="${statsTop + 6}" x2="${cx + dx}" y2="${statsBottom - 6}" stroke="${c.faint}" stroke-width="1" stroke-opacity="0.5"/>`
    );
  }

  // 二维码卡片 + 页脚
  const card = qrCard({
    top: statsBottom + 40,
    content: data.qrText,
    dark: c.qrDark,
    caption: '扫码访问我的主页',
    hint: data.qrText.replace(/^https?:\/\//, ''),
    // 二维码中心也用站点 logo（四色标志压在白底圆角块上；四个颜色都不深，
    // 中心这一小块对解码器而言仍是「亮区」，不会伤到 H 级纠错）
    logo: (lx, ly, ls) => siteLogo(lx, ly, ls),
  });
  body.push(card.svg);

  const footerY = card.top + card.height + FOOTER_GAP;
  if (data.joinedYear) {
    body.push(text(cx, footerY, `注册于 ${data.joinedYear} 年`, 20, c.faint));
  }
  return finish(c, body, footerY + FOOTER_BASELINE);
}

// ── 鱼干收款码 ──────────────────────────────────────────────────────────────

export interface CollectPosterData {
  username: string;
  qrText: string;
  avatarDataUri: string;
}

/** 鱼干收款码：鱼干标识 / 头像 / 昵称 / 二维码卡片。 */
export function buildCollectPosterSvg(data: CollectPosterData): string {
  const c = THEMES.collect;
  const cx = POSTER_WIDTH / 2;
  const name = fitLine(data.username, 620, 46, 24);
  const body: string[] = [];

  // 标题区：图标在上、标题在下 —— 对称摆放，不必估算标题宽度
  body.push(fishGlyph(cx, 110, 48, c.accent));
  body.push(text(cx, 190, '小鱼干收款码', 38, c.brand, 700, 'middle', 2));
  body.push(text(cx, 232, '扫一扫，给我投喂小鱼干', 22, c.muted));

  // 头像 + 收款方身份
  body.push(avatarBlock(data.avatarDataUri, 'av', cx, 372, 176, c.ring));
  body.push(text(cx, 528, name.text, name.size, c.title, 700));
  body.push(text(cx, 570, '收款方', 22, c.muted, 400, 'middle', 4));

  // 二维码卡片 + 页脚
  const card = qrCard({
    top: 616,
    content: data.qrText,
    dark: c.qrDark,
    caption: '扫码即可付款',
    hint: '在聪明山输入金额与密码',
    logo: (lx, ly, ls) => fishGlyph(lx, ly, ls, c.logo),
  });
  body.push(card.svg);

  const footerY = card.top + card.height + FOOTER_GAP;
  body.push(text(cx, footerY, '聪明山 · raricy.com', 20, c.faint));
  return finish(c, body, footerY + FOOTER_BASELINE);
}

// ── 收藏夹分享二维码 ────────────────────────────────────────────────────────

export interface FavoritePosterData {
  /** 收藏夹标题（用户输入，渲染前已过 escapeXml / stripControlChars）。 */
  title: string;
  /** 6 位对外 ID —— 只有**公开**收藏夹才有；私密收藏夹根本到不了这里。 */
  publicId: string;
  /** 条目数（画报上显示「共 N 篇」）。 */
  count: number;
  /** 二维码内容（公开收藏夹的绝对地址）。 */
  qrText: string;
}

/**
 * 收藏夹分享二维码。
 *
 * 沿用收款码那套**奶油金 + 深棕字**的浅底主题（THEMES.collect）—— 黄色五角星本来就
 * 是奶油金的同色系，另起一套只会多一份要维护的配色。
 *
 * 画报上会印出 6 位 ID：它本来就是公开句柄（页面、二维码、bot 接口都用它），
 * 印出来方便对方手打 `[@ID]` 把收藏夹嵌进文章。
 * ⚠️ 私密收藏夹没有 ID 也不该有二维码 —— 那条约束在路由层（只按 publicId 查、且
 *    必须过 PUBLIC_FAVORITE_WHERE），这里不做判定，别把它当第二道防线。
 */
export function buildFavoritePosterSvg(data: FavoritePosterData): string {
  const c = THEMES.collect;
  const cx = POSTER_WIDTH / 2;
  const title = fitLine(data.title, 620, 40, 22);
  const body: string[] = [];

  // 标题区：星标在上、标题在下（与收款码同构，对称摆放，不必估算标题宽度）
  body.push(starGlyph(cx, 108, 76, c.accent));
  body.push(text(cx, 188, '收藏夹分享', 38, c.brand, 700, 'middle', 2));

  body.push(text(cx, 268, title.text, title.size, c.title, 700));
  body.push(text(cx, 312, `共 ${data.count} 篇`, 22, c.muted));

  // 6 位 ID 单独一颗 chip —— 它是「手打 [@ID]」的凭据，所以给等宽感（加字距）
  body.push(pill(cx, 366, `[@${data.publicId}]`, 24, c.chipBg, c.chipFg));

  // 二维码卡片 + 页脚
  const card = qrCard({
    top: 420,
    content: data.qrText,
    dark: c.qrDark,
    caption: '扫码即可打开收藏夹',
    hint: '在聪明山查看全部条目',
    logo: (lx, ly, ls) => starGlyph(lx, ly, ls, c.logo),
  });
  body.push(card.svg);

  const footerY = card.top + card.height + FOOTER_GAP;
  body.push(text(cx, footerY, '聪明山 · raricy.com', 20, c.faint));
  return finish(c, body, footerY + FOOTER_BASELINE);
}

// ── 分享卡片（OG 图）────────────────────────────────────────────────────────
//
// 【和上面三张画报不是一回事】那三张是「用户主动生成、保存、转发」的**物料**；
// 这张是**渲染在链接旁边**的社交卡片（微信 / QQ / Twitter 的 unfurl），尺寸由平台定死。
//
// 【为什么不用 next/og 的 ImageResponse/Satori】字体。Satori **不读系统字体栈**，
// 中文必须自带一份字体二进制（Noto Sans SC 一个字重全量约 10MB，还要按需子集化 →
// 一个新构建步骤 + 一份新资产）。那等于凭空造出**第二条字体管线**，而本站的字体约束
// 已经写在 docs/deploy.md 与 `npm run diagnose` 的探针里、poster.ts 的 FONT 就是那条栈。
// 走 sharp = 一条字体管线、一份部署要求、一个探针；Satori 的失败样子（豆腐块）不在
// 探针覆盖范围内。顺带还白拿一条：本文件唯一的文本出口是 text/pill → t() →
// escapeXml(stripControlChars)，**铁律四由结构保证**，想忘也忘不掉。
//
// 【铁律一/二/三为什么不适用】本版式**不含二维码**，所以「矢量二维码 / 纠错 H /
// 静默区 ≥4 模块」那三条都不必照搬。放二维码在这里也是冗余的 —— 卡片就渲染在链接
// 旁边，扫码这个动作没有意义，而它会引入「图好看但扫不出来」的故障面。
// 将来若真要加（例如截图转发场景），必须复用 qrCard() 并纳入真解码断言，别手搓。

/** OG 卡片逻辑宽度（1.91:1，各平台通用比例）。 */
export const OG_WIDTH = 1200;
/** OG 卡片逻辑高度。 */
export const OG_HEIGHT = 630;

/** 左右内边距。 */
const OG_PAD = 64;

/**
 * 版面栅格。**所有纵向坐标都在这里，别在函数体里散着写。**
 *
 * ⚠️ 改动这些数字之前先跑 `tests/unit/og-card.test.ts` —— 那里按**最坏情况**
 * （2 行标题 + 2 行摘要）断言最后一条基线不会压到页脚分隔线上，而这条断言是有来历的：
 * 初版把标题基线硬写成 392、行高 78，2 行标题 + 2 行摘要时摘要正好落在页脚线的位置上，
 * 渲染出来是三行字叠在一起（样张肉眼可见，但「是张合法 PNG」的断言全绿）。
 */
export const OG_LAYOUT = {
  /** 品牌行（logo + 站名 + 域名）的文字基线 / logo 中心。 */
  brandBaseline: 80,
  brandLogoCy: 72,
  brandLogoSize: 36,
  /** 作者行：头像中心与边长。 */
  avatarCy: 170,
  avatarSize: 80,
  /** 标题：行高 / 字号。首行基线由 ogTextLayout() 算，不写死。 */
  titleLineHeight: 70,
  titleSize: 56,
  /** 标题**最后一条**基线 → 摘要首行基线 的间距。 */
  titleToDesc: 62,
  /** 摘要：行高 / 字号。 */
  descLineHeight: 40,
  descSize: 26,
  /** 页脚分隔线与页脚文字的基线。**固定** —— 内容多少都不改变它们。 */
  footerRule: 538,
  footerBaseline: 578,
  /** 标题块的上下留白带：从作者行下方到页脚分隔线上方。 */
  bandTop: 240,
  bandBottom: 514,
  /**
   * 字形下沿余量（基线往下这么多算「实际占到了这里」）。CJK 字体通常 ~0.12em，
   * 这里给 0.22em 的余量：宁可留白，也不要在不同中文字体下偶尔压线。
   */
  descender: 0.22,
  /** 字形上沿比例（基线往上这么多算字顶）—— 只用于把整块居中，不是精确度量。 */
  ascender: 0.8,
} as const;

/** 标题 / 摘要各自最多画几行。 */
export const OG_TITLE_MAX_LINES = 2;
export const OG_DESC_MAX_LINES = 2;

/**
 * 按**实际行数**算纵向排版。
 *
 * 把「标题 + 摘要」整块在 `bandTop`..`bandBottom` 之间**垂直居中**，而不是给标题写死
 * 一条基线。写死那版的毛病在两端都难看：短标题（一行）在中下部留一大块死白，
 * 长标题（两行 + 两行摘要）又把摘要顶到页脚线上。实测过 —— 初版就是后者，
 * 摘要与页脚分隔线叠在一起（样张肉眼可见，而「是张合法 PNG」的断言全绿）。
 *
 * 抽成函数是为了让单测能用**同一个算式**断言最坏情况不越界，而不是把几何抄第二遍。
 */
export function ogTextLayout(
  titleLines: number,
  descLines: number
): { titleBaseline: number; descBaseline: number } {
  const L = OG_LAYOUT;
  const span =
    (titleLines - 1) * L.titleLineHeight +
    (descLines > 0 ? L.titleToDesc + (descLines - 1) * L.descLineHeight : 0);
  const visualTop = L.titleSize * L.ascender;
  const visualBottom = (descLines > 0 ? L.descSize : L.titleSize) * L.descender;
  const blockH = visualTop + span + visualBottom;
  const titleBaseline = L.bandTop + (L.bandBottom - L.bandTop - blockH) / 2 + visualTop;
  return {
    titleBaseline,
    descBaseline: titleBaseline + (titleLines - 1) * L.titleLineHeight + L.titleToDesc,
  };
}

export interface BlogOgData {
  /** 文章标题（用户输入，经 escapeXml / stripControlChars）。 */
  title: string;
  /** 摘要。空串 = 不画那两行。 */
  description: string;
  /** 作者名。空串 = 不画。 */
  author: string;
  /** 日期（已格式化，如 '2026-09-19'）。空串 = 不画。 */
  date: string;
  /** data:image/png;base64,... 头像。空串 = 画一个占位方块。 */
  avatarDataUri: string;
}

/**
 * 文章分享卡片：品牌行 / 作者行 / 标题 / 摘要 / 页脚。
 *
 * **刻意不画任何计数**（点赞、投喂、评论）—— 对外视图本就不给站外读者看这些数字，
 * 卡片是它的一部分，凭什么从卡片漏出去。**刻意不放二维码**，理由见上面那段。
 */
export function buildBlogOgSvg(data: BlogOgData): string {
  const c = THEMES.profile;
  const L = OG_LAYOUT;
  const body: string[] = [];
  const left = OG_PAD;

  // 品牌行：站点 logo + 站名 + 域名（与主页画报同一行的构成）
  body.push(siteLogo(left + 18, L.brandLogoCy, L.brandLogoSize));
  body.push(text(left + 48, L.brandBaseline, '聪明山', 30, c.brand, 600, 'start'));
  body.push(text(OG_WIDTH - OG_PAD, L.brandBaseline, 'raricy.com', 24, c.faint, 400, 'end'));

  // 作者行：头像 + 作者名 + 日期 +「文章」胶囊
  if (data.avatarDataUri) {
    body.push(
      avatarBlock(data.avatarDataUri, 'og-av', left + L.avatarSize / 2, L.avatarCy, L.avatarSize, c.ring)
    );
  } else {
    // 没头像时画一个同尺寸的圆角占位，**不留空洞** —— 版面高度是按它算的
    body.push(
      rect(left, L.avatarCy - L.avatarSize / 2, L.avatarSize, L.avatarSize, c.chipBg, L.avatarSize * 0.08)
    );
  }
  const metaX = left + L.avatarSize + 22;
  if (data.author) body.push(text(metaX, L.avatarCy - 4, data.author, 30, c.title, 600, 'start'));
  if (data.date) body.push(text(metaX, L.avatarCy + 32, data.date, 22, c.muted, 400, 'start'));
  body.push(pill(OG_WIDTH - OG_PAD - 52, L.avatarCy, '文章', 22, c.chipBg, c.chipFg));

  // 标题 / 摘要：先各自折行，再**按实际行数**算纵向位置（整块居中）。
  // `wrapText` 的 maxEm 与 text() 用的是**同一把尺子**（estimatedEm）。
  // 标题上限 BLOG_TITLE_MAX = 30（CJK 30em），两行各 17.8em 装得下。
  const titleLines = wrapText(data.title, 17.8, OG_TITLE_MAX_LINES);
  const descLines = data.description.trim()
    ? wrapText(data.description.trim(), 38, OG_DESC_MAX_LINES)
    : [];
  const pos = ogTextLayout(titleLines.length, descLines.length);

  titleLines.forEach((line, i) => {
    body.push(
      text(left, pos.titleBaseline + i * L.titleLineHeight, line, L.titleSize, c.title, 700, 'start')
    );
  });
  descLines.forEach((line, i) => {
    body.push(
      text(left, pos.descBaseline + i * L.descLineHeight, line, L.descSize, c.muted, 400, 'start')
    );
  });

  // 页脚细线 + 站名。位置**固定** —— 标题行数与摘要有无都不改变它，
  // 所以不管内容多少，卡片底部那条线永远在同一个位置。
  body.push(
    `<line x1="${left}" y1="${L.footerRule}" x2="${OG_WIDTH - OG_PAD}" y2="${L.footerRule}" ` +
      `stroke="${c.faint}" stroke-width="1" stroke-opacity="0.4"/>`
  );
  body.push(text(left, L.footerBaseline, '聪明山 · raricy.com', 24, c.faint, 400, 'start'));

  return finish(c, body, OG_HEIGHT, OG_WIDTH);
}
