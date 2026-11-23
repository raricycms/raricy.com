// ─────────────────────────────────────────────────────────────────────────────
// chat-rmd/options.ts — 聊天 ReactiveMD 的编译配置与 URL 策略（零 DOM 依赖）
//
// 聊天与博客共用 `compileSource` / reactive-md，但**能力与预算独立**：
// 不启用作者 CSS / JavaScript / 扩展 HTML，也不注册 hostComponents 或 config
// （引用适配在编译完成后由 references 层做）。所有版本身份集中在这里，缓存键、
// Worker 与视图都从这里取值，避免各自写死字面量后悄悄漂移。
//
// 这里只放纯数据与纯函数：可以安全地进 Worker，也可以被服务端 import 而不碰 window。
// ─────────────────────────────────────────────────────────────────────────────

import type { LocalCompileOptions } from 'reactive-md';
import type { LocalUrlPolicy } from 'reactive-md/react';

/**
 * 编译依赖的身份。升级 `reactive-md` 时必须同步改这里，否则 final 缓存会跨版本复用。
 * 当前由 `package.json` 精确锁定 `reactive-md@0.9.2`。
 */
export const CHAT_RMD_COMPILER_VERSION = 'reactive-md/0.9.2';

/** Chat 编译参数身份；调整 `CHAT_RMD_COMPILE_OPTIONS` 的任何数值都要换版本。 */
export const CHAT_RMD_OPTIONS_VERSION = 'chat-rmd/1';

/**
 * 聊天专用编译配置（设计 §3.1 / M0 冻结）。
 *
 * 预算是首版初值：`maxSyntaxNodes` 按单条消息 5000 字符封顶，足够 Markdown 与公式；
 * 收紧后畸形输入更早落到源码回退，而不是在共享 Worker 里长时间占用唯一执行槽。
 */
export const CHAT_RMD_COMPILE_OPTIONS: LocalCompileOptions = Object.freeze({
  strict: false,
  markdownBreaks: true,
  enableCss: false,
  enableJavaScript: false,
  enableExtendedHtml: false,
  limits: Object.freeze({
    maxSyntaxNodes: 10_000,
    maxParseWork: 1_000_000,
    maxMarkdownDepth: 64,
  }),
});

const MAX_CHAT_URL_LENGTH = 8192;

/**
 * 空白 / 控制字符 / 反斜杠一律拒绝：浏览器会把制表换行剥离、把 `\` 当 `/`，
 * 放过它们等于给 `//evil` 与 `\\evil` 留后门。
 */
const CHAT_URL_FORBIDDEN = /[\u0000-\u0020\u007f\\]/;

const CHAT_HTTP_SCHEME = /^https?:/i;
const CHAT_MAILTO_SCHEME = /^mailto:/i;

/**
 * 聊天允许加载图片的同源前缀；原生图片节点仍由 document-policy 移除。
 *
 * 这里**不列头像 / 头像框路径**：它们由宿主组件（Avatar）直接取数，不经过文档
 * URL 策略；`/api/avatar/` 字面量全仓只允许出现在 avatar-refs.ts（静态守卫）。
 */
export const CHAT_IMAGE_PATH_PREFIXES: readonly string[] = Object.freeze([
  '/api/images/',
  '/api/stickers/',
  '/static/emoji/',
]);

function isChatHttpUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
      parsed.username === '' &&
      parsed.password === ''
    );
  } catch {
    return false;
  }
}

function isAllowedChatLink(url: string): boolean {
  if (url.startsWith('#')) return true;
  if (url.startsWith('/')) return !url.startsWith('//');

  if (CHAT_MAILTO_SCHEME.test(url)) {
    // 只校验形态；`mailto:` 头和空白已在入口拒绝。
    return url.length > 'mailto:'.length;
  }
  if (CHAT_HTTP_SCHEME.test(url)) return isChatHttpUrl(url);

  // 其余协议（javascript/data/file/blob…）与 `foo/bar` 这类相对路径一律拒绝。
  return false;
}

function isControlledChatImagePath(url: string): boolean {
  if (!url.startsWith('/') || url.startsWith('//')) return false;

  let parsed: URL;
  try {
    parsed = new URL(url, 'https://chat.invalid');
  } catch {
    return false;
  }
  if (parsed.origin !== 'https://chat.invalid') return false;

  const path = parsed.pathname;
  for (const prefix of CHAT_IMAGE_PATH_PREFIXES) {
    if (path.startsWith(prefix)) {
      // `new URL` 已折叠 `/api/images/../x`，再挡一层编码或未折叠的点段。
      let decoded: string;
      try {
        decoded = decodeURIComponent(path);
      } catch {
        return false;
      }
      if (decoded.includes('\\') || /(^|\/)\.{1,2}(\/|$)/.test(decoded)) return false;
      return true;
    }
  }
  return false;
}

/**
 * 聊天文档的 URL 策略（视图与 document-policy 共用）。
 *
 * 链接：站内相对路径（`/`、`#`）、http(s) 与 mailto；拒绝协议相对地址与所有
 * 其他协议。图片：只允许同源受控前缀，其他一律拒绝 —— 聊天不加载作者外链图片。
 */
export const chatReactiveUrlPolicy: LocalUrlPolicy = (url, kind) => {
  if (typeof url !== 'string' || url.length === 0 || url.length > MAX_CHAT_URL_LENGTH) {
    return false;
  }
  if (CHAT_URL_FORBIDDEN.test(url)) return false;
  return kind === 'image' ? isControlledChatImagePath(url) : isAllowedChatLink(url);
};