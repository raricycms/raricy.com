// ─────────────────────────────────────────────────────────────────────────────
// http-status.ts —— 「HTTP 状态码速查」的静态数据与查询
//
// 【为什么是静态表 + 纯函数】速查页不需要联网、不需要服务端；数据是 RFC 7231 / 9110
// 与 IANA 注册表里长期稳定的那些码，写死在代码里比每次请求再取一份可靠，也能被单测
// 逐条核对。零依赖：页面（客户端组件）与单测都能直接 import。
//
// 【字段口径】
//   · `name` 是 IANA 注册的英文名（展示时与 code 并列，便于对照规范与日志）。
//   · `meaning` 是中文含义，一句话说清「这个码表示什么」。
//   · `advice` 是「常见原因 / 处理建议」，写具体动作，不写「请检查配置」这种空话。
//   · `keywords` 放中文同义词（找不到、页面不存在、限流…），搜索用；正文里已有的词
//     不必重复，但同义词不在正文里就必须放进来。
//
// 【分类】1xx–5xx 五档；`category` 用 number 存首位数字，页面筛选与徽章都读它，
// 不要另抄一份字符串分类表。
// ─────────────────────────────────────────────────────────────────────────────

export type HttpStatusCategory = 1 | 2 | 3 | 4 | 5;

export interface HttpStatusDef {
  code: number;
  /** IANA 注册名，例如 `Not Found`。 */
  name: string;
  /** 中文含义。 */
  meaning: string;
  /** 常见原因 / 处理建议。 */
  advice: string;
  /** 搜索用的中文同义词 / 别名。 */
  keywords: string;
}

export const HTTP_STATUS_CATEGORIES: ReadonlyArray<{
  key: HttpStatusCategory;
  label: string;
  summary: string;
}> = [
  { key: 1, label: '1xx 信息响应', summary: '服务器已收到请求，需要客户端继续操作' },
  { key: 2, label: '2xx 成功', summary: '请求已成功被服务器接收、理解并处理' },
  { key: 3, label: '3xx 重定向', summary: '需要客户端进一步操作才能完成请求' },
  { key: 4, label: '4xx 客户端错误', summary: '请求有语法错误或无法完成' },
  { key: 5, label: '5xx 服务端错误', summary: '服务器在执行请求时出错' },
];

