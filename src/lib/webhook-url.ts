// ─────────────────────────────────────────────────────────────────────────────
// webhook-url.ts — 回调地址的校验与「钉住 IP」的投递
//
// 这是本站**第一次由服务器主动去 fetch 用户提供的地址**。在那之前所有出站 HTTP
// 都是打我们自己配置的账户服务 —— 地址可信，所以从没需要考虑 SSRF。回调不一样：
// 地址是商户填的，而我们的服务器在内网里，旁边就是账户微服务和 SQLite 文件。
// 一个指向 169.254.169.254 或 127.0.0.1 的地址就能把它变成内网探测器。
//
// ★ 三层，缺一不可 ★
//   ① 静态策略（parseWebhookUrl）：scheme / 端口 / 单标签主机 / 长度 / 不许带凭据。
//   ② 解析后逐地址校验（resolveWebhookTarget）：把域名解析成 IP，**每一个**都不能是
//      私网 / 回环 / 链路本地 / 组播 / 保留段。只查字面量 IP 会被「evil.com 解析到
//      127.0.0.1」绕过。
//   ③ **连到已校验的那个 IP**，而不是再让系统解析一次（postWebhook 里连的是 address）。
//      没有这一层，②就只是个建议：DNS 可以在两次解析之间改主意（rebinding），
//      校验时给公网地址、连接时给 127.0.0.1。把校验结果钉进连接里，那次竞态就不存在了。
//
// 【绝不跟随重定向】3xx 一律当失败。跟随重定向意味着下一跳要重新走①②③，漏一步
// 就是一个绕过；而且商户真要跳转，自己返回 2xx 就是。文档里也写了「必须直接返回 2xx」。
//
// ⚠️ 不要与 safe-url.ts 合并 ⚠️
// 那个模块的 safeExternalReturnUrl 是**相反**的策略：它刻意放行 http: 与私网主机
// （因为那个地址是**浏览器**去跳的，不经过我们的网络），还明说「这不是开放重定向，
// 因为只渲染成链接、不自动跳」。三个校验器三种策略，合并就等于把某一边的宽松
// 带进另一边 —— 而这两个方向的宽松恰好互为对方的漏洞。
// ─────────────────────────────────────────────────────────────────────────────

import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';

/** 地址长度上限（与 OAuth 的 redirect_uri 同量级，够放长路径 + 查询串）。 */
export const WEBHOOK_URL_MAX = 2048;

/** 默认投递超时（毫秒）。商户的回调端点不该让我们等太久 —— 它拖住的是 drainer。 */
export const WEBHOOK_TIMEOUT_MS = 5000;

/** 响应体最多读这么多就断开：我们只关心状态码，不关心内容。 */
const MAX_RESPONSE_BYTES = 8 * 1024;

export class WebhookUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebhookUrlError';
  }
}

/** 含空白或 ASCII 控制字符？ */
function hasBlankOrControl(s: string): boolean {
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0;
    if (c <= 0x20 || c === 0x7f) return true;
  }
  return false;
}

// ── ① 静态策略 ───────────────────────────────────────────────────────────────

/**
 * 解析并做静态校验。**不查 DNS**（那是异步的，见 resolveWebhookTarget）。
 * 失败抛 WebhookUrlError，文案直接给用户看。
 *
 * @param opts.allowPrivate **仅供测试**：额外放行 `http:`，好让 vitest 在 127.0.0.1
 *        上起一个明文接收端（自签证书的 https 服务端过不了证书校验）。
 *        生产路径**永远不传**这个开关 —— 线路上的 https 是回调保密性的一部分。
 */
