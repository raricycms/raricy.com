// ─────────────────────────────────────────────────────────────────────────────
// user-agent.ts —— 「User-Agent 解析」的纯逻辑
//
// 【口径】
//   · 浏览器**按特征串优先级**识别：微信 / 企业微信 / Edge / Opera / Samsung
//     Internet / UC / QQ 浏览器 / Firefox / Chrome / Safari / IE —— 顺序不能打乱，
//     因为它们共用 `AppleWebKit` 与 `Chrome` 特征串（Edge 里也有 `Chrome/`，
//     微信里也有 `Chrome/`）。识别顺序就是这个文件的规则本身。
//   · 引擎由特征串与浏览器共同决定：Chromium 系（桌面/安卓）判 Blink；iOS 上所有
//     浏览器都被 Apple 强制用 WebKit（Chrome iOS、Firefox iOS 也一样）；旧 Edge
//     是 EdgeHTML；旧 Opera 是 Presto；IE 是 Trident；其余按 AppleWebKit / Gecko。
//   · OS 顺序同样是硬规则：iOS 在 macOS 之前（iPad UA 含 `like Mac OS X`）、
//     Android 在 Linux 之前（Android UA 也含 `Linux`）、Windows Phone 在 Windows 之前。
//   · 设备类型只在「看得出来的特征」上判：iPad / Android 无 `Mobile` → 平板；
//     iPhone / Android 带 `Mobile` → 手机；Windows 等桌面系统 → 桌面；爬虫与
//     游戏主机各自成档。**普通桌面 Chrome 的 UA 里没有可靠的分辨率/触摸信息**，
//     所以不做「是否二合一设备」这类猜测。
//
// 【必须写在页面上的一句话】UA 由客户端自己发，**可以随意伪造**，解析结果只能当
// 线索，不能当鉴权或风控依据。数据全部来自 UA 字符串本身，不联网、不查库。
// ─────────────────────────────────────────────────────────────────────────────

export type UaDeviceType = 'desktop' | 'mobile' | 'tablet' | 'bot' | 'console' | 'other';

export interface UaBrowserInfo {
  name: string;
  /** 取不到时为空串。 */
  version: string;
}

export interface UaEngineInfo {
  name: string;
  version: string;
}

export interface UaOsInfo {
  name: string;
  /** 取不到具体版本时为空串（例如 Linux）。 */
  version: string;
}

export interface UserAgentInfo {
  browser: UaBrowserInfo | null;
  engine: UaEngineInfo | null;
  os: UaOsInfo | null;
  device: UaDeviceType;
}

export const UA_DEVICE_LABELS: Record<UaDeviceType, string> = {
  desktop: '桌面',
  mobile: '手机',
  tablet: '平板',
  bot: '机器人 / 爬虫',
  console: '游戏主机',
  other: '其他',
};

/** 网页上「浏览器 / 内核 / 系统 / 设备」四行展示用；缺失项显示「—」。 */
export interface UserAgentRow {
  label: string;
  value: string;
}

// ── 爬虫 / 命令行客户端 ──────────────────────────────────────────────────────
// 放在最前面：Googlebot 之类常带完整浏览器特征串，先认它们才不会被误判成 Chrome。
const BOTS: ReadonlyArray<{ name: string; re: RegExp }> = [
  { name: 'Googlebot', re: /Googlebot(?:-Image|-Video|-News|-Mobile)?\/([\d.]+)/i },
  { name: 'Bingbot', re: /bingbot\/([\d.]+)/i },
  { name: 'Baiduspider', re: /Baiduspider(?:-image|-video|-news)?\/([\d.]+)/i },
  { name: 'YandexBot', re: /YandexBot\/([\d.]+)/i },
  { name: 'DuckDuckBot', re: /DuckDuckBot\/([\d.]+)/i },
  { name: 'Applebot', re: /Applebot\/([\d.]+)/i },
  { name: 'Facebook 抓取', re: /facebookexternalhit\/([\d.]+)/i },
  { name: 'Twitterbot', re: /Twitterbot\/([\d.]+)/i },
  { name: 'Discordbot', re: /Discordbot\/([\d.]+)/i },
  { name: 'Slackbot', re: /Slackbot(?:-LinkExpanding)?[ /]([\d.]+)/i },
  { name: 'SemrushBot', re: /SemrushBot\/([\d.]+)/i },
  { name: 'AhrefsBot', re: /AhrefsBot\/([\d.]+)/i },
  { name: 'curl', re: /curl\/([\d.]+)/i },
  { name: 'Wget', re: /Wget\/([\d.]+)/i },
  { name: 'Python Requests', re: /python-requests\/([\d.]+)/i },
  { name: 'Python urllib', re: /Python-urllib\/([\d.]+)/i },
  { name: 'node-fetch', re: /node-fetch\/([\d.]+)/i },
  { name: 'Axios', re: /axios\/([\d.]+)/i },
  { name: 'Go HTTP 客户端', re: /Go-http-client\/([\d.]+)/i },
  { name: 'OkHttp', re: /okhttp\/([\d.]+)/i },
  { name: 'Postman', re: /PostmanRuntime\/([\d.]+)/i },
];