export const HTTP_STATUSES: readonly HttpStatusDef[] = [
  // ── 1xx ────────────────────────────────────────────────────────────────────
  {
    code: 100,
    name: 'Continue',
    meaning: '继续：服务器已收到请求头，客户端可以继续发送请求体。',
    advice: '客户端发送 `Expect: 100-continue` 后等待此响应再发正文；若服务器直接回最终状态码，则不要再发正文。',
    keywords: '继续 expect 100-continue 请求体',
  },
  {
    code: 101,
    name: 'Switching Protocols',
    meaning: '切换协议：服务器按 `Upgrade` 请求头切换到另一种协议。',
    advice: '常见于 WebSocket 握手：客户端发 `Upgrade: websocket`，服务器同意后回 101，连接随即改用新协议。',
    keywords: '切换协议 upgrade websocket 升级 握手',
  },
  {
    code: 102,
    name: 'Processing',
    meaning: '处理中：服务器已收到并正在处理请求，但还没有可用响应（WebDAV）。',
    advice: '长耗时操作时用于保活，防止客户端超时；普通 HTTP 请求很少使用。',
    keywords: '处理中 webdav 保活 长耗时',
  },
  {
    code: 103,
    name: 'Early Hints',
    meaning: '早期提示：在最终响应前先返回部分响应头，让客户端提前准备资源。',
    advice: '常配合 `Link: rel=preload` 预加载 CSS/字体；浏览器收到后可以提前发起请求，缩短首屏时间。',
    keywords: '早期提示 early hints preload 预加载 link',
  },

  // ── 2xx ────────────────────────────────────────────────────────────────────
  {
    code: 200,
    name: 'OK',
    meaning: '成功：请求已成功，响应体包含结果。',
    advice: '最常见的结果。若是 API 调用，注意检查响应体里的业务错误字段，HTTP 200 不等于业务成功。',
    keywords: '成功 ok 正常 请求成功',
  },
  {
    code: 201,
    name: 'Created',
    meaning: '已创建：请求成功并新建了资源。',
    advice: '通常用于 POST 创建资源，响应头 `Location` 给出新资源的地址；响应体可带创建后的表示。',
    keywords: '已创建 created 新建 创建成功 post location',
  },
  {
    code: 202,
    name: 'Accepted',
    meaning: '已接受：请求已进入处理流程，但尚未处理完成。',
    advice: '适用于异步任务（排队、后台处理）：告诉客户端稍后再查询进度，别把它当成「已经完成」。',
    keywords: '已接受 accepted 异步 排队 任务 处理中',
  },
  {
    code: 203,
    name: 'Non-Authoritative Information',
    meaning: '非授权信息：响应来自代理，内容可能被转换过。',
    advice: '缓存代理返回自己改写过的内容时使用；客户端拿到的不是源站原始表示。',
    keywords: '非授权信息 代理 转换 non-authoritative',
  },
  {
    code: 204,
    name: 'No Content',
    meaning: '无内容：请求已成功，但没有响应体。',
    advice: '常用于 DELETE / PUT 成功后的空响应；客户端不要尝试解析正文，浏览器也不会改变当前页面。',
    keywords: '无内容 no content 空响应 delete 删除成功',
  },
  {
    code: 205,
    name: 'Reset Content',
    meaning: '重置内容：请求成功，要求客户端重置文档视图（如清空表单）。',
    advice: '表单提交成功后要求清空输入时使用；与 204 的区别是明确要求客户端重置界面状态。',
    keywords: '重置内容 reset 表单 清空',
  },
  {
    code: 206,
    name: 'Partial Content',
    meaning: '部分内容：服务器按 `Range` 请求只返回了资源的一部分。',
    advice: '视频拖动进度条、断点续传依赖它；响应必须带 `Content-Range`，并正确处理 `If-Range`。',
    keywords: '部分内容 partial range 断点续传 分片 视频',
  },
  {
    code: 207,
    name: 'Multi-Status',
    meaning: '多状态：响应体里包含多个独立操作的结果（WebDAV）。',
    advice: '批量操作（如批量删除文件）时逐项报告成功/失败；响应体是 XML 的 `multistatus`。',
    keywords: '多状态 multi-status webdav 批量 逐项',
  },
  {
    code: 208,
    name: 'Already Reported',
    meaning: '已报告：同一集合的成员已在之前的响应中报告过（WebDAV）。',
    advice: '避免在深层目录的 `PROPFIND` 响应里重复列举同一个绑定；普通 Web 场景基本不会遇到。',
    keywords: '已报告 already reported webdav 重复 绑定',
  },
  {
    code: 226,
    name: 'IM Used',
    meaning: '已使用实例操纵：服务器对资源应用了增量编码（delta encoding）。',
    advice: '响应需带 `Delta-Base` 说明基线版本；用于节省带宽的增量更新，日常开发很少直接处理。',
    keywords: 'im used 增量编码 delta 实例操纵',
  },

  // ── 3xx ────────────────────────────────────────────────────────────────────
  {
    code: 300,
    name: 'Multiple Choices',
    meaning: '多种选择：资源有多个可选表示，需要客户端选择。',
    advice: '响应体应列出可选表示及各自 URI；现代 API 很少用，通常由内容协商或前端路由替代。',
    keywords: '多种选择 multiple choices 选项',
  },
  {
    code: 301,
    name: 'Moved Permanently',
    meaning: '永久重定向：资源已永久迁到新地址。',
    advice: '需在 `Location` 给出新地址；搜索引擎会更新索引。旧地址若仍可访问，不要让新地址再指回旧地址（会形成循环）。',
    keywords: '永久重定向 moved permanently 301 迁移 换域名',
  },
  {
    code: 302,
    name: 'Found',
    meaning: '临时重定向：资源临时在另一个地址。',
    advice: '`Location` 给临时地址；客户端应继续对原地址发起请求。历史浏览器会把 POST 改成 GET 跟随，需要保持方法请用 307。',
    keywords: '临时重定向 found 302 跳转 登录',
  },
  {
    code: 303,
    name: 'See Other',
    meaning: '查看其他位置：请求的响应在另一个 URI，客户端应改用 GET 获取。',
    advice: 'POST 处理完成后跳转到结果页（PRG 模式）的标准做法；无论原请求是什么方法，跟随都用 GET。',
    keywords: '查看其他位置 see other 303 prg 结果页',
  },
  {
    code: 304,
    name: 'Not Modified',
    meaning: '未修改：资源自客户端缓存以来没有变化，可直接使用缓存。',
    advice: '由 `If-None-Match` / `If-Modified-Since` 触发；响应不能带正文。若内容明明改了却一直 304，检查 ETag 是否没随内容更新。',
    keywords: '未修改 not modified 缓存 etag 协商缓存',
  },
  {
    code: 305,
    name: 'Use Proxy',
    meaning: '使用代理：资源必须通过响应头指定的代理访问（已废弃）。',
    advice: '因安全原因被 RFC 9110 弃用，不要在新实现里使用；需要代理请走网络层配置。',
    keywords: '使用代理 use proxy 废弃',
  },
  {
    code: 307,
    name: 'Temporary Redirect',
    meaning: '临时重定向：资源临时在另一个地址，且要求保持原请求方法。',
    advice: '与 302 的区别是跟随重定向时方法不变（POST 仍为 POST）；做临时维护跳转又不想丢请求体时用它。',
    keywords: '临时重定向 temporary redirect 307 保持方法 post',
  },
  {
    code: 308,
    name: 'Permanent Redirect',
    meaning: '永久重定向：资源已永久迁走，且要求保持原请求方法。',
    advice: '与 301 的区别是方法不变（POST 仍为 POST）；注意浏览器会长期缓存 308，配错了很难撤销。',
    keywords: '永久重定向 permanent redirect 308 保持方法 缓存',
  },

  // ── 4xx ────────────────────────────────────────────────────────────────────
  {
    code: 400,
    name: 'Bad Request',
    meaning: '错误请求：请求语法有误，服务器无法解析。',
    advice: '检查请求体 JSON 是否合法、必填字段是否缺失、Content-Type 是否匹配；错误响应里应指明哪个字段不对。',
    keywords: '错误请求 bad request 400 参数错误 语法',
  },
  {
    code: 401,
    name: 'Unauthorized',
    meaning: '未认证：请求缺少有效凭证，需要先登录。',
    advice: '响应头 `WWW-Authenticate` 说明认证方式；注意它语义是「未认证」，不是「已登录但无权限」（那是 403）。',
    keywords: '未认证 unauthorized 401 登录 凭证 token 过期',
  },
  {
    code: 402,
    name: 'Payment Required',
    meaning: '需要付款：保留状态码，供付费接口使用。',
    advice: '规范未定义标准行为；部分服务用它在余额不足时拒绝请求，具体含义看该服务的 API 文档。',
    keywords: '需要付款 payment required 402 余额 付费',
  },
  {
    code: 403,
    name: 'Forbidden',
    meaning: '禁止访问：服务器理解了请求，但拒绝执行。',
    advice: '通常是权限不足或请求被安全策略拦截；与 401 不同，重新登录也没用。检查账号角色、IP 白名单与 CSRF 校验。',
    keywords: '禁止访问 forbidden 403 无权限 越权 拒绝',
  },
  {
    code: 404,
    name: 'Not Found',
    meaning: '未找到：请求的资源不存在。',
    advice: '检查 URL 拼写、路由是否注册、资源是否被删除；接口也可能用 404 隐藏「存在但无权访问」的资源。',
    keywords: '未找到 not found 404 页面不存在 找不到 路径错误',
  },
  {
    code: 405,
    name: 'Method Not Allowed',
    meaning: '方法不允许：资源存在，但不支持该 HTTP 方法。',
    advice: '检查用的是 GET 还是 POST；响应头 `Allow` 会列出支持的方法。常见于把表单 POST 提交到了只接受 PUT 的接口。',
    keywords: '方法不允许 method not allowed 405 请求方法 allow',
  },
  {
    code: 406,
    name: 'Not Acceptable',
    meaning: '不可接受：服务器无法提供符合 `Accept` 头要求的内容。',
    advice: '内容协商失败：客户端只接受 JSON 而服务端只能返回 XML 时会这样。检查 `Accept` 头，或让服务端补上对应格式。',
    keywords: '不可接受 not acceptable 406 内容协商 accept',
  },
  {
    code: 407,
    name: 'Proxy Authentication Required',
    meaning: '需要代理认证：必须先通过代理服务器的认证。',
    advice: '响应头 `Proxy-Authenticate` 说明认证方式；多见于企业网络代理，检查代理配置与凭据。',
    keywords: '代理认证 proxy authentication 407 代理',
  },
  {
    code: 408,
    name: 'Request Timeout',
    meaning: '请求超时：服务器在等待请求时超时。',
    advice: '客户端发送太慢、网络中断或请求体过大迟迟发不完；客户端可重试，服务端可适当调大读超时。',
    keywords: '请求超时 request timeout 408 网络 超时',
  },
  {
    code: 409,
    name: 'Conflict',
    meaning: '冲突：请求与目标资源的当前状态冲突。',
    advice: '常见于并发修改、唯一键冲突与版本号不匹配；响应里应说明冲突原因，客户端需刷新后重试。',
    keywords: '冲突 conflict 409 并发 版本 唯一键',
  },
  {
    code: 410,
    name: 'Gone',
    meaning: '已删除：资源之前存在，现已永久不可用。',
    advice: '与 404 的区别是明确「曾经有、以后也不会有」；适合已下架内容，搜索引擎会更快移除索引。',
    keywords: '已删除 gone 410 永久不可用 下架',
  },
  {
    code: 411,
    name: 'Length Required',
    meaning: '需要长度：请求缺少 `Content-Length`。',
    advice: '带请求体时必须声明长度（或用分块传输）；检查客户端是否漏了该头。',
    keywords: '需要长度 length required 411 content-length',
  },
  {
    code: 412,
    name: 'Precondition Failed',
    meaning: '前置条件失败：`If-Match` 等条件不满足。',
    advice: '乐观并发控制里常见：资源已被别人改过，客户端应重新拉取最新版本再合并。',
    keywords: '前置条件失败 precondition failed 412 if-match etag 并发',
  },
  {
    code: 413,
    name: 'Content Too Large',
    meaning: '内容过大：请求体超过服务器允许的大小。',
    advice: '检查上传文件大小与 `client_max_body_size`（nginx）等限制；大文件应改成分片上传，而不是调大全局上限。',
    keywords: '内容过大 content too large 413 payload 上传 文件大小',
  },
  {
    code: 414,
    name: 'URI Too Long',
    meaning: 'URI 过长：请求地址超过服务器允许的长度。',
    advice: 'GET 参数太多或太长；把大批量数据改为请求体提交（POST），或分页。',
    keywords: 'uri 过长 uri too long 414 地址 参数 get',
  },
  {
    code: 415,
    name: 'Unsupported Media Type',
    meaning: '不支持的媒体类型：请求体的格式不被接口接受。',
    advice: '检查 `Content-Type`（例如接口只收 `application/json` 却发了表单）；上传接口还要检查文件类型白名单。',
    keywords: '不支持的媒体类型 unsupported media type 415 content-type 表单',
  },
  {
    code: 416,
    name: 'Range Not Satisfiable',
    meaning: '范围无法满足：`Range` 指定的区间超出资源大小。',
    advice: '响应头 `Content-Range: bytes */<总长度>` 告诉客户端合法范围；断点续传时检查本地记录的文件长度。',
    keywords: '范围无法满足 range not satisfiable 416 断点续传 content-range',
  },
  {
    code: 417,
    name: 'Expectation Failed',
    meaning: '期望失败：无法满足 `Expect` 请求头。',
    advice: '通常是 `Expect: 100-continue` 无法满足；检查中间代理是否支持，或让客户端不再发送该头。',
    keywords: '期望失败 expectation failed 417 expect 代理',
  },
  {
    code: 418,
    name: "I'm a teapot",
    meaning: '我是茶壶：RFC 2324 的愚人节彩蛋，表示服务器拒绝煮咖啡。',
    advice: '不是业务状态码；部分服务拿它当「我就是不处理」的玩笑或风控拒绝，遇到时看具体服务的文档。',
    keywords: '茶壶 teapot 418 彩蛋 玩笑',
  },
  {
    code: 421,
    name: 'Misdirected Request',
    meaning: '请求方向错误：请求被发到了无法为该域名提供服务的服务器。',
    advice: '常见于 HTTP/2 连接复用与 SNI 不匹配：客户端应换一条新连接重试；检查证书与虚拟主机配置。',
    keywords: '请求方向错误 misdirected 421 http2 sni 连接复用',
  },
  {
    code: 422,
    name: 'Unprocessable Content',
    meaning: '无法处理的实体：请求格式正确，但语义上有错误。',
    advice: '字段校验失败时用它比 400 更精确（例如邮箱格式不对）；响应里应逐字段给出原因。旧名 Unprocessable Entity。',
    keywords: '无法处理 unprocessable entity 422 校验 语义 字段',
  },
  {
    code: 423,
    name: 'Locked',
    meaning: '已锁定：资源被锁定，无法访问（WebDAV）。',
    advice: 'WebDAV 中别人正在编辑文件时会这样；检查锁令牌，或等待锁释放。',
    keywords: '已锁定 locked 423 webdav 锁',
  },
  {
    code: 424,
    name: 'Failed Dependency',
    meaning: '依赖失败：因为前置操作失败，本次操作未执行（WebDAV）。',
    advice: '批量/事务性操作里，前面的步骤失败会让后续步骤回 424；应从响应里找到真正失败的依赖项。',
    keywords: '依赖失败 failed dependency 424 webdav 前置',
  },
  {
    code: 425,
    name: 'Too Early',
    meaning: '过早：服务器不愿处理可能被重放的早期数据。',
    advice: 'TLS 1.3 0-RTT 数据有重放风险，服务器可拒绝；客户端应等握手完成后再重试。',
    keywords: '过早 too early 425 tls 0-rtt 重放',
  },
  {
    code: 426,
    name: 'Upgrade Required',
    meaning: '需要升级：必须改用更安全的协议（如 HTTPS / 更高版本 HTTP）。',
    advice: '响应头 `Upgrade` 说明要求；浏览器收到 426 不会自动升级，通常由服务端直接 301 跳到 HTTPS。',
    keywords: '需要升级 upgrade required 426 https 协议',
  },
  {
    code: 428,
    name: 'Precondition Required',
    meaning: '需要前置条件：服务器要求请求带上条件头，防止丢失更新。',
    advice: '服务端要求 `If-Match` / `If-Unmodified-Since`；客户端先读版本号，再带条件写回。',
    keywords: '需要前置条件 precondition required 428 丢失更新 if-match',
  },
  {
    code: 429,
    name: 'Too Many Requests',
    meaning: '请求过多：触发了限频。',
    advice: '看 `Retry-After` 等待指定秒数再重试；客户端应做退避，别在同一秒继续重试。',
    keywords: '请求过多 too many requests 429 限流 限频 频率 retry-after',
  },
  {
    code: 431,
    name: 'Request Header Fields Too Large',
    meaning: '请求头字段过大：单个或全部请求头超过服务器限制。',
    advice: '常见原因是 Cookie 太大或 token 太长；减少 Cookie 体积、拆分请求头，或调整服务端上限。',
    keywords: '请求头过大 request header fields too large 431 cookie',
  },
  {
    code: 451,
    name: 'Unavailable For Legal Reasons',
    meaning: '因法律原因不可用：内容因法律要求被屏蔽。',
    advice: '通常附带解释链接（如 DMCA）；不要用它掩盖普通的权限问题。',
    keywords: '法律原因 unavailable for legal reasons 451 屏蔽 dmca',
  },

  // ── 5xx ────────────────────────────────────────────────────────────────────
  {
    code: 500,
    name: 'Internal Server Error',
    meaning: '服务器内部错误：服务器遇到未预期的情况，无法完成请求。',
    advice: '看服务端日志里的堆栈（响应体不应暴露内部细节）；常见于空指针、数据库异常与未捕获的异步错误。',
    keywords: '服务器内部错误 internal server error 500 报错 异常 堆栈',
  },
  {
    code: 501,
    name: 'Not Implemented',
    meaning: '未实现：服务器不支持该请求所需的功能。',
    advice: '通常是方法未被实现（例如接口只写了 GET，客户端却发 PATCH）；检查服务端路由与反向代理是否转发。',
    keywords: '未实现 not implemented 501 方法 不支持',
  },
  {
    code: 502,
    name: 'Bad Gateway',
    meaning: '网关错误：网关/代理从上游收到无效响应。',
    advice: '上游进程崩了、端口没监听、超时后被断开；检查上游服务状态与 nginx 的 `proxy_pass` 地址。',
    keywords: '网关错误 bad gateway 502 上游 nginx 代理 崩溃',
  },
  {
    code: 503,
    name: 'Service Unavailable',
    meaning: '服务不可用：服务器暂时无法处理请求（过载或维护）。',
    advice: '若能预计恢复时间，带 `Retry-After`；检查是否因连接池耗尽、线程打满或正在发布而暂时下线。',
    keywords: '服务不可用 service unavailable 503 过载 维护 熔断 retry-after',
  },
  {
    code: 504,
    name: 'Gateway Timeout',
    meaning: '网关超时：网关/代理等待上游响应超时。',
    advice: '上游处理太慢或卡死；检查慢查询、外部依赖超时与 `proxy_read_timeout`，不要简单地把超时时间调大掩盖问题。',
    keywords: '网关超时 gateway timeout 504 超时 上游 代理',
  },
  {
    code: 505,
    name: 'HTTP Version Not Supported',
    meaning: 'HTTP 版本不支持：服务器不支持请求使用的 HTTP 版本。',
    advice: '检查客户端/代理是否发了服务器不支持的版本（如 HTTP/2 over cleartext）；统一协议版本后重试。',
    keywords: 'http 版本不支持 http version not supported 505 协议',
  },
  {
    code: 506,
    name: 'Variant Also Negotiates',
    meaning: '变体也会协商：内容协商配置错误导致循环。',
    advice: '服务端的内容协商指向了另一个会再次协商的资源；检查 `Vary` 与协商配置，这属于服务端配置问题。',
    keywords: '变体协商 variant also negotiates 506 内容协商 vary',
  },
  {
    code: 507,
    name: 'Insufficient Storage',
    meaning: '存储空间不足：服务器无法保存完成请求所需的内容（WebDAV）。',
    advice: '检查磁盘配额与临时目录空间；清理空间或扩容后重试。',
    keywords: '存储空间不足 insufficient storage 507 webdav 磁盘',
  },
  {
    code: 508,
    name: 'Loop Detected',
    meaning: '检测到循环：服务器处理请求时发现无限循环（WebDAV）。',
    advice: '目录绑定形成了环或重定向链成环；检查文件系统挂载点/符号链接与重定向规则。',
    keywords: '检测到循环 loop detected 508 webdav 重定向 环',
  },
  {
    code: 510,
    name: 'Not Extended',
    meaning: '未扩展：服务器要求对请求做进一步扩展才能处理。',
    advice: '响应会说明需要哪些扩展；普通 Web 场景几乎不会遇到。',
    keywords: '未扩展 not extended 510 扩展',
  },
  {
    code: 511,
    name: 'Network Authentication Required',
    meaning: '需要网络认证：客户端需要先完成网络接入认证。',
    advice: '常见于酒店/机场 Wi-Fi 的强制门户（captive portal）；完成认证页登录后重试，或让客户端处理门户跳转。',
    keywords: '网络认证 network authentication required 511 强制门户 wifi 认证',
  },
];

