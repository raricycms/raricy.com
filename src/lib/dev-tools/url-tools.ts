// ─────────────────────────────────────────────────────────────────────────────
// url-tools.ts —— 开发者工具「URL 参数解析与编辑 / UTM 生成 / 网址批量提取」的纯逻辑
//
// 【零依赖、零 React】三个工具共用这一份，node 单测直接 import。
//
// 【重复键保留】解析走 `url.searchParams.entries()`（不是 `get`），所以
// `?a=1&a=2` 会原样得到两行；重建按数组顺序逐段拼，顺序与重复都由数组本身表达，
// 不再经过 `URLSearchParams.set`（那个会把重复键合并成一条）。
//
// 【提取的诚实边界】裸域名识别靠「域名 + 后缀」形状，后缀必须命中 2 位国家域名
// 或下面的常见 TLD 白名单 —— 否则 `file.txt`、`v1.2.3` 都会被当成网址。
// 这是刻意收窄的：宁可漏掉冷门新后缀，也不要往结果里塞一堆文件名。
// ─────────────────────────────────────────────────────────────────────────────

/** 解析出的一条查询参数（值已解码）。 */
export interface UrlParamEntry {
  key: string;
  value: string;
}

export interface ParsedUrlParts {
  /** 不带冒号的小写协议，如 `https`（页面里直接编辑这一段）。 */
  protocol: string;
  host: string;
  pathname: string;
  /** 含 `#` 的锚点；没有就是空串。 */
  hash: string;
  /** 查询参数，保持原顺序与重复键。 */
  params: UrlParamEntry[];
  /** 输入没写协议时按 https 解析（页面要如实提示这一点）。 */
  assumedProtocol: boolean;
  /** 输入原文。 */
  raw: string;
}

export type ParseUrlResult = { ok: true; parts: ParsedUrlParts } | { ok: false; error: string };

const SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;

function splitProtocol(protocol: string): string {
  return protocol.replace(/:$/, '').toLowerCase();
}

/** 解析完整 URL（没写协议时按 https 补全，并在结果里标出来）。 */
export function parseUrlParts(input: string): ParseUrlResult {
  const text = input.trim();
  if (text === '') return { ok: false, error: '请先输入 URL。' };

  const hasScheme = SCHEME_RE.test(text);
  const candidate = hasScheme ? text : `https://${text}`;

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return { ok: false, error: '不是合法的 URL。' };
  }

  const protocol = splitProtocol(url.protocol);
  if (protocol !== 'http' && protocol !== 'https') {
    return {
      ok: false,
      error: `目前只支持 http / https 链接（当前协议是 ${protocol || '空'}）。`,
    };
  }
  if (url.hostname === '') return { ok: false, error: 'URL 里没有主机名。' };

  return {
    ok: true,
    parts: {
      protocol,
      host: url.host,
      pathname: url.pathname,
      hash: url.hash,
      params: [...url.searchParams.entries()].map(([key, value]) => ({ key, value })),
      assumedProtocol: !hasScheme,
      raw: text,
    },
  };
}

/** 编辑态的一条参数：值是否在拼回时重新编码，由每行自己的开关决定。 */
export interface UrlParamDraft {
  key: string;
  value: string;
  /** true → 拼回时对值做 encodeURIComponent；false → 原样拼（用于观察未编码效果）。 */
  encode: boolean;
}

export interface UrlDraft {
  protocol: string;
  host: string;
  pathname: string;
  hash: string;
  params: UrlParamDraft[];
}

export type BuildUrlResult = { ok: true; url: string } | { ok: false; error: string };

/** 按草稿重建 URL（参数顺序 / 重复键 / 顺序都由数组决定）。 */
export function buildUrl(draft: UrlDraft): BuildUrlResult {
  const protocol = splitProtocol(draft.protocol.trim());
  if (protocol !== 'http' && protocol !== 'https') {
    return { ok: false, error: '协议只能是 http 或 https。' };
  }
  const host = draft.host.trim();
  if (host === '') return { ok: false, error: '主机名不能为空。' };

  let pathname = draft.pathname.trim();
  if (pathname === '') pathname = '/';
  if (!pathname.startsWith('/')) pathname = `/${pathname}`;

  const pairs: string[] = [];
  for (const param of draft.params) {
    const key = param.key;
    const hasValue = param.value !== '';
    // 完全空的行（用户刚点「加一行」还没填）不参与拼接。
    if (key === '' && !hasValue) continue;
    const valueText = param.encode ? encodeURIComponent(param.value) : param.value;
    pairs.push(`${encodeURIComponent(key)}=${valueText}`);
  }

  const hashRaw = draft.hash.trim();
  const hash = hashRaw === '' ? '' : hashRaw.startsWith('#') ? hashRaw : `#${hashRaw}`;

  return {
    ok: true,
    url: `${protocol}://${host}${pathname}${pairs.length > 0 ? `?${pairs.join('&')}` : ''}${hash}`,
  };
}

