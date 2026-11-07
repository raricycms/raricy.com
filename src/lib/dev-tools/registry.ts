// ─────────────────────────────────────────────────────────────────────────────
// registry.ts — 开发者工具合集（/tool/dev）的唯一真相源
//
// 【为什么单独一个**零依赖**模块】
//   · 合集首页是客户端组件（搜索 / 分类筛选），它要这份清单；
//   · 每个工具页要用自己的标题与说明生成 metadata；
//   · 单元测试要静态对账「清单里的每一项都真的有页面」，不能拖进 React / Next / prisma。
// 所以这里只有纯数据与纯函数，**一个 import 都没有**。
//
// 【新增一个工具 = 两件事】
//   1. 在 DEV_TOOLS 里加一行（slug / 分类 / 图标 / 标题 / 说明 / 关键词 / 标签）；
//   2. 建 `src/app/tool/dev/<slug>/page.tsx`（服务端壳 + 客户端组件）。
// `tests/unit/dev-tools-registry.test.ts` 会对账「清单 ↔ 路由目录」**双向一致**：
// 清单里多一行会因缺页面转红，多一个页面目录也会因未登记转红。
//
// 【两种 href】
//   · 新工具：`/tool/dev/<slug>`（legacy 省略）；
//   · 既有工具（Base / Hex / URL 编码 / HTML 编码 / Quoted-printable / 哈希 / AES）：
//     `legacy: true`，href 是**原有的** `/tool/<slug>` —— 合集只是索引它们，不搬家，
//     旧链接、文档与站外引用因此都不用改。
// ─────────────────────────────────────────────────────────────────────────────

export type DevToolCategoryKey = 'data' | 'code' | 'time' | 'web' | 'qr' | 'codec' | 'ref';

/** 分类的顺序就是合集首页的展示顺序。 */
export const DEV_TOOL_CATEGORIES: ReadonlyArray<{ key: DevToolCategoryKey; label: string }> = [
  { key: 'data', label: '数据与格式' },
  { key: 'code', label: '代码与文本' },
  { key: 'time', label: '时间与标识' },
  { key: 'web', label: '网络与链接' },
  { key: 'qr', label: '二维码与条码' },
  { key: 'codec', label: '编码与加密' },
  { key: 'ref', label: '速查参考' },
];

/**
 * 图标名。存**字符串**而不是组件本身，理由同上：这个模块要能被 node 单测直接 import。
 * 合集首页把它映射到 lucide-react 组件；映射表是 `Record<DevToolIconName, LucideIcon>`，
 * 所以这里加一个名字而首页没跟上时 tsc 会报错。
 */
export const DEV_TOOL_ICON_NAMES = [
  'FileJson',
  'ListTree',
  'Route',
  'ArrowRightLeft',
  'GitCompare',
  'Regex',
  'Database',
  'Code2',
  'Type',
  'Palette',
  'Clock',
  'CalendarClock',
  'KeyRound',
  'Fingerprint',
  'SlidersHorizontal',
  'Megaphone',
  'ListFilter',
  'Globe',
  'Network',
  'RadioTower',
  'Server',
  'QrCode',
  'ScanQrCode',
  'Barcode',
  'Braces',
  'Binary',
  'Link2',
  'Code',
  'Mail',
  'Hash',
  'Lock',
  'Info',
  'FileType',
  'MonitorSmartphone',
] as const;

export type DevToolIconName = (typeof DEV_TOOL_ICON_NAMES)[number];

/** 新工具的路由段（`/tool/dev/<slug>`）；既有工具不在此列。 */
export type DevToolSlug =
  | 'json'
  | 'json-tree'
  | 'json-path'
  | 'data-convert'
  | 'diff'
  | 'regex'
  | 'sql'
  | 'code'
  | 'text'
  | 'color'
  | 'timestamp'
  | 'cron'
  | 'jwt'
  | 'uuid'
  | 'url-params'
  | 'utm'
  | 'extract-urls'
  | 'ip'
  | 'subnet'
  | 'dns'
  | 'http-headers'
  | 'qrcode'
  | 'qrcode-read'
  | 'barcode'
  | 'http-status'
  | 'mime'
  | 'user-agent';

export interface DevToolDef {
  /** 路由段。新工具 → `/tool/dev/<slug>`；既有工具 → `/tool/<slug>`（配 legacy）。 */
  slug: string;
  /** 既有工具：href 走 `/tool/<slug>`，页面与 metadata 都不归合集管。 */
  legacy?: boolean;
  category: DevToolCategoryKey;
  icon: DevToolIconName;
  title: string;
  /** 一句能说清「它做什么、和邻居的区别在哪」的说明，别写形容词。 */
  desc: string;
  /** 搜索用：英文缩写、别名、中文同义词都放进来（大小写不敏感）。 */
  keywords: string;
  tags: readonly string[];
}

