// ─────────────────────────────────────────────────────────────────────────────
// barcode.ts — 一维条形码（EAN-13 / Code 128 / Code 39）的纯逻辑
//
// 零 React / 零 DOM：node 可直接 import，页面只负责把 modules 画成 SVG 矩形。
//
// 【统一的中间形态】三种码最终都归一成 `BarcodeSymbol`：
//   · `modules: boolean[]` —— 逐模块的明暗（true = 黑条）；
//   · `text` —— 人眼可读内容（EAN-13 是 13 位、含校验位；其余是原文）；
//   · `note` —— 编码过程中的补充说明（自动补校验位 / 子集切换 / 无校验位）。
// 预览 JSX 与下载 SVG 都从同一个 `barcodeBars()` 取矩形，**不各写一套**：
// 两套渲染最大的风险是预览能看、下载的图却错一位，而那种错不报错。
//
// 【三种码的纪律】
//   · EAN-13：12 位自动补校验位；13 位时**校验位必须正确**（错了直接报错，
//     不「顺手改成正确值」—— 用户手里的条码可能本来就是另一个商品的）；
//   · Code 128：只收 ASCII 32–126（中文/控制字符会被无声丢掉，必须拒绝）；
//     B/C 子集自动切换（长数字串用 C 压缩，其余用 B），校验位 mod 103；
//   · Code 39：只收大写字母 / 数字 / `- . 空格 $ / + %`；不加校验位（规范里它是
//     可选的，加了反而会让通用扫码器读出不带校验位的原文）；每字符 9 元素、
//     3 个宽元素，宽窄比 3:1。
//
// 【静区】规范要求 ≥ 10 个模块（Code 128 / Code 39）或 ≥ 9（EAN-13 左）+7（右）。
// 统一取 10 个模块，两侧都留 —— 见 `BARCODE_QUIET_MODULES`。
// ─────────────────────────────────────────────────────────────────────────────

export type BarcodeFormat = 'ean13' | 'code128' | 'code39';

export interface BarcodeFormatDef {
  id: BarcodeFormat;
  label: string;
  /** 输入限制的一句话说明。 */
  hint: string;
  /** 示例按钮预填内容。 */
  example: string;
  /** 是否带校验位（展示用）。 */
  checkDigit: string;
}

export const BARCODE_FORMATS: readonly BarcodeFormatDef[] = [
  {
    id: 'ean13',
    label: 'EAN-13',
    hint: '12 位或 13 位数字；12 位会自动补校验位，13 位会校验最后一位。',
    example: '5901234123457',
    checkDigit: '第 13 位校验位（mod 10）',
  },
  {
    id: 'code128',
    label: 'Code 128',
    hint: 'ASCII 32–126 的可打印字符（不能有中文）；长数字串自动用 C 子集压缩。',
    example: 'Hello-128',
    checkDigit: 'mod 103 校验位（自动计算）',
  },
  {
    id: 'code39',
    label: 'Code 39',
    hint: '只支持大写字母、数字与 - . 空格 $ / + %，不支持小写字母与中文。',
    example: 'CODE-39',
    checkDigit: '无（本工具不附加可选校验位）',
  },
];

/** 静区宽度（模块）：Code 128 / 39 规范要求 ≥ 10，EAN-13 取同一值更宽松。 */
export const BARCODE_QUIET_MODULES = 10;

export function findBarcodeFormat(format: BarcodeFormat): BarcodeFormatDef {
  const found = BARCODE_FORMATS.find((f) => f.id === format);
  if (!found) throw new Error(`不支持的条形码格式：${format}`);
  return found;
}

export interface BarcodeSymbol {
  format: BarcodeFormat;
  /** 格式标签（EAN-13 / Code 128 / Code 39）。 */
  label: string;
  /** 人眼可读内容。 */
  text: string;
  /** 逐模块明暗，true = 黑条。长度就是有效编码宽度（不含静区）。 */
  modules: boolean[];
  /** 编码说明，例如「已自动补校验位 7」「使用 B/C 子集自动切换」。 */
  note: string;
}