// ── UTM ─────────────────────────────────────────────────────────────────────

export interface UtmValues {
  source: string;
  medium: string;
  campaign: string;
  term: string;
  content: string;
}

export interface UtmBuiltParam {
  key: string;
  value: string;
}

export interface UtmBuilt {
  ok: true;
  url: string;
  /**
   * 基础链接：`origin + pathname`（**所有查询串与 `#hash` 都不在 base 里** ——
   * 不只是 utm_*；面板上「基础链接」只是拆解用的展示值）。
   */
  base: string;
  /** 实际拼进去的 UTM 参数（按固定顺序）。 */
  params: UtmBuiltParam[];
}

export type UtmResult = UtmBuilt | { ok: false; error: string };

/** 常用 source / medium 预设（页面按钮与单测共用这一份）。 */
export const UTM_PRESETS: ReadonlyArray<{ label: string; source: string; medium: string }> = [
  { label: 'Google / CPC', source: 'google', medium: 'cpc' },
  { label: '微信 / 社交', source: 'wechat', medium: 'social' },
  { label: '邮件简报 / Email', source: 'newsletter', medium: 'email' },
  { label: '微博 / 社交', source: 'weibo', medium: 'social' },
  { label: '百度 / CPC', source: 'baidu', medium: 'cpc' },
  { label: 'Bing / CPC', source: 'bing', medium: 'cpc' },
];

const UTM_KEYS: ReadonlyArray<keyof UtmValues> = ['source', 'medium', 'campaign', 'term', 'content'];

/** 补全协议：没写 `https://` 这类前缀时按 https 补。 */
export function normalizeBaseUrl(input: string): { ok: true; url: URL } | { ok: false; error: string } {
  const text = input.trim();
  if (text === '') return { ok: false, error: '请填写基础链接。' };
  const candidate = SCHEME_RE.test(text) ? text : `https://${text}`;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return { ok: false, error: '基础链接不是合法的 URL。' };
  }
  const protocol = splitProtocol(url.protocol);
  if ((protocol !== 'http' && protocol !== 'https') || url.hostname === '') {
    return { ok: false, error: '基础链接必须是 http / https 地址。' };
  }
  return { ok: true, url };
}

/**
 * 生成带 UTM 的推广链接。
 *
 * · 基础链接没写协议时补 `https://`；
 * · 基础链接里已有的同名 `utm_*` 会被本次输入覆盖（不是叠加）；
 * · 非必填字段留空就**不拼**（空参数会让统计里多出一条 `utm_term=` 的空值）；
 * · 一个都没填时报错 —— 生成一条与基础链接一模一样的「推广链接」没有意义。
 */
export function buildUtmUrl(baseInput: string, values: UtmValues): UtmResult {
  const base = normalizeBaseUrl(baseInput);
  if (!base.ok) return base;

  const url = base.url;
  const params: UtmBuiltParam[] = [];
  for (const key of UTM_KEYS) {
    const value = values[key].trim();
    const fullKey = `utm_${key}`;
    url.searchParams.delete(fullKey);
    if (value === '') continue;
    url.searchParams.set(fullKey, value);
    params.push({ key: fullKey, value });
  }

  if (params.length === 0) {
    return { ok: false, error: '至少填写一个 UTM 参数（推荐 source / medium / campaign）。' };
  }

  return { ok: true, url: url.toString(), base: url.origin + url.pathname, params };
}

// ── 网址提取 ────────────────────────────────────────────────────────────────

export interface ExtractOptions {
  /** 去重（保留第一次出现的那条）。 */
  dedupe: boolean;
  /** 去重时忽略大小写（仅在 dedupe 打开时有意义）。 */
  ignoreCase: boolean;
  /** 去掉 utm_* 与常见点击追踪参数。 */
  stripTracking: boolean;
  /** 按字典序排序结果。 */
  sort: boolean;
  /** 只保留域名（去掉协议、路径、参数与锚点）。 */
  domainsOnly: boolean;
}

export interface ExtractResult {
  urls: string[];
  /** 命中的原始条数（去重前；用来告诉用户「提取到 N 条，去重后剩 M 条」）。 */
  totalFound: number;
  /** 输入超过上限被截断。 */
  truncated: boolean;
  /** 结果超过上限被截断。 */
  limited: boolean;
  inputLength: number;
}