export const DEV_TOOLS: readonly DevToolDef[] = [
  // ── 数据与格式 ────────────────────────────────────────────────────────────
  {
    slug: 'json',
    category: 'data',
    icon: 'FileJson',
    title: 'JSON 格式化与校验',
    desc: '格式化、压缩与校验 JSON，语法错误定位到行列',
    keywords: 'json 格式化 美化 压缩 校验 验证 语法错误 jsonlint format validate minify pretty',
    tags: ['格式化', '校验', '压缩'],
  },
  {
    slug: 'json-tree',
    category: 'data',
    icon: 'ListTree',
    title: 'JSON 树形查看器',
    desc: '把 JSON 展开成可折叠的树，逐层查看数组与对象',
    keywords: 'json 树 tree 折叠 展开 查看器 结构 viewer 层级',
    tags: ['树形', '折叠', '浏览'],
  },
  {
    slug: 'json-path',
    category: 'data',
    icon: 'Route',
    title: 'JSON 路径查询',
    desc: '用 JSONPath 或点号路径取值，列出所有命中位置',
    keywords: 'jsonpath json path 路径 查询 提取 取值 query jq',
    tags: ['JSONPath', '查询', '提取'],
  },
  {
    slug: 'data-convert',
    category: 'data',
    icon: 'ArrowRightLeft',
    title: '数据转换',
    desc: 'JSON / YAML / CSV 互转，表格数据可直接粘贴',
    keywords: 'json yaml yml csv 转换 convert 表格 数据',
    tags: ['YAML', 'CSV', '互转'],
  },
  {
    slug: 'diff',
    category: 'data',
    icon: 'GitCompare',
    title: '文本 Diff',
    desc: '逐行对比两段文本，标出新增、删除与改动',
    keywords: 'diff 对比 比较 文本 差异 compare patch 逐行',
    tags: ['对比', '逐行', '差异'],
  },

  // ── 代码与文本 ────────────────────────────────────────────────────────────
  {
    slug: 'regex',
    category: 'code',
    icon: 'Regex',
    title: '正则表达式测试',
    desc: '实时高亮匹配、列出捕获组，支持替换与常用标志',
    keywords: 'regex regexp 正则 表达式 匹配 捕获组 替换 test',
    tags: ['正则', '匹配', '替换'],
  },
  {
    slug: 'sql',
    category: 'code',
    icon: 'Database',
    title: 'SQL 格式化',
    desc: '按关键字与子句缩进 SQL，支持 MySQL / PostgreSQL 等方言',
    keywords: 'sql 格式化 美化 缩进 mysql postgresql sqlite 方言 format',
    tags: ['SQL', '缩进', '方言'],
  },
  {
    slug: 'code',
    category: 'code',
    icon: 'Code2',
    title: '代码格式化',
    desc: '格式化 JavaScript / TypeScript / JSON / CSS / HTML / XML 的缩进与换行',
    keywords: '代码 格式化 js javascript css html xml 缩进 format prettify',
    tags: ['JS', 'CSS', 'HTML'],
  },
  {
    slug: 'text',
    category: 'code',
    icon: 'Type',
    title: '文本工具',
    desc: '统计字数行数、转换大小写、排序去重与清理空白',
    keywords: '文本 统计 字数 行数 词频 大小写 排序 去重 空白 清理 text count case',
    tags: ['统计', '大小写', '去重'],
  },
  {
    slug: 'color',
    category: 'code',
    icon: 'Palette',
    title: '颜色转换',
    desc: 'HEX / RGB / HSL 互转，并给出对比度与预览',
    keywords: '颜色 color hex rgb hsl 对比度 色值 转换 contrast',
    tags: ['HEX', 'RGB', 'HSL'],
  },

  // ── 时间与标识 ────────────────────────────────────────────────────────────
  {
    slug: 'timestamp',
    category: 'time',
    icon: 'Clock',
    title: '时间戳转换',
    desc: 'Unix 时间戳与日期互转，同时显示多个时区',
    keywords: '时间戳 timestamp unix 秒 毫秒 日期 时区 转换',
    tags: ['Unix', '时区', '毫秒'],
  },
  {
    slug: 'cron',
    category: 'time',
    icon: 'CalendarClock',
    title: 'Cron 表达式解析',
    desc: '解释 Cron 表达式含义，列出接下来几次执行时间',
    keywords: 'cron crontab 表达式 解析 定时 任务 下次执行',
    tags: ['Cron', '定时', '下次执行'],
  },
  {
    slug: 'jwt',
    category: 'time',
    icon: 'KeyRound',
    title: 'JWT 解析',
    desc: '解码 JWT 的头部与载荷，检查过期时间与签名算法',
    keywords: 'jwt token 解析 解码 base64 过期 exp 签名',
    tags: ['JWT', '解码', '过期'],
  },
  {
    slug: 'uuid',
    category: 'time',
    icon: 'Fingerprint',
    title: 'UUID 生成器',
    desc: '生成 UUID v4 / v7，支持批量复制',
    keywords: 'uuid guid 生成 批量 v4 v7 唯一 id',
    tags: ['UUID', '批量', 'v4'],
  },

  // ── 网络与链接 ────────────────────────────────────────────────────────────
  {
    slug: 'url-params',
    category: 'web',
    icon: 'SlidersHorizontal',
    title: 'URL 参数解析与编辑',
    desc: '拆解 URL 的查询参数，逐项编辑后重新拼回',
    keywords: 'url 参数 query 查询 解析 编辑 编码 parse',
    tags: ['URL', '查询参数', '编辑'],
  },
  {
    slug: 'utm',
    category: 'web',
    icon: 'Megaphone',
    title: 'UTM 链接生成器',
    desc: '拼出带 UTM 参数的推广链接',
    keywords: 'utm 链接 推广 营销 campaign source medium 生成',
    tags: ['UTM', '推广', '链接'],
  },
  {
    slug: 'extract-urls',
    category: 'web',
    icon: 'ListFilter',
    title: '网址批量提取',
    desc: '从文本中批量提取、去重并规范化网址',
    keywords: '网址 url 提取 批量 去重 link extract',
    tags: ['提取', '去重', '批量'],
  },
  {
    slug: 'ip',
    category: 'web',
    icon: 'Globe',
    title: 'IP 地址信息查询',
    desc: '查询 IP 的归属地、ASN 与运营商，可查本机出口 IP',
    keywords: 'ip 地址 归属地 查询 asn 运营商 位置 geo',
    tags: ['IP', '归属地', 'ASN'],
  },
  {
    slug: 'subnet',
    category: 'web',
    icon: 'Network',
    title: '子网计算器',
    desc: '计算 CIDR 的网络地址、广播地址与可用主机范围',
    keywords: '子网 subnet cidr ipv4 ipv6 掩码 网络地址 广播',
    tags: ['子网', 'CIDR', 'IPv4'],
  },
  {
    slug: 'dns',
    category: 'web',
    icon: 'RadioTower',
    title: 'DNS 查询',
    desc: '通过 DNS over HTTPS 查询 A / AAAA / MX / TXT 等记录',
    keywords: 'dns 查询 解析 doh a aaaa mx txt ns cname',
    tags: ['DNS', 'DoH', '解析'],
  },
  {
    slug: 'http-headers',
    category: 'web',
    icon: 'Server',
    title: '网站响应头查看',
    desc: '读取网址的 HTTP 状态与响应头（由本站服务端发起请求）',
    keywords: 'http 响应头 header 状态码 网站 请求 查看',
    tags: ['HTTP', '响应头', '状态码'],
  },

  // ── 二维码与条码 ──────────────────────────────────────────────────────────
  {
    slug: 'qrcode',
    category: 'qr',
    icon: 'QrCode',
    title: '二维码生成器',
    desc: '把文本或链接生成二维码，可调尺寸与纠错级别',
    keywords: '二维码 qr qrcode 生成 扫码 png svg 图片',
    tags: ['二维码', 'PNG', 'SVG'],
  },
  {
    slug: 'qrcode-read',
    category: 'qr',
    icon: 'ScanQrCode',
    title: '二维码识别',
    desc: '上传或拖入二维码图片，识别其中的文本与链接',
    keywords: '二维码 识别 扫码 解码 qr 图片 decode',
    tags: ['识别', '图片', '扫码'],
  },
  {
    slug: 'barcode',
    category: 'qr',
    icon: 'Barcode',
    title: '条形码生成器',
    desc: '生成 EAN-13 / Code 128 / Code 39 条形码并导出 SVG',
    keywords: '条形码 条码 barcode ean13 code128 code39 生成 svg',
    tags: ['EAN-13', 'Code128', 'SVG'],
  },

  // ── 编码与加密（既有页面，合集只做索引）────────────────────────────────────
  {
    slug: 'base',
    legacy: true,
    category: 'codec',
    icon: 'Braces',
    title: 'Base 编码',
    desc: 'Base16 / 32 / 36 / 58 / 62 / 64 / 85 / 91 / 92',
    keywords: 'base base16 base32 base36 base58 base62 base64 base85 base91 base92 编码 解码',
    tags: ['Base64', 'Base58', '+7'],
  },
  {
    slug: 'hex',
    legacy: true,
    category: 'codec',
    icon: 'Binary',
    title: 'Hex 编码',
    desc: '十六进制与字节流互转',
    keywords: 'hex 十六进制 字节 bytes 文件 查看 编辑',
    tags: ['Hex', 'Bytes'],
  },
  {
    slug: 'url',
    legacy: true,
    category: 'codec',
    icon: 'Link2',
    title: 'URL 编码',
    desc: 'URL 百分号编码 / 解码',
    keywords: 'url 编码 解码 percent query',
    tags: ['URL', 'Web', '编码'],
  },
  {
    slug: 'html',
    legacy: true,
    category: 'codec',
    icon: 'Code',
    title: 'HTML 编码',
    desc: 'HTML 实体编码 / 解码，支持常用符号和特殊字符',
    keywords: 'html 实体 entity 转义 escape',
    tags: ['Entity', 'Escape'],
  },
  {
    slug: 'qp',
    legacy: true,
    category: 'codec',
    icon: 'Mail',
    title: 'Quoted-printable',
    desc: '邮件 MIME Quoted-Printable 编 / 解码',
    keywords: 'quoted-printable mime rfc2045 邮件',
    tags: ['MIME', 'RFC2045'],
  },
  {
    slug: 'hash',
    legacy: true,
    category: 'codec',
    icon: 'Hash',
    title: '哈希计算',
    desc: 'SHA-256 / SHA-1 / SHA-512 / MD5 等',
    keywords: 'hash 哈希 sha sha-1 sha-256 sha-512 md5 hmac 校验',
    tags: ['SHA-256', 'MD5'],
  },
  {
    slug: 'aes',
    legacy: true,
    category: 'codec',
    icon: 'Lock',
    title: 'AES',
    desc: 'AES-CBC / CTR / GCM 加密解密，支持文本或十六进制密钥与自定义 IV / Nonce',
    keywords: 'aes 加密 解密 对称 cbc ctr gcm',
    tags: ['AES', '密钥'],
  },

  // ── 速查参考 ──────────────────────────────────────────────────────────────
  {
    slug: 'http-status',
    category: 'ref',
    icon: 'Info',
    title: 'HTTP 状态码速查',
    desc: '按状态码或关键字查含义与常见原因',
    keywords: 'http 状态码 status code 速查 404 500 301',
    tags: ['HTTP', '状态码', '速查'],
  },
  {
    slug: 'mime',
    category: 'ref',
    icon: 'FileType',
    title: 'MIME 类型查询',
    desc: '按扩展名或 MIME 类型互查',
    keywords: 'mime 类型 扩展名 content type 查询',
    tags: ['MIME', '扩展名', '类型'],
  },
  {
    slug: 'user-agent',
    category: 'ref',
    icon: 'MonitorSmartphone',
    title: 'User-Agent 解析',
    desc: '解析 UA 中的浏览器、内核、系统与设备',
    keywords: 'user agent ua 解析 浏览器 内核 系统 设备',
    tags: ['UA', '浏览器', '设备'],
  },
];