export function parseWebhookUrl(raw: string, opts?: { allowPrivate?: boolean }): URL {
  const s = (raw ?? '').trim();
  if (!s) throw new WebhookUrlError('请填写回调地址');
  if (s.length > WEBHOOK_URL_MAX) throw new WebhookUrlError('回调地址过长');
  // 空白 / 控制字符：URL 解析器会把它们当分隔符剥掉，剥完的地址与用户看到的不是同一个
  //（safe-url.ts 里记过 TAB/LF 剥除那类绕过）。
  if (hasBlankOrControl(s)) throw new WebhookUrlError('回调地址含空白或控制字符');

  let url: URL;
  try {
    url = new URL(s);
  } catch {
    throw new WebhookUrlError('回调地址不是合法的 URL');
  }

  const httpAllowed = opts?.allowPrivate === true && url.protocol === 'http:';
  if (url.protocol !== 'https:' && !httpAllowed) {
    throw new WebhookUrlError('回调地址必须是 https（我们只会向 https 地址投递）');
  }
  // https://user:pass@evil.com —— 地址栏会显示成可信域名，是钓鱼惯用手法。
  if (url.username || url.password) {
    throw new WebhookUrlError('回调地址不能带用户名或密码');
  }
  if (!url.hostname) throw new WebhookUrlError('回调地址缺少主机名');
  if (url.port === '0') throw new WebhookUrlError('回调地址端口不合法');

  // 单标签主机（https://intranet/）几乎必然是内网名字。②只能拦「解析出来的地址」，
  // 拦不住「当时解析不出来」的情形 —— 这里先挡一道。
  const host = url.hostname.toLowerCase();
  if (!host.includes('.') && !host.startsWith('[')) {
    throw new WebhookUrlError('回调地址的主机名不完整');
  }
  for (const suffix of ['.local', '.localhost', '.internal', '.home.arpa']) {
    if (host.endsWith(suffix)) throw new WebhookUrlError('回调地址不能是内网地址');
  }

  return url;
}

// ── ② 地址策略 ───────────────────────────────────────────────────────────────

/** 把 IPv4 点分十进制解析成 4 个字节；不是合法 v4 返回 null。 */
function v4Bytes(ip: string): number[] | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  const out: number[] = [];
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    out.push(n);
  }
  return out;
}