/** 输入长度上限：再长也不是「一段文本」了，而且正则扫描会明显卡顿。 */
export const EXTRACT_MAX_INPUT_CHARS = 200_000;
/** 结果条数上限（防止把一大坨日志灌进 DOM）。 */
export const EXTRACT_MAX_RESULTS = 5_000;

/**
 * 常见（≥3 字符的）TLD 白名单。
 *
 * 2 位后缀一律按国家域名接受（所有 ccTLD 都是 2 位），3 位及以上只认这些常见项
 * —— 白名单是为了排除 `file.txt` / `v1.2` / `readme.md` 这类「长得像域名」的普通词。
 */
const COMMON_TLDS = new Set<string>(
  (
    'com net org edu gov mil int info biz name pro mobi asia tel travel jobs cat coop aero museum ' +
    'io dev app ai xyz tech online site store cloud live news blog shop club vip top win men loan ' +
    'click link work shop art fun life love guru ninja rocks works zone space website host press ' +
    'wiki media email social network company group world today digital agency solutions services ' +
    'software studio design systems codes run page blog shop site store stream team tools trading ' +
    'academy center chat city community computer consulting digital download education energy ' +
    'engineer enterprise finance financial foundation global health hospital institute insurance ' +
    'international lawyer legal limited marketing money mortgage network partners photography ' +
    'pictures pizza productions properties racing recipes rentals report reviews school science ' +
    'security services shopping soccer solar support surgery systems taxi technology tips today ' +
    'tokyo tours town toys training university vacations ventures video vision voyage watch webcam ' +
    'wedding wine works world wtf'
  )
    // 顺序无关；重复项由 Set 吃掉。
    .split(/\s+/)
);

const TRACKING_PARAM_NAMES = new Set<string>([
  'fbclid',
  'gclid',
  'dclid',
  'msclkid',
  'yclid',
  'twclid',
  'ttclid',
  'igshid',
  'li_fat_id',
  'mc_cid',
  'mc_eid',
  '_ga',
  '_gl',
  'vero_id',
  'wickedid',
  'rb_clickid',
  's_cid',
  'elqtrackid',
  'elqtrack',
]);

function isTrackingParam(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.startsWith('utm_') || TRACKING_PARAM_NAMES.has(lower);
}