/** 状态码的首位数字 → 分类。未知码返回 null（页面据此显示「未登记」）。 */
export function httpStatusCategory(code: number): HttpStatusCategory | null {
  const first = Math.trunc(code / 100);
  return first >= 1 && first <= 5 ? (first as HttpStatusCategory) : null;
}

/** 按状态码精确查找。 */
export function findHttpStatus(code: number): HttpStatusDef | undefined {
  return HTTP_STATUSES.find((entry) => entry.code === code);
}

/**
 * 搜索状态码：按 code / 英文名 / 中文含义 / 处理建议 / 同义词做大小写不敏感匹配。
 * 加 `category` 时同时按分类过滤。空查询返回该分类的全部条目。
 */
export function searchHttpStatuses(query: string, category?: HttpStatusCategory): HttpStatusDef[] {
  const q = query.trim().toLowerCase();
  return HTTP_STATUSES.filter((entry) => {
    if (category !== undefined && httpStatusCategory(entry.code) !== category) return false;
    if (q === '') return true;
    const haystack = `${entry.code} ${entry.name} ${entry.meaning} ${entry.advice} ${entry.keywords}`.toLowerCase();
    return haystack.includes(q);
  });
}

/** 每个分类的条目数（页面分类筛选旁显示计数）。 */
export function httpStatusCounts(): Record<HttpStatusCategory, number> {
  const counts: Record<HttpStatusCategory, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  for (const entry of HTTP_STATUSES) {
    const category = httpStatusCategory(entry.code);
    if (category !== null) counts[category] += 1;
  }
  return counts;
}
