// ─────────────────────────────────────────────────────────────────────────────
// mime.ts —— 「MIME 类型查询」的静态数据与双向查询
//
// 【数据从哪来、口径是什么】
//   · `mime` 优先用 IANA 注册值（`application/vnd.rar`、`font/woff2`）；
//   · 同一类型有历史遗留写法时**两条都保留**（`image/x-icon` 与
//     `image/vnd.microsoft.icon`、`application/x-zip-compressed` 与 `application/zip`），
//     并各自在 `note` 里说明谁新谁旧 —— 只看一条会让「服务器实际发的是旧写法」查不到；
//   · `charset` 只在**文本类**上标注（`text/*`、`application/json`、`application/xml`），
//     二进制类型不写（写了也没意义）；
//   · 非 IANA 注册但在工具链里广泛使用的类型（`text/x-python`、`application/typescript`）
//     照收，`note` 里写明「非标准」，不假装它们有规范依据。
//
// 【查询语义】
//   · `mimeByExtension('png')` / `mimeByType('image/png')` 是**精确**查询，单测用；
//   · `searchMimeTypes(query)` 是页面搜索：带 `/` 的按 MIME 子串匹配，否则按扩展名
//     精确/前缀匹配，外加 MIME 与备注的子串匹配 —— 输 `png`、`.png`、`image`、
//     `image/png` 都能命中。
//   · 零依赖：客户端组件与 node 单测共用这一份。
// ─────────────────────────────────────────────────────────────────────────────

export type MimeCategory =
  | 'image'
  | 'audio'
  | 'video'
  | 'document'
  | 'font'
  | 'archive'
  | 'web'
  | 'code'
  | 'data'
  | 'other';

export interface MimeDef {
  mime: string;
  /** 扩展名，不带点、小写。没有固定扩展名的类型（如表单编码）为空数组。 */
  ext: readonly string[];
  category: MimeCategory;
  /** 补充说明：charset 适用、新旧写法、是否非标准等。 */
  note?: string;
}

export const MIME_CATEGORIES: ReadonlyArray<{ key: MimeCategory; label: string }> = [
  { key: 'image', label: '图片' },
  { key: 'audio', label: '音频' },
  { key: 'video', label: '视频' },
  { key: 'document', label: '文档' },
  { key: 'font', label: '字体' },
  { key: 'archive', label: '压缩包' },
  { key: 'web', label: 'Web' },
  { key: 'code', label: '编程' },
  { key: 'data', label: '数据' },
  { key: 'other', label: '其他' },
];