// ── EAN-13 ──────────────────────────────────────────────────────────────────

/** 左侧奇校验（L）编码，0–9。 */
const EAN_L = [
  '0001101',
  '0011001',
  '0010011',
  '0111101',
  '0100011',
  '0110001',
  '0101111',
  '0111011',
  '0110111',
  '0001011',
] as const;

/** 左侧偶校验（G）编码，0–9。 */
const EAN_G = [
  '0100111',
  '0110011',
  '0011011',
  '0100001',
  '0011101',
  '0111001',
  '0000101',
  '0010001',
  '0001001',
  '0010111',
] as const;

/** 右侧（R）编码，0–9。 */
const EAN_R = [
  '1110010',
  '1100110',
  '1101100',
  '1000010',
  '1011100',
  '1001110',
  '1010000',
  '1000100',
  '1001000',
  '1110100',
] as const;

/** 首位数字决定左侧 6 位的 L/G 奇偶组合。 */
const EAN_PARITY = [
  'LLLLLL',
  'LLGLGG',
  'LLGGLG',
  'LLGGGL',
  'LGLLGG',
  'LGGLLG',
  'LGGGLL',
  'LGLGLG',
  'LGLGGL',
  'LGGLGL',
] as const;

/**
 * 由前 12 位算 EAN-13 校验位。
 * 权重：从最左位起 1、3 交替（等价于从右往左 3、1 交替）。
 */
export function ean13CheckDigit(digits12: string): number {
  if (!/^\d{12}$/.test(digits12)) throw new Error('EAN-13 校验位需要恰好 12 位数字');
  let sum = 0;
  for (let i = 0; i < 12; i += 1) {
    const digit = digits12.charCodeAt(i) - 48;
    sum += i % 2 === 0 ? digit : digit * 3;
  }
  return (10 - (sum % 10)) % 10;
}

/**
 * 规范化 EAN-13 输入。
 * 12 位 → 补校验位并返回 note；13 位 → 校验最后一位，不符直接抛错。
 */
export function normalizeEan13(raw: string): { digits: string; note: string } {
  const trimmed = raw.trim().replace(/\s+/g, '');
  if (!/^\d{12,13}$/.test(trimmed)) {
    throw new Error('EAN-13 需要 12 位或 13 位数字（不能有字母、空格或符号）');
  }
  const digits12 = trimmed.slice(0, 12);
  const check = ean13CheckDigit(digits12);
  if (trimmed.length === 13) {
    const given = trimmed.charCodeAt(12) - 48;
    if (given !== check) {
      throw new Error(`EAN-13 校验位不正确：最后一位应为 ${check}，当前是 ${given}`);
    }
    return { digits: trimmed, note: '校验位正确' };
  }
  return { digits: digits12 + String(check), note: `已自动补校验位 ${check}` };
}

function ean13Modules(digits13: string): boolean[] {
  const parity = EAN_PARITY[digits13.charCodeAt(0) - 48];
  const modules: boolean[] = [];
  const push = (pattern: string) => {
    for (const bit of pattern) modules.push(bit === '1');
  };
  push('101');
  for (let i = 0; i < 6; i += 1) {
    const digit = digits13.charCodeAt(i + 1) - 48;
    push(parity[i] === 'L' ? EAN_L[digit] : EAN_G[digit]);
  }
  push('01010');
  for (let i = 0; i < 6; i += 1) {
    push(EAN_R[digits13.charCodeAt(i + 7) - 48]);
  }
  push('101');
  return modules;
}

// ── Code 128 ────────────────────────────────────────────────────────────────

/**
 * Code 128 的 107 个符号宽度表（ISO/IEC 15417）。
 * 每项是「条 / 空」交替的 6 个宽度（0–105），Stop（106）是 7 个宽度、共 13 模块。
 * 表已与公有标准逐行对过：合计模块数非 11 的项只有 Stop。
 */