// ── 浏览器 ──────────────────────────────────────────────────────────────────
// 顺序 = 匹配优先级，理由见文件头。
const BROWSERS: ReadonlyArray<{ name: string; re: RegExp }> = [
  { name: '微信内置浏览器', re: /MicroMessenger\/([\d.]+)/i },
  { name: '企业微信内置浏览器', re: /wxwork\/([\d.]+)/i },
  { name: 'QQ 浏览器', re: /QQBrowser\/([\d.]+)/i },
  { name: 'UC 浏览器', re: /UCBrowser\/([\d.]+)/i },
  { name: 'Samsung Internet', re: /SamsungBrowser\/([\d.]+)/i },
  { name: 'Edge', re: /Edg(?:e|A|iOS)?\/([\d.]+)/i },
  { name: 'Opera', re: /(?:OPR|OPiOS|Opera[ /])\/?([\d.]+)/i },
  { name: 'Firefox', re: /(?:Firefox|FxiOS)\/([\d.]+)/i },
  { name: 'Chrome', re: /(?:Chrome|CriOS)\/([\d.]+)/i },
  { name: 'Safari', re: /Version\/([\d.]+).*Safari\//i },
  { name: 'Safari', re: /Safari\/([\d.]+)/i },
  { name: 'Internet Explorer', re: /MSIE ([\d.]+)/i },
  { name: 'Internet Explorer', re: /Trident\/.*rv:([\d.]+)/i },
];

/** 把版本号里的下划线换成点（iOS / macOS 常见 `16_4_1`），并去掉多余尾巴。 */
function normalizeVersion(raw: string | undefined): string {
  return (raw ?? '').replace(/_/g, '.').replace(/\.+$/, '');
}

function matchVersion(re: RegExp, ua: string): string | null {
  const m = re.exec(ua);
  return m ? normalizeVersion(m[1]) : null;
}

function detectBot(ua: string): UaBrowserInfo | null {
  for (const bot of BOTS) {
    const version = matchVersion(bot.re, ua);
    if (version !== null || bot.re.test(ua)) {
      return { name: bot.name, version: version ?? '' };
    }
  }
  return null;
}

function detectBrowser(ua: string): UaBrowserInfo | null {
  for (const browser of BROWSERS) {
    const version = matchVersion(browser.re, ua);
    if (version !== null) return { name: browser.name, version };
  }
  return null;
}

function detectEngine(ua: string, browser: UaBrowserInfo | null, isIos: boolean): UaEngineInfo | null {
  // IE / 旧 Edge / 旧 Opera：各自独立的内核。
  if (/Trident\//.test(ua) || /MSIE /.test(ua)) {
    return { name: 'Trident', version: matchVersion(/Trident\/([\d.]+)/i, ua) ?? '' };
  }
  if (/\bEdge\//.test(ua)) {
    return { name: 'EdgeHTML', version: matchVersion(/\bEdge\/([\d.]+)/i, ua) ?? '' };
  }
  if (/Presto\//.test(ua)) {
    return { name: 'Presto', version: matchVersion(/Presto\/([\d.]+)/i, ua) ?? '' };
  }

  const appleWebKit = matchVersion(/AppleWebKit\/([\d.]+)/i, ua);
  const chromiumVersion = matchVersion(/(?:Chrome|CriOS|Chromium)\/([\d.]+)/i, ua);

  // iOS 上所有浏览器都必须用 WebKit；`CriOS` / `FxiOS` 也会带 AppleWebKit。
  if (isIos && appleWebKit !== null) {
    return { name: 'WebKit', version: appleWebKit };
  }
  // Chromium 系（桌面 / 安卓）：Chrome 的版本号就是 Blink 的实际版本线。
  if (chromiumVersion !== null && appleWebKit !== null) {
    return { name: 'Blink', version: chromiumVersion };
  }
  if (/Gecko\/\d/.test(ua) && !/like Gecko/i.test(ua)) {
    return { name: 'Gecko', version: matchVersion(/Gecko\/([\d.]+)/i, ua) ?? '' };
  }
  if (appleWebKit !== null) {
    return { name: 'WebKit', version: appleWebKit };
  }
  if (/Gecko\/\d/.test(ua)) {
    return { name: 'Gecko', version: matchVersion(/Gecko\/([\d.]+)/i, ua) ?? '' };
  }
  return null;
}

function detectOs(ua: string): UaOsInfo | null {
  // iOS 必须在 macOS 之前：iPad 的 UA 里有 `like Mac OS X`。
  const ios = /(?:iPhone|iPad|iPod)[^)]*?OS ([\d_]+)/i.exec(ua);
  if (ios) return { name: 'iOS', version: normalizeVersion(ios[1]) };

  const windowsPhone = /Windows Phone(?: OS)? ([\d.]+)/i.exec(ua);
  if (windowsPhone) return { name: 'Windows Phone', version: normalizeVersion(windowsPhone[1]) };

  const android = /Android\s*([\d.]+)?/i.exec(ua);
  if (android) return { name: 'Android', version: normalizeVersion(android[1]) };

  const harmony = /(?:HarmonyOS|OpenHarmony)[ /]?([\d.]+)?/i.exec(ua);
  if (harmony) return { name: 'HarmonyOS', version: normalizeVersion(harmony[1]) };

  const chromeOs = /CrOS \w+ ([\d.]+)/i.exec(ua);
  if (chromeOs) return { name: 'Chrome OS', version: normalizeVersion(chromeOs[1]) };

  const mac = /Mac OS X\s*([\d_]+)/i.exec(ua);
  if (mac) return { name: 'macOS', version: normalizeVersion(mac[1]) };

  const windows = /Windows NT ([\d.]+)/i.exec(ua);
  if (windows) {
    const nt = windows[1];
    const name =
      nt === '10.0'
        ? '10 / 11'
        : nt === '6.3'
          ? '8.1'
          : nt === '6.2'
            ? '8'
            : nt === '6.1'
              ? '7'
              : nt === '6.0'
                ? 'Vista'
                : nt === '5.1'
                  ? 'XP'
                  : `NT ${nt}`;
    return { name: 'Windows', version: name };
  }

  if (/\bLinux\b/i.test(ua)) return { name: 'Linux', version: '' };
  if (/FreeBSD/i.test(ua)) return { name: 'FreeBSD', version: '' };
  return null;
}