export const MIME_TYPES: readonly MimeDef[] = [
  // ── 图片 ──────────────────────────────────────────────────────────────────
  { mime: 'image/jpeg', ext: ['jpg', 'jpeg', 'jpe', 'jfif'], category: 'image', note: '有损照片格式；EXIF 可携带拍摄信息' },
  { mime: 'image/png', ext: ['png'], category: 'image', note: '无损、支持透明通道' },
  { mime: 'image/gif', ext: ['gif'], category: 'image', note: '支持动图，最多 256 色' },
  { mime: 'image/webp', ext: ['webp'], category: 'image', note: '有损/无损失与透明都支持' },
  { mime: 'image/avif', ext: ['avif'], category: 'image', note: 'AV1 编码，压缩率高，兼容性较新' },
  { mime: 'image/svg+xml', ext: ['svg'], category: 'image', note: 'XML 矢量图；可内嵌脚本，引用外部 SVG 前要净化' },
  { mime: 'image/bmp', ext: ['bmp'], category: 'image', note: '无压缩位图，体积大' },
  { mime: 'image/tiff', ext: ['tif', 'tiff'], category: 'image', note: '印刷/扫描常用，多页需专门处理' },
  { mime: 'image/x-icon', ext: ['ico'], category: 'image', note: 'ICO 图标的常见旧写法' },
  { mime: 'image/vnd.microsoft.icon', ext: ['ico'], category: 'image', note: 'ICO 图标的 IANA 注册写法' },
  { mime: 'image/apng', ext: ['apng'], category: 'image', note: '动画 PNG，部分平台兼容性一般' },
  { mime: 'image/heic', ext: ['heic'], category: 'image', note: 'Apple 高效图像（HEIF 的 HEVC 变体）' },
  { mime: 'image/heif', ext: ['heif'], category: 'image', note: 'HEIF 容器，可能含 HEVC / AV1 等编码' },
  { mime: 'image/jxl', ext: ['jxl'], category: 'image', note: 'JPEG XL，压缩率与渐进解码更好' },
  { mime: 'image/x-portable-pixmap', ext: ['ppm'], category: 'image', note: 'Netpbm 格式，常见于图像处理工具' },
  { mime: 'image/x-xbitmap', ext: ['xbm'], category: 'image', note: 'X11 位图，文本形式' },
  { mime: 'image/x-tga', ext: ['tga'], category: 'image', note: 'Targa，游戏纹理常用' },

  // ── 音频 ──────────────────────────────────────────────────────────────────
  { mime: 'audio/mpeg', ext: ['mp3', 'mpga'], category: 'audio', note: 'MP3 有损音频（MPEG 音频层 III）' },
  { mime: 'audio/mp4', ext: ['m4a', 'mp4a'], category: 'audio', note: 'MP4 音频容器，通常装 AAC' },
  { mime: 'audio/aac', ext: ['aac'], category: 'audio', note: 'ADTS 裸 AAC 流' },
  { mime: 'audio/ogg', ext: ['ogg', 'oga'], category: 'audio', note: 'Ogg 容器（Vorbis / Opus）' },
  { mime: 'audio/opus', ext: ['opus'], category: 'audio', note: 'Opus 音频，常封装在 Ogg / WebM 中' },
  { mime: 'audio/wav', ext: ['wav'], category: 'audio', note: 'RIFF 未压缩或无损 PCM' },
  { mime: 'audio/webm', ext: ['weba'], category: 'audio', note: 'WebM 容器里的音频' },
  { mime: 'audio/flac', ext: ['flac'], category: 'audio', note: '无损压缩音频' },
  { mime: 'audio/midi', ext: ['mid', 'midi'], category: 'audio', note: 'MIDI 指令流，不是音频波形' },
  { mime: 'audio/x-midi', ext: ['mid', 'midi'], category: 'audio', note: 'MIDI 的常见旧写法' },
  { mime: 'audio/3gpp', ext: ['3gp', '3ga'], category: 'audio', note: '3GPP 容器音频' },
  { mime: 'audio/amr', ext: ['amr'], category: 'audio', note: 'AMR 窄带语音编码' },

  // ── 视频 ──────────────────────────────────────────────────────────────────
  { mime: 'video/mp4', ext: ['mp4', 'm4v'], category: 'video', note: 'H.264 / H.265 等编码的 MP4 容器' },
  { mime: 'video/webm', ext: ['webm'], category: 'video', note: 'VP8 / VP9 / AV1 编码的 Web 视频' },
  { mime: 'video/ogg', ext: ['ogv'], category: 'video', note: 'Ogg 容器视频（Theora）' },
  { mime: 'video/quicktime', ext: ['mov', 'qt'], category: 'video', note: 'Apple QuickTime 容器' },
  { mime: 'video/x-msvideo', ext: ['avi'], category: 'video', note: 'AVI 容器（较旧）' },
  { mime: 'video/x-matroska', ext: ['mkv'], category: 'video', note: 'Matroska 容器' },
  { mime: 'video/mpeg', ext: ['mpg', 'mpeg', 'mpe'], category: 'video', note: 'MPEG-1 / MPEG-2 视频' },
  { mime: 'video/3gpp', ext: ['3gp'], category: 'video', note: '3GPP 移动视频' },
  { mime: 'video/x-flv', ext: ['flv'], category: 'video', note: 'Flash 视频（已淘汰）' },
  { mime: 'video/x-ms-wmv', ext: ['wmv'], category: 'video', note: 'Windows Media Video' },
  { mime: 'video/mp2t', ext: ['ts', 'm2ts'], category: 'video', note: 'MPEG-TS 传输流（HLS / 直播）' },
  { mime: 'application/vnd.apple.mpegurl', ext: ['m3u8'], category: 'video', note: 'HLS 播放列表（文本清单）' },

  // ── 文档 ──────────────────────────────────────────────────────────────────
  { mime: 'application/pdf', ext: ['pdf'], category: 'document', note: 'PDF 文档；可含表单与脚本' },
  { mime: 'application/msword', ext: ['doc', 'dot'], category: 'document', note: 'Word 97–2003 二进制文档' },
  {
    mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ext: ['docx'],
    category: 'document',
    note: 'Word 2007+（OOXML，本质是 ZIP）',
  },
  { mime: 'application/vnd.ms-excel', ext: ['xls', 'xlt'], category: 'document', note: 'Excel 97–2003 二进制工作簿' },
  {
    mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ext: ['xlsx'],
    category: 'document',
    note: 'Excel 2007+（OOXML）',
  },
  { mime: 'application/vnd.ms-powerpoint', ext: ['ppt', 'pot'], category: 'document', note: 'PowerPoint 97–2003 二进制演示文稿' },
  {
    mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    ext: ['pptx'],
    category: 'document',
    note: 'PowerPoint 2007+（OOXML）',
  },
  { mime: 'application/vnd.oasis.opendocument.text', ext: ['odt'], category: 'document', note: 'LibreOffice 文本文档' },
  { mime: 'application/vnd.oasis.opendocument.spreadsheet', ext: ['ods'], category: 'document', note: 'LibreOffice 电子表格' },
  { mime: 'application/vnd.oasis.opendocument.presentation', ext: ['odp'], category: 'document', note: 'LibreOffice 演示文稿' },
  { mime: 'application/rtf', ext: ['rtf'], category: 'document', note: '富文本格式（纯文本语法）' },
  { mime: 'text/plain', ext: ['txt', 'text', 'log'], category: 'document', note: '纯文本；建议带 charset=utf-8' },
  { mime: 'text/markdown', ext: ['md', 'markdown'], category: 'document', note: '非 IANA 注册，由 CommonMark 社区沿用' },
  { mime: 'text/csv', ext: ['csv'], category: 'document', note: '逗号分隔值；建议带 charset=utf-8' },
  { mime: 'text/tab-separated-values', ext: ['tsv'], category: 'document', note: '制表符分隔值' },
  { mime: 'text/calendar', ext: ['ics'], category: 'document', note: 'iCalendar 日程' },
  { mime: 'text/vcard', ext: ['vcf'], category: 'document', note: 'vCard 名片' },
  { mime: 'application/epub+zip', ext: ['epub'], category: 'document', note: 'EPUB 电子书（ZIP 容器）' },
  { mime: 'message/rfc822', ext: ['eml'], category: 'document', note: '完整邮件（含头与正文）' },
  { mime: 'application/vnd.ms-outlook', ext: ['msg'], category: 'document', note: 'Outlook 邮件文件' },
  { mime: 'text/x-subrip', ext: ['srt'], category: 'document', note: 'SubRip 字幕（非标准）' },
  { mime: 'text/vtt', ext: ['vtt'], category: 'document', note: 'WebVTT 字幕' },

  // ── 字体 ──────────────────────────────────────────────────────────────────
  { mime: 'font/woff', ext: ['woff'], category: 'font', note: 'Web Open Font Format 1' },
  { mime: 'font/woff2', ext: ['woff2'], category: 'font', note: 'WOFF 2，压缩率更高，现代浏览器首选' },
  { mime: 'font/ttf', ext: ['ttf'], category: 'font', note: 'TrueType 字体' },
  { mime: 'font/otf', ext: ['otf'], category: 'font', note: 'OpenType 字体' },
  { mime: 'font/collection', ext: ['ttc'], category: 'font', note: 'TrueType / OpenType 字体集合' },
  { mime: 'application/font-woff', ext: ['woff'], category: 'font', note: '旧写法，已被 font/woff 取代' },
  { mime: 'application/vnd.ms-fontobject', ext: ['eot'], category: 'font', note: 'IE 时代的嵌入字体' },
  { mime: 'application/x-font-ttf', ext: ['ttf'], category: 'font', note: '旧写法，已被 font/ttf 取代' },

  // ── 压缩包 ────────────────────────────────────────────────────────────────
  { mime: 'application/zip', ext: ['zip'], category: 'archive', note: 'ZIP 压缩包（也是 OOXML / EPUB 的容器）' },
  { mime: 'application/x-zip-compressed', ext: ['zip'], category: 'archive', note: 'Windows 上常见的 ZIP 旧写法' },
  { mime: 'application/x-rar-compressed', ext: ['rar'], category: 'archive', note: 'RAR 的旧写法' },
  { mime: 'application/vnd.rar', ext: ['rar'], category: 'archive', note: 'RAR 的 IANA 注册写法' },
  { mime: 'application/x-7z-compressed', ext: ['7z'], category: 'archive', note: '7-Zip 压缩包' },
  { mime: 'application/x-tar', ext: ['tar'], category: 'archive', note: 'tar 打包（本身不压缩）' },
  { mime: 'application/gzip', ext: ['gz'], category: 'archive', note: 'gzip 单文件压缩，不打包；常与 tar 组合' },
  { mime: 'application/x-gzip', ext: ['gz'], category: 'archive', note: 'gzip 的旧写法' },
  { mime: 'application/x-bzip2', ext: ['bz2'], category: 'archive', note: 'bzip2 压缩' },
  { mime: 'application/x-xz', ext: ['xz'], category: 'archive', note: 'xz 压缩' },
  { mime: 'application/zstd', ext: ['zst'], category: 'archive', note: 'Zstandard 压缩' },
  { mime: 'application/vnd.android.package-archive', ext: ['apk'], category: 'archive', note: 'Android 安装包（ZIP 容器）' },
  { mime: 'application/java-archive', ext: ['jar'], category: 'archive', note: 'Java 归档（ZIP 容器）' },
  { mime: 'application/x-iso9660-image', ext: ['iso'], category: 'archive', note: '光盘镜像' },
  { mime: 'application/x-apple-diskimage', ext: ['dmg'], category: 'archive', note: 'macOS 磁盘映像' },

  // ── Web ───────────────────────────────────────────────────────────────────
  { mime: 'text/html', ext: ['html', 'htm'], category: 'web', note: 'HTML 文档；charset 决定解码方式' },
  { mime: 'text/css', ext: ['css'], category: 'web', note: '层叠样式表；建议带 charset=utf-8' },
  { mime: 'text/javascript', ext: ['js', 'mjs'], category: 'web', note: '规范推荐的 JS 类型；旧代码常见 application/javascript' },
  { mime: 'application/javascript', ext: ['js', 'mjs'], category: 'web', note: '旧写法，规范已推荐 text/javascript' },
  { mime: 'application/json', ext: ['json'], category: 'web', note: 'charset 无意义：JSON 规范规定 UTF-8' },
  { mime: 'application/ld+json', ext: ['jsonld'], category: 'web', note: 'schema.org 结构化数据' },
  { mime: 'application/manifest+json', ext: ['webmanifest'], category: 'web', note: 'PWA Web App Manifest' },
  { mime: 'application/xml', ext: ['xml'], category: 'web', note: 'XML；charset 影响解析' },
  { mime: 'text/xml', ext: ['xml'], category: 'web', note: 'XML 的旧写法' },
  { mime: 'application/xhtml+xml', ext: ['xhtml'], category: 'web', note: 'XHTML（按 XML 规则解析）' },
  { mime: 'application/wasm', ext: ['wasm'], category: 'web', note: 'WebAssembly 二进制模块' },
  { mime: 'text/event-stream', ext: [], category: 'web', note: 'Server-Sent Events 流；无固定扩展名' },
  { mime: 'multipart/form-data', ext: [], category: 'web', note: '表单文件上传；boundary 由请求头给出' },
  { mime: 'application/x-www-form-urlencoded', ext: [], category: 'web', note: '普通表单提交编码；无扩展名' },
  { mime: 'application/problem+json', ext: [], category: 'web', note: 'RFC 9457 错误响应' },
  { mime: 'application/rss+xml', ext: ['rss'], category: 'web', note: 'RSS 订阅源' },
  { mime: 'application/atom+xml', ext: ['atom'], category: 'web', note: 'Atom 订阅源' },
  { mime: 'application/rdf+xml', ext: ['rdf'], category: 'web', note: 'RDF / XML' },

  // ── 编程 ──────────────────────────────────────────────────────────────────
  { mime: 'application/typescript', ext: ['ts'], category: 'code', note: '非标准注册类型，常见于工具链' },
  { mime: 'text/x-typescript', ext: ['ts', 'tsx'], category: 'code', note: '非标准；tsx 也常被这样标注' },
  { mime: 'text/x-python', ext: ['py'], category: 'code', note: '非标准写法' },
  { mime: 'text/x-java-source', ext: ['java'], category: 'code', note: '非标准写法' },
  { mime: 'text/x-c', ext: ['c', 'h', 'cpp', 'hpp'], category: 'code', note: '非标准写法（C / C++ 共用）' },
  { mime: 'text/x-csharp', ext: ['cs'], category: 'code', note: '非标准写法' },
  { mime: 'text/x-php', ext: ['php'], category: 'code', note: '非标准写法' },
  { mime: 'application/x-httpd-php', ext: ['php'], category: 'code', note: 'PHP 的旧写法' },
  { mime: 'text/x-ruby', ext: ['rb'], category: 'code', note: '非标准写法' },
  { mime: 'text/x-shellscript', ext: ['sh'], category: 'code', note: '非标准写法' },
  { mime: 'application/x-sh', ext: ['sh'], category: 'code', note: 'Shell 脚本的旧写法' },
  { mime: 'text/x-go', ext: ['go'], category: 'code', note: '非标准写法' },
  { mime: 'text/x-rust', ext: ['rs'], category: 'code', note: '非标准写法' },
  { mime: 'application/sql', ext: ['sql'], category: 'code', note: 'IANA 注册的 SQL 类型' },
  { mime: 'text/x-sql', ext: ['sql'], category: 'code', note: 'SQL 的常见非标准写法' },
  { mime: 'text/x-diff', ext: ['diff', 'patch'], category: 'code', note: '补丁 / 差异文本' },

  // ── 数据 ──────────────────────────────────────────────────────────────────
  { mime: 'application/yaml', ext: ['yaml', 'yml'], category: 'data', note: 'YAML（RFC 9512 注册）' },
  { mime: 'application/x-yaml', ext: ['yaml', 'yml'], category: 'data', note: 'YAML 的旧写法' },
  { mime: 'text/x-yaml', ext: ['yaml', 'yml'], category: 'data', note: 'YAML 的另一种旧写法' },
  { mime: 'application/toml', ext: ['toml'], category: 'data', note: 'TOML 配置格式' },
  { mime: 'application/x-ndjson', ext: ['ndjson', 'jsonl'], category: 'data', note: '每行一个 JSON 对象' },
  { mime: 'application/geo+json', ext: ['geojson'], category: 'data', note: 'GeoJSON 地理数据' },
  { mime: 'application/x-protobuf', ext: ['proto', 'pb'], category: 'data', note: 'Protocol Buffers（非标准）' },
  { mime: 'application/x-sqlite3', ext: ['sqlite', 'sqlite3', 'db'], category: 'data', note: 'SQLite 数据库文件（非标准）' },
  { mime: 'application/x-parquet', ext: ['parquet'], category: 'data', note: '列式存储文件（非标准）' },
  { mime: 'application/x-msgpack', ext: ['msgpack'], category: 'data', note: 'MessagePack（非标准）' },
  { mime: 'application/x-pem-file', ext: ['pem'], category: 'data', note: 'PEM 文本容器（证书 / 私钥）' },
  { mime: 'application/x-x509-ca-cert', ext: ['crt', 'cer', 'der'], category: 'data', note: 'X.509 证书' },
  { mime: 'application/vnd.google-earth.kml+xml', ext: ['kml'], category: 'data', note: 'KML 地理标注' },
  { mime: 'application/vnd.google-earth.kmz', ext: ['kmz'], category: 'data', note: 'KMZ（KML 的 ZIP 容器）' },
  { mime: 'application/x-bittorrent', ext: ['torrent'], category: 'data', note: 'BitTorrent 种子文件' },
  { mime: 'application/dash+xml', ext: ['mpd'], category: 'data', note: 'MPEG-DASH 清单' },

  // ── 其他 ──────────────────────────────────────────────────────────────────
  { mime: 'application/octet-stream', ext: ['bin', 'dat'], category: 'other', note: '未知二进制的兜底类型；别用它替代明确类型' },
  { mime: 'application/x-msdownload', ext: ['exe', 'dll'], category: 'other', note: 'Windows 可执行文件 / 动态库（旧写法）' },
  { mime: 'application/pgp-signature', ext: ['asc', 'sig'], category: 'other', note: 'PGP 签名' },
  { mime: 'application/pkcs7-mime', ext: ['p7m', 'p7c'], category: 'other', note: 'S/MIME 加密或签名数据' },
];