const CODE128_WIDTHS: readonly string[] = [
  '212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312', '132212', '221213',
  '221312', '231212', '112232', '122132', '122231', '113222', '123122', '123221', '223211', '221132',
  '221231', '213212', '223112', '312131', '311222', '321122', '321221', '312212', '322112', '322211',
  '212123', '212321', '232121', '111323', '131123', '131321', '112313', '132113', '132311', '211313',
  '231113', '231311', '112133', '112331', '132131', '113123', '113321', '133121', '313121', '211331',
  '231131', '213113', '213311', '213131', '311123', '311321', '331121', '312113', '312311', '332111',
  '314111', '221411', '431111', '111224', '111422', '121124', '121421', '141122', '141221', '112214',
  '112412', '122114', '122411', '142112', '142211', '241211', '221114', '413111', '241112', '134111',
  '111242', '121142', '121241', '114212', '124112', '124211', '411212', '421112', '421211', '212141',
  '214121', '412121', '111143', '111341', '131141', '114113', '114311', '411113', '411311', '113141',
  '114131', '311141', '411131', '211412', '211214', '211232', '2331112',
];

const CODE128_START_B = 104;
const CODE128_START_C = 105;
const CODE128_STOP = 106;
const CODE128_CODE_B = 100;
const CODE128_CODE_C = 99;

function widthsToModules(pattern: string): boolean[] {
  const modules: boolean[] = [];
  let dark = true;
  for (const ch of pattern) {
    const width = ch.charCodeAt(0) - 48;
    for (let i = 0; i < width; i += 1) modules.push(dark);
    dark = !dark;
  }
  return modules;
}

/** i 起连续数字的个数。 */
function digitRunLength(data: string, i: number): number {
  let n = 0;
  while (i + n < data.length && data.charCodeAt(i + n) >= 48 && data.charCodeAt(i + n) <= 57) {
    n += 1;
  }
  return n;
}

/**
 * 把文本编码成 Code 128 的符号值序列（含起止符与校验位）。
 *
 * B/C 切换规则（与 GS1 规范的建议一致）：
 *   · 整串都是数字且长度 ≥ 2 → 直接从 C 起（奇数个数字时最后一位落回 B）；
 *   · 数据开头或结尾的数字串 ≥ 4 位、中间的数字串 ≥ 6 位才切 C
 *     （短数字串切 C 反而多一个切换符号，更长的条码）。
 */
function code128Values(data: string): { values: number[]; note: string } {
  const allDigits = /^\d{2,}$/.test(data);
  const values: number[] = [];
  let mode: 'B' | 'C' = allDigits ? 'C' : 'B';
  const startedInC = mode === 'C';
  values.push(mode === 'C' ? CODE128_START_C : CODE128_START_B);

  let i = 0;
  let usedC = startedInC;
  while (i < data.length) {
    if (mode === 'C') {
      const pair = data.slice(i, i + 2);
      if (pair.length === 2 && /^\d{2}$/.test(pair)) {
        values.push(Number(pair));
        i += 2;
        continue;
      }
      // 只剩一个数字（或后面不再是数字）：切回 B
      values.push(CODE128_CODE_B);
      mode = 'B';
      continue;
    }

    const run = digitRunLength(data, i);
    const atBoundary = i === 0 || i + run === data.length;
    const worthSwitching = atBoundary ? run >= 4 : run >= 6;
    if (worthSwitching) {
      // 奇数位数字：先在 B 里写一位，剩下的偶数位交给 C（否则 C 落单一位还要再切回来）
      if (run % 2 === 1) {
        values.push(data.charCodeAt(i) - 32);
        i += 1;
      }
      values.push(CODE128_CODE_C);
      mode = 'C';
      usedC = true;
      continue;
    }

    values.push(data.charCodeAt(i) - 32);
    i += 1;
  }

  const checksum =
    values.reduce((sum, value, index) => sum + value * (index === 0 ? 1 : index), 0) % 103;
  values.push(checksum);
  values.push(CODE128_STOP);

  let note = '使用 B 子集（没有值得切换成长数字串的片段）';
  if (startedInC) {
    note = '整串为数字，使用 C 子集两位压缩（奇数位时末位用 B）';
  } else if (usedC) {
    note = '使用 B/C 子集自动切换（长数字串用 C 压缩）';
  }
  return { values, note };
}

