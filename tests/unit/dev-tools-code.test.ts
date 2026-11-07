// ─────────────────────────────────────────────────────────────────────────────
// dev-tools-code.test.ts —— 代码与文本家族（regex 之外的纯逻辑）单测
//
// 覆盖：text / color / http-status / mime / user-agent / sql-format / code-format。
// 这些模块都是零依赖纯函数，页面与这里读同一份实现 —— 单测钉的是「口径」：
// 统计的行数怎么数、颜色的对比度按什么公式、MIME 的新旧写法是否都在、UA 的
// 识别顺序会不会把 Edge 认成 Chrome。格式化器只断言**结构与不变式**（缩进层级、
// 字符串/注释原文不变），不钉每一处空格 —— 那是排版偏好，不是正确性。
// ─────────────────────────────────────────────────────────────────────────────

import { describe, expect, it } from 'vitest';

import {
  addLineNumbers,
  analyzeText,
  applyLineOp,
  capitalizeWords,
  stripLineNumbers,
  transformText,
} from '@/lib/dev-tools/text';
import {
  colorFormats,
  contrastAgainst,
  contrastRatio,
  formatContrast,
  hslToRgba,
  parseColor,
  readableTextOn,
  relativeLuminance,
  rgbaToCss,
  rgbaToHex,
  rgbaToHsl,
  wcagLevels,
} from '@/lib/dev-tools/color';
import {
  findHttpStatus,
  httpStatusCategory,
  httpStatusCounts,
  HTTP_STATUSES,
  searchHttpStatuses,
} from '@/lib/dev-tools/http-status';
import {
  mimeByExtension,
  mimeByType,
  MIME_CATEGORIES,
  MIME_TYPES,
  mimeCategoryCounts,
  searchMimeTypes,
} from '@/lib/dev-tools/mime';
import { parseUserAgent, UA_DEVICE_LABELS, userAgentRows } from '@/lib/dev-tools/user-agent';
import { formatSql, isSqlKeyword } from '@/lib/dev-tools/sql-format';
import { CODE_LANGUAGES, formatCode, formatCss, formatJavaScript, formatMarkup } from '@/lib/dev-tools/code-format';

// ═════════════════════════════════════════════════════════════════════════════
// text
// ═════════════════════════════════════════════════════════════════════════════