/** 规范化扩展名：去点、去空白、转小写。 */
export function normalizeExtension(input: string): string {
  return input.trim().replace(/^\.+/, '').toLowerCase();
}

/** 精确按扩展名查（可能多条：同一扩展名有新/旧写法）。 */
export function mimeByExtension(extension: string): MimeDef[] {
  const ext = normalizeExtension(extension);
  if (ext === '') return [];
  return MIME_TYPES.filter((entry) => entry.ext.includes(ext));
}

/** 精确按 MIME 类型查（大小写不敏感，忽略参数部分）。 */
export function mimeByType(mime: string): MimeDef[] {
  const normalized = mime.split(';')[0].trim().toLowerCase();
  if (normalized === '') return [];
  return MIME_TYPES.filter((entry) => entry.mime.toLowerCase() === normalized);
}

/**
 * 页面搜索：扩展名、MIME 或备注任意命中。
 *
 * 带 `/` 的查询按 MIME 子串匹配（`application/json` 精确，`json` 不会走这一支）；
 * 否则按扩展名精确/前缀匹配 + MIME / 备注子串匹配。
 */
export function searchMimeTypes(query: string, category?: MimeCategory): MimeDef[] {
  const q = query.trim().toLowerCase();
  return MIME_TYPES.filter((entry) => {
    if (category !== undefined && entry.category !== category) return false;
    if (q === '') return true;
    if (q.includes('/')) {
      return entry.mime.toLowerCase().includes(q);
    }
    const extQuery = normalizeExtension(q);
    if (extQuery !== '' && entry.ext.some((ext) => ext === extQuery || ext.startsWith(extQuery))) {
      return true;
    }
    return entry.mime.toLowerCase().includes(q) || (entry.note ?? '').toLowerCase().includes(q);
  });
}

/** 每个分类的条目数（分类筛选旁显示计数）。 */
export function mimeCategoryCounts(): Record<MimeCategory, number> {
  const counts = Object.fromEntries(MIME_CATEGORIES.map((c) => [c.key, 0])) as Record<MimeCategory, number>;
  for (const entry of MIME_TYPES) counts[entry.category] += 1;
  return counts;
}