// ── Code 39 ─────────────────────────────────────────────────────────────────

/**
 * Code 39 的 9 元素图案（'1' = 宽，'0' = 窄；从条开始条空交替）。
 * 已按「两宽条 + 一宽空」的规则逐字符核对过（含 $ / + % 四个三宽空字符）。
 */
const CODE39_PATTERNS: Readonly<Record<string, string>> = {
  '0': '000110100',
  '1': '100100001',
  '2': '001100001',
  '3': '101100000',
  '4': '000110001',
  '5': '100110000',
  '6': '001110000',
  '7': '000100101',
  '8': '100100100',
  '9': '001100100',
  A: '100001001',
  B: '001001001',
  C: '101001000',
  D: '000011001',
  E: '100011000',
  F: '001011000',
  G: '000001101',
  H: '100001100',
  I: '001001100',
  J: '000011100',
  K: '100000011',
  L: '001000011',
  M: '101000010',
  N: '000010011',
  O: '100010010',
  P: '001010010',
  Q: '000000111',
  R: '100000110',
  S: '001000110',
  T: '000010110',
  U: '110000001',
  V: '011000001',
  W: '111000000',
  X: '010010001',
  Y: '110010000',
  Z: '011010000',
  '-': '010000101',
  '.': '110000100',
  ' ': '011000100',
  $: '010101000',
  '/': '010100010',
  '+': '010001010',
  '%': '000101010',
  '*': '010010100',
};

/** 合法的数据字符（不含起止符 `*`）。 */
export const CODE39_CHARSET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ-. $/+%';

/** Code 39 的宽窄比：宽元素 3 个模块，窄元素 1 个模块。 */
const CODE39_WIDE = 3;

function code39Modules(data: string): boolean[] {
  const sequence = `*${data}*`;
  const modules: boolean[] = [];
  for (let index = 0; index < sequence.length; index += 1) {
    if (index > 0) modules.push(false); // 字符之间固定 1 个窄空的间隔
    const pattern = CODE39_PATTERNS[sequence[index]];
    if (!pattern) throw new Error(`Code 39 不支持字符：${sequence[index]}`);
    let dark = true;
    for (const element of pattern) {
      const width = element === '1' ? CODE39_WIDE : 1;
      for (let i = 0; i < width; i += 1) modules.push(dark);
      dark = !dark;
    }
  }
  return modules;
}

// ── 统一入口 ────────────────────────────────────────────────────────────────

/**
 * 生成条形码符号。输入非法时抛中文错误（页面直接展示 message）。
 */
export function encodeBarcode(format: BarcodeFormat, raw: string): BarcodeSymbol {
  const def = findBarcodeFormat(format);
  const data = raw ?? '';

  if (format === 'ean13') {
    const { digits, note } = normalizeEan13(data);
    return {
      format,
      label: def.label,
      text: digits,
      modules: ean13Modules(digits),
      note,
    };
  }

  if (data.length === 0) throw new Error('请输入要生成条形码的内容');

  if (format === 'code128') {
    for (const ch of data) {
      const code = ch.charCodeAt(0);
      if (code < 32 || code > 126) {
        throw new Error('Code 128 只支持 ASCII 32–126 的可打印字符（不支持中文或控制字符）');
      }
    }
    const { values, note } = code128Values(data);
    const modules: boolean[] = [];
    for (const value of values) {
      const pattern = CODE128_WIDTHS[value];
      if (!pattern) throw new Error(`Code 128 编码表缺少符号 ${value}`);
      for (const module of widthsToModules(pattern)) modules.push(module);
    }
    return { format, label: def.label, text: data, modules, note };
  }

  // Code 39
  if (!/^[0-9A-Z\-. $/+%]+$/.test(data)) {
    throw new Error('Code 39 只支持大写字母、数字与 - . 空格 $ / + %（不支持小写字母或中文）');
  }
  return {
    format,
    label: def.label,
    text: data,
    modules: code39Modules(data),
    note: 'Code 39，无校验位（规范中校验位可选，通用扫码器默认不读）',
  };
}

