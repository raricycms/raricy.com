// ─────────────────────────────────────────────────────────────────────────────
// url-policy.ts — ReactiveMD 渲染前的 URL 用途白名单（**零依赖、零 I/O**）
//
// 这一层只回答「这个地址能不能交给渲染器」，**不替代任何资源鉴权**：
//   · 图片 / 音频仍然由 `/api/images/*`、`/api/audio/*` 的 raw 路由判权；
//   · 这里也**不抓取**任何远端地址，不新增服务端代理。
// 换句话说，放行一个外链图片只是「浏览器可以去加载」，不是「站点替用户去取」。
//
// 三种用途分开判，因为它们的风险面不同：
//   · image：站内相对地址（含 `/image/i/*` 历史 rewrite）、历史 IP 图床地址、
//     博客现有的 http(s) 外链图片都保留 —— 收紧外链图是另一个决策，不在本次预适配里；
//   · audio：**只**认本站受控的 `/api/audio/<10 位 id>/raw`。外链音频是访客 IP 泄露的
//     跟踪信标，与评论里禁止外链图同源；音频 token 本来就只允许我们自己拼 URL；
//   · link：相对地址、页内片段、mailto / tel、http(s) 外链。
//
// 拒绝面是**白名单**而不是黑名单：绝对地址只认 http / https（link 另加 mailto / tel），
// 其余协议（javascript / data / vbscript / file / blob …）一律不放行。
// 同时拒绝空白与控制字符 —— 浏览器解析 href 时会忽略制表符/换行，`java\tscript:` 在
// 字符串比较里不像危险协议，交给 URL 解析器却会还原成 `javascript:`。反斜杠也拒绝，
// 因为 WHATWG URL 把它当 `/` 归一化，`https:\\evil` 会变成另一个主机。
//
// 本文件会被客户端（`ReactiveDocument` 的 urlPolicy）与服务端共用，所以刻意不 import
// 任何东西，也不碰 Node / DOM。
// ─────────────────────────────────────────────────────────────────────────────

export type ReactiveUrlPurpose = 'image' | 'audio' | 'link';

/** 超长地址直接拒绝：正常图床/外链不会到这个量级，也避免把异常输入带进缓存键。 */
const MAX_URL_LENGTH = 8192;

/** 空白（含 \t \n \r）、控制字符与反斜杠 —— 都是浏览器会归一化/忽略的混淆面。 */
const FORBIDDEN_CHARS = /[\u0000- \u007f\\]/;

/** scheme 形态（只用于识别，不用于放行）。 */
const SCHEME = /^([A-Za-z][A-Za-z0-9+.-]*):/;

/** HTML 实体编码的冒号（`&#58;` / `&#x3a;` / `&colon;`）—— 不允许出现在地址里。 */
const ENTITY_COLON = /&(?:#0*58|#x0*3a|colon);/i;

/** 百分号编码的 scheme 冒号：浏览器不这样解析，但下游若有解码步骤就会变回协议。 */
const ENCODED_SCHEME = /^(?:javascript|vbscript|data|file|blob|about)%3a/i;

/** 本站音频字节的唯一合法形状（与 audio-refs.ts 的 `AUDIO_URL_PREFIX` 一致）。 */
const CONTROLLED_AUDIO_PATH = /^\/api\/audio\/[A-Za-z0-9]{10}\/raw$/;

/**
 * 这个地址是否允许出现在指定用途的位置。
 *
 * 输入就是渲染器拿到的原样字符串（Markdown 已经解过转义）；不做 trim ——
 * 首尾空白本身就该拒绝，而不是替调用方「修好」它。
 */
export function isAllowedReactiveUrl(url: string, purpose: ReactiveUrlPurpose): boolean {
  if (typeof url !== 'string' || url.length === 0 || url.length > MAX_URL_LENGTH) {
    return false;
  }
  if (FORBIDDEN_CHARS.test(url)) return false;
  if (ENTITY_COLON.test(url)) return false;
  if (ENCODED_SCHEME.test(url)) return false;

  // 音频不参与「相对地址 / 外链」那套判断：只认本站受控路径。
  if (purpose === 'audio') return CONTROLLED_AUDIO_PATH.test(url);

  // 纯片段只对超链接有意义；图片 / 音频的 `#x` 没有内容可显示。
  if (url.startsWith('#')) return purpose === 'link';

  const schemeMatch = SCHEME.exec(url);
  if (!schemeMatch) {
    // 协议相对地址（`//cdn.example.com/a.png`）继承页面协议，按 http(s) 外链处理。
    if (url.startsWith('//')) return isSafeHttpUrl(url);
    // 相对路径 / absolute-path / query：站内资源与同页链接都走这一类。
    return true;
  }

  const scheme = schemeMatch[1].toLowerCase();
  if (scheme === 'http' || scheme === 'https') return isSafeHttpUrl(url);

  if (purpose === 'link' && (scheme === 'mailto' || scheme === 'tel')) {
    // scheme 后面必须有内容；`mailto:` 空壳没有可点击目标。
    return url.slice(schemeMatch[0].length).length > 0;
  }

  return false;
}

/**
 * 绝对 http(s) / 协议相对地址：必须能解析出主机，且不带用户名密码。
 *
 * `https:evil.com`（没有 `//`）也会被 WHATWG URL 解析成 `https://evil.com/` ——
 * 这仍然是普通 http(s) 外链，按外链放行；危险协议在调用前就被 scheme 白名单挡住了。
 */
function isSafeHttpUrl(url: string): boolean {
  try {
    const parsed = new URL(url.startsWith('//') ? `https:${url}` : url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    if (parsed.hostname.length === 0) return false;
    // 带凭据的地址会让人误判真正的主机（`https://raricy.com@evil`），直接拒绝。
    if (parsed.username.length > 0 || parsed.password.length > 0) return false;
    return true;
  } catch {
    return false;
  }
}