function detectDevice(ua: string, browser: UaBrowserInfo | null, os: UaOsInfo | null): UaDeviceType {
  if (browser !== null && BOTS.some((bot) => bot.name === browser.name)) return 'bot';
  if (/PlayStation|Xbox|Nintendo Switch|Nintendo 3DS|Nintendo Wii/i.test(ua)) return 'console';

  // 平板：iPad、Android 平板（UA 里**没有** `Mobile` 而是 `Tablet`/`Tab`/纯 Android）、
  // 以及 Windows 平板模式（带 `Touch` 与 `Tablet PC`）。
  if (/iPad/i.test(ua) || /\biPadOS\b/i.test(ua)) return 'tablet';
  if (/\bTablet\b/i.test(ua)) return 'tablet';
  if (/Android/i.test(ua) && !/Mobile/i.test(ua)) return 'tablet';
  if (/Windows/i.test(ua) && /Touch/i.test(ua) && /Tablet PC/i.test(ua)) return 'tablet';
  if (/Kindle|Silk\//i.test(ua)) return 'tablet';

  // 手机。
  if (/iPhone|iPod/i.test(ua)) return 'mobile';
  if (/Android/i.test(ua) && /Mobile/i.test(ua)) return 'mobile';
  if (/Windows Phone|IEMobile|BlackBerry|BB10|Opera Mini/i.test(ua)) return 'mobile';
  if (/\bMobi\b/i.test(ua)) return 'mobile';

  // 桌面：UA 里能认出桌面系统就算桌面。
  if (os !== null) {
    const desktopOs = new Set(['Windows', 'macOS', 'Linux', 'Chrome OS', 'FreeBSD']);
    return desktopOs.has(os.name) ? 'desktop' : 'other';
  }
  return 'other';
}

/** 解析一条 UA。空串返回全空结果（页面显示「—」）。 */
export function parseUserAgent(ua: string): UserAgentInfo {
  const text = ua.trim();
  if (text === '') {
    return { browser: null, engine: null, os: null, device: 'other' };
  }

  const os = detectOs(text);
  const bot = detectBot(text);
  const browser = bot ?? detectBrowser(text);
  const engine = detectEngine(text, browser, os?.name === 'iOS');
  const device = detectDevice(text, browser, os);

  return { browser, engine, os, device };
}

/** 把解析结果摊成页面上的键值行（缺失显示「—」）。 */
export function userAgentRows(info: UserAgentInfo): UserAgentRow[] {
  const dash = '—';
  return [
    { label: '浏览器', value: info.browser ? info.browser.name : dash },
    { label: '浏览器版本', value: info.browser?.version ? info.browser.version : dash },
    { label: '渲染引擎', value: info.engine ? info.engine.name : dash },
    { label: '引擎版本', value: info.engine?.version ? info.engine.version : dash },
    { label: '操作系统', value: info.os ? info.os.name : dash },
    { label: '系统版本', value: info.os?.version ? info.os.version : dash },
    { label: '设备类型', value: UA_DEVICE_LABELS[info.device] },
  ];
}