// ── 渲染 ────────────────────────────────────────────────────────────────────

export interface BarcodeRect {
  /** 起始位置（模块）。 */
  x: number;
  /** 宽度（模块）。 */
  width: number;
}

export interface BarcodeBars {
  /** 合并后的黑条矩形（模块坐标，已含静区偏移）。 */
  bars: BarcodeRect[];
  /** 含两侧静区的总宽度（模块）。 */
  totalWidth: number;
}

/**
 * 把 modules 合并成黑条矩形。预览（JSX）与下载（SVG 字符串）共用这一份，
 * 保证两者画的完全是同一个图。
 */
export function barcodeBars(
  symbol: BarcodeSymbol,
  quietModules: number = BARCODE_QUIET_MODULES
): BarcodeBars {
  const quiet = Math.max(0, Math.round(quietModules));
  const bars: BarcodeRect[] = [];
  let x = quiet;
  let i = 0;
  while (i < symbol.modules.length) {
    if (!symbol.modules[i]) {
      x += 1;
      i += 1;
      continue;
    }
    let width = 0;
    while (i < symbol.modules.length && symbol.modules[i]) {
      width += 1;
      i += 1;
    }
    bars.push({ x, width });
    x += width;
  }
  return { bars, totalWidth: symbol.modules.length + quiet * 2 };
}

export interface BarcodeSvgOptions {
  /** 每个模块的像素宽，默认 2。 */
  moduleWidth?: number;
  /** 条高（px），默认 90。 */
  barHeight?: number;
  /** 人眼可读文本区高度（px），默认 24。 */
  textHeight?: number;
  /** 静区宽度（模块），默认 10。 */
  quietModules?: number;
  /** 是否在条下方画文本，默认 true。 */
  showText?: boolean;
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * 生成可下载的 SVG 源码（白底、黑条、静区、可读文本）。
 * 用的是绝对像素尺寸 —— 直接当文件打开 / 贴进文档都不变形。
 */
export function barcodeSvg(symbol: BarcodeSymbol, options: BarcodeSvgOptions = {}): string {
  const moduleWidth = Math.max(1, Math.round(options.moduleWidth ?? 2));
  const barHeight = Math.max(20, Math.round(options.barHeight ?? 90));
  const showText = options.showText ?? true;
  const textHeight = showText ? Math.max(0, Math.round(options.textHeight ?? 24)) : 0;
  const { bars, totalWidth } = barcodeBars(symbol, options.quietModules);

  const width = totalWidth * moduleWidth;
  const height = barHeight + textHeight;
  const rects = bars
    .map(
      (bar) =>
        `<rect x="${bar.x * moduleWidth}" y="0" width="${bar.width * moduleWidth}" height="${barHeight}" fill="#000"/>`
    )
    .join('');
  const text = showText
    ? `<text x="${width / 2}" y="${barHeight + Math.round(textHeight * 0.7)}" text-anchor="middle" font-family="monospace" font-size="14" fill="#000">${escapeXml(symbol.text)}</text>`
    : '';
  const label = `${symbol.label} ${symbol.text}`;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeXml(label)}">` +
    `<rect width="100%" height="100%" fill="#fff"/>` +
    rects +
    text +
    '</svg>'
  );
}