/** 32 位无符号整数形式（比较网段用）。 */
function v4ToInt(b: number[]): number {
  return ((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0;
}

/** b 是否落在 prefix/bits 这个网段里。 */
function inV4Range(b: number[], prefix: string, bits: number): boolean {
  const base = v4Bytes(prefix);
  if (!base) return false;
  if (bits <= 0) return true;
  if (bits >= 32) return v4ToInt(b) === v4ToInt(base);
  // 掩码写成「高位 bits 个 1」；用 >>> 0 保证是无符号的 32 位数
  const mask = (0xffffffff << (32 - bits)) >>> 0;
  return (v4ToInt(b) & mask) === (v4ToInt(base) & mask);
}

/** v4 黑名单：私网 / 回环 / 链路本地（含云元数据 169.254.169.254）/ 组播 / 保留段。 */
const BLOCKED_V4: [string, number][] = [
  ['0.0.0.0', 8], // 「本网络」
  ['10.0.0.0', 8], // 私网
  ['100.64.0.0', 10], // CGNAT
  ['127.0.0.0', 8], // 回环
  ['169.254.0.0', 16], // 链路本地 **与云元数据**
  ['172.16.0.0', 12], // 私网
  ['192.0.0.0', 24], // IETF 协议专用
  ['192.0.2.0', 24], // TEST-NET-1
  ['192.88.99.0', 24], // 6to4 中继
  ['192.168.0.0', 16], // 私网
  ['198.18.0.0', 15], // 基准测试
  ['198.51.100.0', 24], // TEST-NET-2
  ['203.0.113.0', 24], // TEST-NET-3
  ['224.0.0.0', 4], // 组播
  ['240.0.0.0', 4], // 保留（含 255.255.255.255）
];

/**
 * 这个 IP 是不是「不许我们连过去」的地址。**导出是为了单测能逐条钉**。
 *
 * IPv6 两项容易漏：`::ffff:a.b.c.d`（IPv4 映射）必须先拆出来按 v4 重判，
 * 否则 `::ffff:127.0.0.1` 会一路畅通；`2002::/16`（6to4）能隧道到私网。
 */
export function isBlockedAddress(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) {
    const b = v4Bytes(ip);
    if (!b) return true;
    return BLOCKED_V4.some(([prefix, bits]) => inV4Range(b, prefix, bits));
  }
  if (kind === 6) {
    const lower = ip.toLowerCase();
    // IPv4 映射 / 兼容：拆出来按 v4 规则重判（经典绕过：::ffff:127.0.0.1）
    const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(lower);
    if (mapped) return isBlockedAddress(mapped[1]);
    if (lower === '::' || lower === '::1') return true;
    // 展开式写法（0:0:0:0:0:0:0:1）也一并挡掉
    const expanded = lower.replace(/(^|:)0{1,4}(?=:|$)/g, '$1');
    if (/^(|0+:)*0*1$/.test(expanded) && expanded.includes(':')) return true;
    if (/^fe[89ab]/.test(lower)) return true; // fe80::/10 链路本地
    if (/^f[cd]/.test(lower)) return true; // fc00::/7 唯一本地
    if (/^ff/.test(lower)) return true; // ff00::/8 组播
    if (lower.startsWith('2001:db8')) return true; // 文档用
    if (lower.startsWith('2002')) return true; // 6to4：可隧道到私网
    if (lower.startsWith('64:ff9b')) return true; // NAT64：同上
    return false;
  }
  return true; // 不是合法 IP —— 宁可不发
}

export interface WebhookTarget {
  url: URL;
  /** 已校验通过的地址，投递时**钉死**用它，不再让系统解析一次。 */
  address: string;
  family: 4 | 6;
}

/**
 * 解析主机名并校验**每一个**结果地址，然后返回一个可钉死的目标。
 *
 * 【为什么要校验全部而不是挑一个】一个域名可以同时解析到公网与私网地址，
 * 「挑一个公网的」并不能阻止系统在实际连接时选中另一个。
 *
 * @param opts.allowPrivate **仅供测试**：放行私网地址，好让 vitest 起一个
 *        127.0.0.1 上的真接收端。刻意**不做成环境变量** —— 一个生产可达的
 *        fail-open 开关，正是本仓红线盯着的那类东西。e2e 里因此不测投递路径。
 */
export async function resolveWebhookTarget(
  raw: string,
  opts?: { allowPrivate?: boolean }
): Promise<WebhookTarget> {
  const url = parseWebhookUrl(raw, opts);
  const host = url.hostname.startsWith('[')
    ? url.hostname.slice(1, -1) // [::1] → ::1
    : url.hostname;

  // 字面量 IP：不必查 DNS，直接判
  const literal = isIP(host);
  let candidates: { address: string; family: number }[];
  if (literal) {
    candidates = [{ address: host, family: literal }];
  } else {
    try {
      candidates = await dns.promises.lookup(host, { all: true });
    } catch {
      throw new WebhookUrlError('回调地址的域名解析不了');
    }
  }
  if (!candidates.length) throw new WebhookUrlError('回调地址的域名解析不了');

  if (!opts?.allowPrivate) {
    for (const c of candidates) {
      if (isBlockedAddress(c.address)) {
        throw new WebhookUrlError('回调地址指向内网或保留地址，本站拒绝投递');
      }
    }
  }

  const pick = candidates[0];
  return { url, address: pick.address, family: pick.family === 6 ? 6 : 4 };
}

// ── ③ 投递（钉住 IP、不跟随重定向）─────────────────────────────────────────

export interface WebhookPostResult {
  status: number;
}

/**
 * 把正文 POST 到已校验的目标。**连的是 target.address，不是再解析一次的域名**。
 *
 * 用 node:https.request 而不是 fetch：fetch 不接受「连到这个 IP、但按那个域名做
 * SNI 与 Host」这种组合（要换 undici 的 Agent，而 undici 不在依赖里）。
 * https.request 直接就能把解析结果钉死。
 */
export function postWebhook(
  target: WebhookTarget,
  headers: Record<string, string>,
  body: string,
  opts?: { timeoutMs?: number }
): Promise<WebhookPostResult> {
  const { url, address, family } = target;
  const isHttps = url.protocol === 'https:';
  const lib = isHttps ? https : http;
  const timeoutMs = opts?.timeoutMs ?? WEBHOOK_TIMEOUT_MS;

  return new Promise((resolve, reject) => {
    const req = lib.request(
      {
        host: address, // ← 连的是校验过的 IP
        family,
        port: url.port ? Number(url.port) : isHttps ? 443 : 80,
        path: `${url.pathname}${url.search}`,
        method: 'POST',
        // SNI 与 Host 用**域名**：证书要按域名校验、虚拟主机也要按域名路由。
        // 只有 TCP 层连的是 IP —— 这正是我们要的（DNS rebinding 无处下手）。
        servername: isHttps && !isIP(url.hostname) ? url.hostname : undefined,
        headers: {
          ...headers,
          Host: url.host,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
        // 每个请求一条新连接：不同商户指向同一 IP 时复用连接会串味
        agent: false,
        timeout: timeoutMs,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        let read = 0;
        res.on('data', (chunk: Buffer) => {
          read += chunk.length;
          // 只关心状态码，正文读够就断开（否则恶意端点能用无限正文拖死我们）
          if (read > MAX_RESPONSE_BYTES) res.destroy();
        });
        res.on('end', () => resolve({ status }));
        res.on('close', () => resolve({ status }));
        res.on('error', reject);
      }
    );

    req.on('timeout', () => {
      req.destroy(new Error(`回调超时（${timeoutMs}ms）`));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}