/** 去掉末尾的标点 / 不成对的右括号（`（见 https://a.com）。` 这类）。 */
function trimUrlTail(raw: string): string {
  let out = raw.replace(/[.,;:!?。，；：！？、…"'”’）】》〉]+$/u, '');
  const stripUnbalanced = (closer: string, opener: string) => {
    while (out.endsWith(closer)) {
      const closers = out.split(closer).length - 1;
      const openers = out.split(opener).length - 1;
      if (closers <= openers) break;
      out = out.slice(0, -1);
    }
  };
  stripUnbalanced(')', '(');
  stripUnbalanced(']', '[');
  stripUnbalanced('}', '{');
  return out;
}

/**
 * 常见文件扩展名 —— 即使它是两位（`md` / `js` / `ts` 这类同时是合法 TLD）也拒绝。
 *
 * 判据来自真实误报：`readme.md`、`main.ts`、`config.yml` 在纯文本里比「摩尔多瓦的
 * readme 域名」常见得多。代价是确实叫 `something.md` 的站会被漏掉 —— 这是有意收窄，
 * 页面提示里也写了「裸域名按常见后缀识别，冷门后缀可能漏」。
 */
const FILE_EXTENSIONS = new Set<string>([
  'md',
  'txt',
  'json',
  'js',
  'mjs',
  'cjs',
  'ts',
  'tsx',
  'jsx',
  'py',
  'rb',
  'rs',
  'go',
  'java',
  'c',
  'h',
  'cpp',
  'hpp',
  'cs',
  'php',
  'sh',
  'bat',
  'ps1',
  'yml',
  'yaml',
  'toml',
  'ini',
  'cfg',
  'conf',
  'log',
  'csv',
  'xml',
  'html',
  'htm',
  'css',
  'scss',
  'less',
  'pdf',
  'png',
  'jpg',
  'jpeg',
  'gif',
  'svg',
  'webp',
  'ico',
  'mp3',
  'mp4',
  'wav',
  'zip',
  'tar',
  'gz',
  'rar',
  '7z',
  'exe',
  'dll',
  'so',
  'dylib',
  'db',
  'sqlite',
  'lock',
  'env',
  'bin',
  'iso',
  'dmg',
  'apk',
]);

/** 裸域名的后缀是否可信（2 位一律接受，≥3 位查白名单；文件扩展名一律拒绝）。 */
function hasKnownTld(host: string): boolean {
  const labels = host.split('.');
  if (labels.length < 2) return false;
  const tld = labels[labels.length - 1].toLowerCase();
  if (FILE_EXTENSIONS.has(tld)) return false;
  if (!/^[a-z]{2,24}$/.test(tld)) return false;
  if (tld.length === 2) return true;
  return COMMON_TLDS.has(tld);
}

/**
 * 去掉追踪参数。不是合法 URL 时原样返回（不因为清理失败而丢掉用户提取到的内容）。
 */
export function stripTrackingParams(rawUrl: string): string {
  const hadScheme = /^https?:\/\//i.test(rawUrl);
  let url: URL;
  try {
    url = new URL(hadScheme ? rawUrl : `https://${rawUrl}`);
  } catch {
    return rawUrl;
  }

  let changed = false;
  for (const key of [...url.searchParams.keys()]) {
    if (isTrackingParam(key)) {
      url.searchParams.delete(key);
      changed = true;
    }
  }
  if (!changed) return rawUrl;

  const out = url.toString();
  return hadScheme ? out : out.replace(/^https:\/\//i, '');
}

/** 只保留域名（host）。不是合法 URL 时退回原文。 */
export function toDomainOnly(rawUrl: string): string {
  const hadScheme = /^https?:\/\//i.test(rawUrl);
  try {
    return new URL(hadScheme ? rawUrl : `https://${rawUrl}`).host;
  } catch {
    return rawUrl;
  }
}

// URL 里允许的字符集**只收 ASCII**：中文标点（`。`、`！`）与中文字符都不在集合里，
// 否则「见 https://a.com/x。还有」会把「。还有」一起吞进网址。代价是未编码的 IDN
// 中文域名提不出来 —— 可接受，页面提示里写了。
const URL_CHARS = "[A-Za-z0-9\\-._~:/?#\\[\\]@!$&'()*+,;=%]";

const TOKEN_RE = new RegExp(
  `(https?:\\/\\/${URL_CHARS}+)|(^|[^\\w@.\\-/])((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\\.)+[a-z]{2,24}(?:\\/${URL_CHARS}*)?)`,
  'gi'
);

/**
 * 从任意文本里提取 http(s) 链接与裸域名。
 *
 * 顺序固定：**先提取 → 再去追踪参数 → 再去重 / 排序 / 只留域名**。
 * 去追踪参数放在去重之前，否则 `?utm_source=a` 与 `?utm_source=b` 会被当成两条。
 */
export function extractUrls(text: string, options: ExtractOptions): ExtractResult {
  const inputLength = text.length;
  const truncated = inputLength > EXTRACT_MAX_INPUT_CHARS;
  const source = truncated ? text.slice(0, EXTRACT_MAX_INPUT_CHARS) : text;

  const totalFoundSeen: string[] = [];
  const results: string[] = [];
  const dedupeKeys = new Set<string>();

  for (const match of source.matchAll(TOKEN_RE)) {
    const schemeUrl = match[1];
    const bareDomain = match[3];
    const raw = schemeUrl ?? bareDomain;
    if (!raw) continue;

    const cleaned = trimUrlTail(raw);
    if (cleaned === '') continue;

    if (schemeUrl) {
      // `https://` 后面什么都没有（例如句尾只剩协议）不算网址。
      if (/^https?:\/\/$/i.test(cleaned)) continue;
    } else {
      const hostPart = cleaned.split(/[/?#]/)[0];
      if (!hasKnownTld(hostPart)) continue;
    }

    totalFoundSeen.push(cleaned);

    let value = cleaned;
    if (options.stripTracking) value = stripTrackingParams(value);
    if (options.domainsOnly) value = toDomainOnly(value);
    if (value === '') continue;

    if (options.dedupe) {
      const key = options.ignoreCase ? value.toLowerCase() : value;
      if (dedupeKeys.has(key)) continue;
      dedupeKeys.add(key);
    }
    results.push(value);
  }

  if (options.sort) {
    // 不用 localeCompare：它随运行环境的 locale 变，单测会不稳。
    results.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  }

  const limited = results.length > EXTRACT_MAX_RESULTS;
  return {
    urls: limited ? results.slice(0, EXTRACT_MAX_RESULTS) : results,
    totalFound: totalFoundSeen.length,
    truncated,
    limited,
    inputLength,
  };
}