describe('文本工具：统计与转换', () => {
  it('统计字符、行、非空行与段落', () => {
    const stats = analyzeText('第一行\n\n第三行\n   \n第五行');
    expect(stats.chars).toBe(Array.from('第一行\n\n第三行\n   \n第五行').length);
    expect(stats.lines).toBe(5);
    expect(stats.nonEmptyLines).toBe(3);
    expect(stats.paragraphs).toBe(3);
    expect(stats.charsNoWhitespace).toBe(9);
  });

  it('空输入各项为 0；末尾换行算一行空行（与编辑器行号一致）', () => {
    expect(analyzeText('')).toEqual({
      chars: 0,
      charsNoWhitespace: 0,
      lines: 0,
      nonEmptyLines: 0,
      paragraphs: 0,
    });
    expect(analyzeText('a\n').lines).toBe(2);
    expect(analyzeText('a\n').nonEmptyLines).toBe(1);
  });

  it('字符数按 Unicode 码点（emoji 不算 2 个）', () => {
    expect(analyzeText('😀').chars).toBe(1);
    expect(analyzeText('a😀b').chars).toBe(3);
  });

  it('NBSP 等 Unicode 空白空行：非空行数与段落数口径一致（R3-501）', () => {
    const stats = analyzeText('第一行\n\u00a0\n第三行');
    expect(stats.lines).toBe(3);
    expect(stats.nonEmptyLines).toBe(2);
    expect(stats.paragraphs, 'NBSP 空行应算段落分隔，而不是让两数自相矛盾').toBe(2);
  });

  it('大小写与首字母大写只动该动的字符', () => {
    expect(transformText('Hello World', 'upper')).toBe('HELLO WORLD');
    expect(transformText('Hello World', 'lower')).toBe('hello world');
    expect(capitalizeWords('hello world: state-of-the-art, it’s ok')).toBe(
      'Hello World: State-Of-The-Art, It’s Ok'
    );
    // 中文没有「首字母」概念，原样保留
    expect(capitalizeWords('你好 world')).toBe('你好 World');
    expect(transformText('a\nb\nc', 'reverse-lines')).toBe('c\nb\na');
  });

  it('行操作：排序 / 去重 / 去空行 / 去首尾空白 / 行号可逆', () => {
    expect(applyLineOp('b\nc\na', 'sort-asc')).toBe('a\nb\nc');
    expect(applyLineOp('a\nc\nb', 'sort-desc')).toBe('c\nb\na');
    expect(applyLineOp('b\na\nb\na', 'dedupe')).toBe('b\na');
    expect(applyLineOp('a\n\n  \nb', 'drop-empty')).toBe('a\nb');
    expect(applyLineOp('  a  \n\tb\t', 'trim')).toBe('a\nb');
    const numbered = addLineNumbers('a\n\nb');
    expect(numbered).toBe('1. a\n2. \n3. b');
    expect(stripLineNumbers(numbered)).toBe('a\n\nb');
  });

  it('CRLF 输入保留 CRLF（不悄悄改成 LF）', () => {
    expect(applyLineOp('b\r\na', 'sort-asc')).toBe('a\r\nb');
    expect(addLineNumbers('a\r\nb')).toBe('1. a\r\n2. b');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// color
// ═════════════════════════════════════════════════════════════════════════════

describe('颜色转换：解析', () => {
  it('HEX 四种长度', () => {
    expect(parseColor('#0f0')).toEqual({ ok: true, color: { r: 0, g: 255, b: 0, a: 1 } });
    expect(parseColor('#00ff00')).toEqual({ ok: true, color: { r: 0, g: 255, b: 0, a: 1 } });
    expect(parseColor('#00ff0080')).toEqual({ ok: true, color: { r: 0, g: 255, b: 0, a: 128 / 255 } });
    const shortAlpha = parseColor('#0000');
    expect(shortAlpha.ok).toBe(true);
    if (shortAlpha.ok) expect(shortAlpha.color.a).toBe(0);
  });

  it('rgb()/rgba() 支持逗号与空格两种写法', () => {
    expect(parseColor('rgb(37, 99, 235)')).toEqual({ ok: true, color: { r: 37, g: 99, b: 235, a: 1 } });
    expect(parseColor('rgb(37 99 235 / 50%)')).toEqual({ ok: true, color: { r: 37, g: 99, b: 235, a: 0.5 } });
    // R3-493：页面自己 rgbaToCss 产出的 4 参数逗号写法必须能读回来（CSS Color 4）。
    expect(parseColor('rgba(37, 99, 235, 0.5)')).toEqual({ ok: true, color: { r: 37, g: 99, b: 235, a: 0.5 } });
    expect(parseColor('hsla(0, 100%, 50%, 0.25)')).toEqual({ ok: true, color: { r: 255, g: 0, b: 0, a: 0.25 } });
    const percent = parseColor('rgb(100%, 0%, 0%)');
    expect(percent.ok).toBe(true);
    if (percent.ok) expect(percent.color.r).toBe(255);
  });

  it('hsl()/hsla() 按标准公式换算成 RGB', () => {
    const red = parseColor('hsl(0, 100%, 50%)');
    expect(red.ok).toBe(true);
    if (red.ok) expect(red.color).toEqual({ r: 255, g: 0, b: 0, a: 1 });

    const green = parseColor('hsl(120 100% 25%)');
    expect(green.ok).toBe(true);
    if (green.ok) expect(green.color).toEqual({ r: 0, g: 128, b: 0, a: 1 });

    const hueWrap = hslToRgba({ h: -120, s: 100, l: 50, a: 1 });
    expect(hueWrap).toEqual({ r: 0, g: 0, b: 255, a: 1 });
  });

  it('非法输入给得出「是哪一段不对」的中文错误', () => {
    expect(parseColor('').ok).toBe(false);
    expect(parseColor('#12').ok).toBe(false);
    const badRgb = parseColor('rgb(300, 0, 0)');
    expect(badRgb.ok).toBe(true); // 300 会被夹到 255，而不是报错
    const badChannels = parseColor('rgb(0, 0)');
    expect(badChannels.ok).toBe(false);
    if (!badChannels.ok) expect(badChannels.error).toContain('3 个颜色通道');

    const badHsl = parseColor('hsl(0, 0, 0)');
    expect(badHsl.ok).toBe(true); // 不带 % 的 0 是合法边界
    const notColor = parseColor('不是颜色');
    expect(notColor.ok).toBe(false);
    if (!notColor.ok) expect(notColor.error).toContain('无法识别');
  });
});

describe('颜色转换：输出与对比度', () => {
  it('三种格式互转', () => {
    const parsed = parseColor('#2563eb');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const formats = colorFormats(parsed.color);
    expect(formats.hex).toBe('#2563eb');
    expect(formats.rgb).toBe('rgb(37, 99, 235)');
    expect(formats.hsl).toBe('hsl(221.2, 83.2%, 53.3%)');
  });

  it('alpha < 1 时 HEX 带 alpha 段、rgb 用 rgba()', () => {
    const color = { r: 255, g: 0, b: 0, a: 0.5 };
    expect(rgbaToHex(color)).toBe('#ff000080');
    expect(rgbaToCss(color)).toBe('rgba(255, 0, 0, 0.5)');
    expect(rgbaToHex({ r: 255, g: 0, b: 0, a: 1 })).toBe('#ff0000');
  });

  it('RGB → HSL 与已知值一致', () => {
    expect(rgbaToHsl({ r: 255, g: 0, b: 0, a: 1 })).toEqual({ h: 0, s: 100, l: 50, a: 1 });
    expect(rgbaToHsl({ r: 255, g: 255, b: 255, a: 1 })).toEqual({ h: 0, s: 0, l: 100, a: 1 });
    expect(rgbaToHsl({ r: 0, g: 0, b: 0, a: 1 })).toEqual({ h: 0, s: 0, l: 0, a: 1 });
  });

  it('WCAG 相对亮度与对比度（黑/白 = 21:1）', () => {
    const white = { r: 255, g: 255, b: 255, a: 1 };
    const black = { r: 0, g: 0, b: 0, a: 1 };
    expect(relativeLuminance(white)).toBeCloseTo(1, 6);
    expect(relativeLuminance(black)).toBeCloseTo(0, 6);
    expect(contrastRatio(black, white)).toBeCloseTo(21, 6);
    expect(contrastRatio(white, white)).toBeCloseTo(1, 6);
    expect(contrastRatio(black, white)).toBe(contrastRatio(white, black));
  });

  it('半透明色先合成到背景再算对比度（而不是直接拿半透明色算）', () => {
    const white = { r: 255, g: 255, b: 255, a: 1 };
    const translucentBlack = { r: 0, g: 0, b: 0, a: 0.5 };
    const ratio = contrastAgainst(translucentBlack, white);
    // 50% 黑叠白 = #808080，对比度约 3.95
    expect(ratio).toBeGreaterThan(3.5);
    expect(ratio).toBeLessThan(4.5);
    // 全透明 = 与背景相同 → 1:1
    expect(contrastAgainst({ r: 0, g: 0, b: 0, a: 0 }, white)).toBeCloseTo(1, 6);
  });

  it('AA / AAA 阈值（正文 4.5 / 7，大字 3 / 4.5）', () => {
    expect(wcagLevels(7.1)).toEqual({ aaNormal: true, aaaNormal: true, aaLarge: true, aaaLarge: true });
    expect(wcagLevels(4.6)).toEqual({ aaNormal: true, aaaNormal: false, aaLarge: true, aaaLarge: true });
    expect(wcagLevels(3.1)).toEqual({ aaNormal: false, aaaNormal: false, aaLarge: true, aaaLarge: false });
    expect(wcagLevels(2.9)).toEqual({ aaNormal: false, aaaNormal: false, aaLarge: false, aaaLarge: false });
    expect(formatContrast(4.5)).toBe('4.50:1');
  });

  it('黑底/白底上该用哪个字色', () => {
    expect(readableTextOn({ r: 255, g: 255, b: 255, a: 1 })).toBe('#000000');
    expect(readableTextOn({ r: 0, g: 0, b: 0, a: 1 })).toBe('#ffffff');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// HTTP 状态码
// ═════════════════════════════════════════════════════════════════════════════

describe('HTTP 状态码速查', () => {
  it('题目点名的常用码一条不少', () => {
    const required = [
      100, 101, 102, 103,
      200, 201, 202, 203, 204, 205, 206, 207, 208, 226,
      300, 301, 302, 303, 304, 305, 307, 308,
      400, 401, 402, 403, 404, 405, 406, 407, 408, 409, 410, 411, 412, 413, 414,
      415, 416, 417, 418, 421, 422, 423, 424, 425, 426, 428, 429, 431, 451,
      500, 501, 502, 503, 504, 505, 506, 507, 508, 510, 511,
    ];
    const present = new Set(HTTP_STATUSES.map((entry) => entry.code));
    const missing = required.filter((code) => !present.has(code));
    expect(missing, `缺少状态码：${missing.join(', ')}`).toEqual([]);
  });

  it('每条都有名称、中文含义与处理建议，且状态码不重复', () => {
    const codes = HTTP_STATUSES.map((entry) => entry.code);
    expect(new Set(codes).size).toBe(codes.length);
    for (const entry of HTTP_STATUSES) {
      expect(entry.name.length).toBeGreaterThan(0);
      expect(entry.meaning.length).toBeGreaterThan(4);
      expect(entry.advice.length).toBeGreaterThan(6);
      expect(httpStatusCategory(entry.code)).toBe(Math.trunc(entry.code / 100));
    }
  });

  it('分类计数与总数对得上', () => {
    const counts = httpStatusCounts();
    expect(counts[1] + counts[2] + counts[3] + counts[4] + counts[5]).toBe(HTTP_STATUSES.length);
    expect(counts[4]).toBeGreaterThan(20);
  });

  it('搜索按 code / 英文名 / 中文同义词都命中，分类可叠加过滤', () => {
    expect(searchHttpStatuses('404').map((entry) => entry.code)).toContain(404);
    expect(searchHttpStatuses('not found').map((entry) => entry.code)).toContain(404);
    expect(searchHttpStatuses('找不到').map((entry) => entry.code)).toContain(404);
    expect(searchHttpStatuses('限流').map((entry) => entry.code)).toContain(429);
    expect(searchHttpStatuses('', 5).every((entry) => entry.code >= 500)).toBe(true);
    expect(searchHttpStatuses('', 5).length).toBeGreaterThan(5);
    expect(searchHttpStatuses('zzz-不存在')).toEqual([]);
  });

  it('精确查找；未知码的分类为 null', () => {
    expect(findHttpStatus(301)?.name).toBe('Moved Permanently');
    expect(findHttpStatus(999)).toBeUndefined();
    expect(httpStatusCategory(999)).toBeNull();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// MIME
// ═════════════════════════════════════════════════════════════════════════════

describe('MIME 类型查询', () => {
  it('至少 100 条，覆盖全部大类', () => {
    expect(MIME_TYPES.length).toBeGreaterThanOrEqual(100);
    for (const category of MIME_CATEGORIES) {
      expect(mimeCategoryCounts()[category.key], `${category.label} 分类为空`).toBeGreaterThan(0);
    }
    const counts = mimeCategoryCounts();
    const total = Object.values(counts).reduce((sum, value) => sum + value, 0);
    expect(total).toBe(MIME_TYPES.length);
  });

  it('MIME 不重复、扩展名全部规范（无点、小写）', () => {
    const mimes = MIME_TYPES.map((entry) => entry.mime);
    expect(new Set(mimes).size).toBe(mimes.length);
    for (const entry of MIME_TYPES) {
      expect(entry.mime).toMatch(/^[a-z]+\/[a-z0-9.+-]+$/);
      for (const ext of entry.ext) {
        expect(ext).toBe(ext.toLowerCase());
        expect(ext.startsWith('.')).toBe(false);
      }
    }
  });

  it('按扩展名精确查（新旧写法都在）', () => {
    expect(mimeByExtension('png').map((entry) => entry.mime)).toContain('image/png');
    expect(mimeByExtension('.jpg')[0]?.mime).toBe('image/jpeg');
    const zip = mimeByExtension('ZIP').map((entry) => entry.mime);
    expect(zip).toContain('application/zip');
    expect(zip).toContain('application/x-zip-compressed');
    expect(mimeByExtension('')).toEqual([]);
    expect(mimeByExtension('不存在的扩展名')).toEqual([]);
  });

  it('按 MIME 精确查（忽略大小写与参数）', () => {
    expect(mimeByType('application/json')[0]?.ext).toContain('json');
    expect(mimeByType('Application/JSON; charset=utf-8')[0]?.mime).toBe('application/json');
    expect(mimeByType('image/png')).toHaveLength(1);
    expect(mimeByType('nope/nope')).toEqual([]);
  });

  it('页面搜索：扩展名 / MIME / 备注都能命中', () => {
    const json = searchMimeTypes('json').map((entry) => entry.mime);
    expect(json).toContain('application/json');
    expect(json).toContain('application/ld+json');
    expect(searchMimeTypes('image/png').map((entry) => entry.mime)).toEqual(['image/png']);
    expect(searchMimeTypes('charset').length).toBeGreaterThan(3);
    expect(searchMimeTypes('image', 'image').every((entry) => entry.category === 'image')).toBe(true);
    expect(searchMimeTypes('')).toHaveLength(MIME_TYPES.length);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// User-Agent
// ═════════════════════════════════════════════════════════════════════════════

const UA = {
  chromeWindows:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  edgeWindows:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0',
  firefoxWindows:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
  safariMac:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15',
  safariIos:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Mobile/15E148 Safari/604.1',
  safariIpad:
    'Mozilla/5.0 (iPad; CPU OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
  chromeAndroid:
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
  wechatIos:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.40(0x1800282a) NetType/WIFI Language/zh_CN',
  opera:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36 OPR/105.0.0.0',
  ie11: 'Mozilla/5.0 (Windows NT 10.0; WOW64; Trident/7.0; rv:11.0) like Gecko',
  googlebot: 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
  curl: 'curl/8.4.0',
};

describe('User-Agent 解析', () => {
  it('Chrome / Windows：Blink + 桌面', () => {
    const info = parseUserAgent(UA.chromeWindows);
    expect(info.browser).toEqual({ name: 'Chrome', version: '120.0.0.0' });
    expect(info.engine).toEqual({ name: 'Blink', version: '120.0.0.0' });
    expect(info.os).toEqual({ name: 'Windows', version: '10 / 11' });
    expect(info.device).toBe('desktop');
  });

  it('Edge 不会被认成 Chrome（识别顺序）', () => {
    const info = parseUserAgent(UA.edgeWindows);
    expect(info.browser?.name).toBe('Edge');
    expect(info.engine?.name).toBe('Blink');
    expect(info.device).toBe('desktop');
  });

  it('Firefox 是 Gecko', () => {
    const info = parseUserAgent(UA.firefoxWindows);
    expect(info.browser?.name).toBe('Firefox');
    expect(info.engine?.name).toBe('Gecko');
    expect(info.os?.name).toBe('Windows');
  });

  it('Safari / macOS 是 WebKit；iOS 上是 WebKit 且设备为手机', () => {
    const mac = parseUserAgent(UA.safariMac);
    expect(mac.browser?.name).toBe('Safari');
    expect(mac.engine?.name).toBe('WebKit');
    expect(mac.os).toEqual({ name: 'macOS', version: '10.15.7' });
    expect(mac.device).toBe('desktop');

    const ios = parseUserAgent(UA.safariIos);
    expect(ios.browser?.name).toBe('Safari');
    expect(ios.engine?.name).toBe('WebKit');
    expect(ios.os).toEqual({ name: 'iOS', version: '17.1' });
    expect(ios.device).toBe('mobile');
  });

  it('iPad 是平板；Android 带 Mobile 是手机', () => {
    expect(parseUserAgent(UA.safariIpad).device).toBe('tablet');
    const android = parseUserAgent(UA.chromeAndroid);
    expect(android.os).toEqual({ name: 'Android', version: '14' });
    expect(android.browser?.name).toBe('Chrome');
    expect(android.engine?.name).toBe('Blink');
    expect(android.device).toBe('mobile');
  });

  it('微信内置浏览器优先于 Chrome/Safari 特征', () => {
    const info = parseUserAgent(UA.wechatIos);
    expect(info.browser?.name).toBe('微信内置浏览器');
    expect(info.engine?.name).toBe('WebKit'); // iOS 上只能是 WebKit
    expect(info.device).toBe('mobile');
  });

  it('Opera / IE 各自的内核', () => {
    expect(parseUserAgent(UA.opera).browser?.name).toBe('Opera');
    const ie = parseUserAgent(UA.ie11);
    expect(ie.browser?.name).toBe('Internet Explorer');
    expect(ie.browser?.version).toBe('11.0');
    expect(ie.engine?.name).toBe('Trident');
  });

  it('爬虫与命令行客户端识别为 bot', () => {
    const bot = parseUserAgent(UA.googlebot);
    expect(bot.browser?.name).toBe('Googlebot');
    expect(bot.device).toBe('bot');
    const curl = parseUserAgent(UA.curl);
    expect(curl.browser?.name).toBe('curl');
    expect(curl.device).toBe('bot');
  });

  it('空 UA 不炸；展示行缺失项为「—」', () => {
    const empty = parseUserAgent('');
    expect(empty.browser).toBeNull();
    expect(userAgentRows(empty).every((row) => row.value === '—' || row.label === '设备类型')).toBe(true);
    expect(UA_DEVICE_LABELS.bot).toContain('机器人');
    const rows = userAgentRows(parseUserAgent(UA.chromeWindows));
    expect(rows.find((row) => row.label === '浏览器')?.value).toBe('Chrome');
    expect(rows.find((row) => row.label === '设备类型')?.value).toBe('桌面');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// SQL 格式化
// ═════════════════════════════════════════════════════════════════════════════

const SQL_OPTIONS = { dialect: 'generic' as const, uppercaseKeywords: true, indentSize: 2 as const };

describe('SQL 格式化', () => {
  it('子句各占一行、列表缩进、AND 换行', () => {
    const sql = 'select id, name from users where age > 18 and active = 1 order by name desc limit 10;';
    const out = formatSql(sql, SQL_OPTIONS);
    expect(out).toBe(
      [
        'SELECT',
        '  id,',
        '  name',
        'FROM',
        '  users',
        'WHERE',
        '  age > 18',
        '  AND active = 1',
        'ORDER BY',
        '  name DESC',
        'LIMIT 10;',
      ].join('\n')
    );
  });

  it('关键字大写开关关闭时保留源码大小写（排版不变）', () => {
    const out = formatSql('select 1;', { ...SQL_OPTIONS, uppercaseKeywords: false });
    expect(out).toBe('select\n  1;');
  });

  it('字符串 / 引号标识符 / 注释的内容一个字符都不改', () => {
    const sql = `SELECT '从 where 来的', "User" FROM t -- 行注释 from 不能动\nWHERE x = 'a -- b' /* 块 from 注释 */;`;
    const out = formatSql(sql, SQL_OPTIONS);
    expect(out).toContain(`'从 where 来的'`);
    expect(out).toContain('"User"');
    expect(out).toContain('-- 行注释 from 不能动');
    expect(out).toContain('/* 块 from 注释 */');
    expect(out).toContain(`'a -- b'`);
    // 字符串里的 where / from 没有被当成子句拆行
    expect(out).not.toContain(`'从\n  where`);
  });

  it('MySQL：反引号标识符内容不被大写、# 算注释', () => {
    const out = formatSql('select `select` from t # 这是注释\n;', {
      dialect: 'mysql',
      uppercaseKeywords: true,
      indentSize: 2,
    });
    expect(out).toContain('`select`');
    expect(out).toContain('# 这是注释');
    expect(out.split('\n')[0]).toBe('SELECT');
  });

  it('方言关键字集合不同（ILIKE 只在 PostgreSQL 里算关键字）', () => {
    expect(isSqlKeyword('ilike', 'postgresql')).toBe(true);
    expect(isSqlKeyword('ilike', 'generic')).toBe(false);
    expect(isSqlKeyword('pragma', 'sqlite')).toBe(true);
    expect(isSqlKeyword('pragma', 'postgresql')).toBe(false);
  });

  it('引号处理按方言：MySQL 单引号里的反斜杠是转义，通用方言不是', () => {
    const source = "select 'a\\'b';";
    const mysql = formatSql(source, {
      dialect: 'mysql',
      uppercaseKeywords: true,
      indentSize: 2,
    });
    const generic = formatSql(source, {
      dialect: 'generic',
      uppercaseKeywords: true,
      indentSize: 2,
    });
    // MySQL：整个 `'a\'b'` 是一个字符串字面量，原样保留
    expect(mysql).toContain("'a\\'b'");
    // 通用方言（标准 SQL）：反斜杠不是转义，`'a\'` 在第二个引号处结束
    expect(generic).not.toContain("'a\\'b'");
  });

  it('子查询整体缩进，括号对齐', () => {
    const out = formatSql('select * from (select id from t) as x;', SQL_OPTIONS);
    expect(out).toBe(
      [
        'SELECT',
        '  *',
        'FROM',
        '  (',
        '    SELECT',
        '      id',
        '    FROM',
        '      t',
        '  ) AS x;',
      ].join('\n')
    );
  });

  it('函数参数里的逗号不换行，IN 的列表也保持行内', () => {
    const out = formatSql('select count(a, b), coalesce(x, 0) from t where id in (1, 2, 3);', SQL_OPTIONS);
    expect(out).toContain('COUNT(a, b)');
    expect(out).toContain('COALESCE(x, 0)');
    expect(out).toContain('id IN (1, 2, 3)');
  });

  it('INSERT / UPDATE / DELETE 的基本排版', () => {
    expect(formatSql('insert into users (a, b) values (1, 2);', SQL_OPTIONS)).toBe(
      ['INSERT INTO', '  users(a, b)', 'VALUES', '  (1, 2);'].join('\n')
    );
    const update = formatSql('update users set a = 1, b = 2 where id = 3;', SQL_OPTIONS);
    expect(update.split('\n')[0]).toBe('UPDATE');
    expect(update).toContain('SET');
    expect(update).toContain('a = 1');
    expect(formatSql('delete from users where id = 1;', SQL_OPTIONS).split('\n')[0]).toBe('DELETE FROM');
  });

  it('空输入返回空串；单行语句不额外加空行', () => {
    expect(formatSql('', SQL_OPTIONS)).toBe('');
    expect(formatSql('select 1; select 2;', SQL_OPTIONS)).toBe('SELECT\n  1;\nSELECT\n  2;');
  });

  it('多行块注释的内部换行原样保留', () => {
    const out = formatSql('select 1 /* 第一行\n   第二行\n*/;', SQL_OPTIONS);
    expect(out).toContain('/* 第一行\n   第二行\n*/');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 代码格式化
// ═════════════════════════════════════════════════════════════════════════════

describe('代码格式化：JSON', () => {
  it('解析后按缩进序列化', () => {
    expect(formatCode('{"a":1,"b":[1,2]}', 'json', 2)).toBe(
      ['{', '  "a": 1,', '  "b": [', '    1,', '    2', '  ]', '}'].join('\n')
    );
  });

  it('非法 JSON 抛出带位置信息的错误', () => {
    expect(() => formatCode('{"a":}', 'json', 2)).toThrowError(/JSON|position|Unexpected/i);
    // R3-495：不能直接把 V8 英文甩给用户 —— 错误应是中文说明（可带行列）。
    try {
      formatCode('{"a":}', 'json', 2);
      expect.unreachable('应当抛错');
    } catch (error) {
      expect(String((error as Error).message)).toMatch(/JSON|属性名|成员|括号/);
    }
  });

  it('空输入返回空串', () => {
    expect(formatCode('   ', 'json', 2)).toBe('');
  });
});

describe('代码格式化：JavaScript / TypeScript', () => {
  it('数字后的成员访问要留空格（R3-495，`1.toString()` 是语法错误）', () => {
    expect(formatJavaScript('const a = 1 .toString();', 2)).toContain('1 .toString()');
    // 小数点的数字仍是紧贴的，不能被误插空格
    expect(formatJavaScript('const b = 1.5;', 2)).toContain('1.5');
  });
  it('花括号缩进与分号换行', () => {
    const out = formatJavaScript('function add(a,b){return a+b}const x={a:1,b:2};', 2);
    expect(out).toBe(
      ['function add(a, b) {', '  return a + b', '}', 'const x = {', '  a: 1,', '  b: 2', '};'].join('\n')
    );
  });

  it('字符串 / 模板串里的花括号与分号不参与排版', () => {
    const out = formatJavaScript('const s = "}{;"; const t = `a ${ {x:1}.x } b`;', 2);
    expect(out).toContain('const s = "}{;"');
    expect(out).toContain('const t = `a ${ {x:1}.x } b`');
  });

  it('正则字面量里的 // 与花括号不被当成注释 / 代码', () => {
    const out = formatJavaScript('const re = /\\/\\/ \\{}/g; const v = a / b;', 2);
    expect(out).toContain('const re = /\\/\\/ \\{}/g;');
    expect(out).toContain('const v = a / b;');
  });

  it('注释原文保留', () => {
    const out = formatJavaScript('function f(){// 行注释\n/* 块 { 注释 } */\nreturn 1;}', 2);
    expect(out).toContain('// 行注释');
    expect(out).toContain('/* 块 { 注释 } */');
  });

  it('if / else 同行，空块保持一行', () => {
    const out = formatJavaScript('if(x){y()}else{z()}', 2);
    expect(out).toBe(['if (x) {', '  y()', '} else {', '  z()', '}'].join('\n'));
    expect(formatJavaScript('function f(){}', 2)).toBe('function f() {}');
  });

  it('多行模板串内部原文不变', () => {
    const source = 'const t = `第一行\n第二行`;';
    const out = formatJavaScript(source, 2);
    expect(out).toContain('`第一行\n第二行`');
  });

  it('TypeScript 类型标注与接口保留', () => {
    const out = formatJavaScript('interface User{id:number;name?:string}', 2);
    expect(out).toContain('interface User {');
    expect(out).toContain('name?: string');
  });
});

describe('代码格式化：CSS', () => {
  it('选择器与声明分行', () => {
    const out = formatCss('a{color:red;background:blue}', 2);
    expect(out).toBe(['a {', '  color: red;', '  background: blue;', '}'].join('\n'));
  });

  it('伪类选择器不写成「属性: 值」，后代选择器保留空格', () => {
    const out = formatCss('div .link:hover{color:red}', 2);
    expect(out).toContain('div .link:hover {');
    expect(out).toContain('color: red;');
  });

  it('url() 原样保留，字符串与注释原文不变', () => {
    const out = formatCss('a{background:url("http://x/y.png") /* 注释 */ no-repeat}', 2);
    expect(out).toContain('url("http://x/y.png")');
    expect(out).toContain('/* 注释 */');
  });

  it('@media 块与嵌套规则缩进', () => {
    const out = formatCss('@media (min-width:600px){a{color:red}}', 2);
    expect(out).toBe(['@media (min-width: 600px) {', '  a {', '    color: red;', '  }', '}'].join('\n'));
  });

  it('选择器列表按行拆开，声明里的逗号不拆', () => {
    const out = formatCss('a,b{font-family:Arial,sans-serif}', 2);
    expect(out).toBe(['a,', 'b {', '  font-family: Arial, sans-serif;', '}'].join('\n'));
  });
});

describe('代码格式化：HTML / XML', () => {
  it('标签嵌套缩进，纯文本子元素保持一行', () => {
    const out = formatMarkup('<div><p>Hello</p><img src="a.png"></div>', 2, 'html');
    expect(out).toBe(['<div>', '  <p>Hello</p>', '  <img src="a.png">', '</div>'].join('\n'));
  });

  it('pre / script 的内部原文整段保留', () => {
    const source = '<div><pre>\n  a < b && c\n</pre><script>if (a < b) { x() }</script></div>';
    const out = formatMarkup(source, 2, 'html');
    expect(out).toContain('<pre>\n  a < b && c\n</pre>');
    expect(out).toContain('<script>if (a < b) { x() }</script>');
  });

  it('HTML 注释与 doctype 原样输出', () => {
    const out = formatMarkup('<!DOCTYPE html><!-- 注释 --><br>', 2, 'html');
    expect(out).toBe(['<!DOCTYPE html>', '<!-- 注释 -->', '<br>'].join('\n'));
  });

  it('XML：自闭合标签、CDATA 与处理指令', () => {
    const source = '<?xml version="1.0"?><root><item id="1"/><data><![CDATA[a < b]]></data></root>';
    const out = formatMarkup(source, 2, 'xml');
    expect(out).toBe(
      [
        '<?xml version="1.0"?>',
        '<root>',
        '  <item id="1"/>',
        '  <data>',
        '    <![CDATA[a < b]]>',
        '  </data>',
        '</root>',
      ].join('\n')
    );
  });

  it('语言清单覆盖题目要求的六种', () => {
    expect(CODE_LANGUAGES.map((entry) => entry.value).sort()).toEqual(
      ['css', 'html', 'javascript', 'json', 'typescript', 'xml'].sort()
    );
  });
});