/** 新工具（`/tool/dev/<slug>`）的路由段，按清单顺序。 */
export const DEV_TOOL_SLUGS: readonly DevToolSlug[] = DEV_TOOLS.filter(
  (t) => !t.legacy
).map((t) => t.slug as DevToolSlug);

/** 清单里的一项该指向哪里 —— href 不写进数据，避免和 slug 两份真相漂移。 */
export function devToolHref(tool: Pick<DevToolDef, 'slug' | 'legacy'>): string {
  return tool.legacy ? `/tool/${tool.slug}` : `/tool/dev/${tool.slug}`;
}

/** 按 slug 找（合集首页、工具页外壳共用）。找不到返回 undefined。 */
export function findDevTool(slug: string): DevToolDef | undefined {
  return DEV_TOOLS.find((t) => t.slug === slug);
}

/**
 * 工具页的 metadata：标题统一挂「- 聪明山工具箱」后缀。
 *
 * 找不到就**抛错**（而不是回退成某个默认标题）：调用点是每个 page.tsx 的
 * `export const metadata`，拼错 slug 时构建期就炸，不会静默发出一个标题叫
 * 「聪明山工具箱」的页面。
 */
export function devToolMetadata(slug: DevToolSlug): { title: string; description: string } {
  const tool = findDevTool(slug);
  if (!tool) throw new Error(`开发者工具清单里没有登记：${slug}`);
  return { title: `${tool.title} - 聪明山工具箱`, description: tool.desc };
}
