// ─────────────────────────────────────────────────────────────────────────────
// net-guard.ts — 服务端代用户发起外网请求前的 SSRF 判据（纯函数 + 可注入 DNS）
//
// 唯一调用方是 `GET /api/tool/http-headers`（本站**唯一**代用户发起外网请求的路由）。
// 判断逻辑全部写成纯函数，DNS 解析单独一层、且**可注入替身** —— 所以单测不需要联网。
//
// 【判据，按顺序】
//   1. 协议只允许 http: / https:；
//   2. 端口只允许 80 / 443（URL 解析会把默认端口吃掉，所以 `url.port === ''` 也算合法）；
//   3. 不许带用户名 / 密码（`http://user:pass@host` 会被拿去打内网并带上认证）；
//   4. hostname 不许是 localhost / *.localhost / *.local / *.internal；
//   5. hostname 是 IP 字面量 → **直接判私网，不做 DNS**；
//   6. 否则用 `dns.lookup(host, { all: true })` 解析**全部**地址，任一落在私网 / 回环 /
//      链路本地 / 保留地址就拒绝。
// 第 6 条用 `all: true` 而不是只取第一个：多 A 记录里只要有一条指向内网，
// 「取第一条」的实现就会漏放（DNS 轮询 / 攻击者可控域名）。
//
// 【重定向为什么必须在每一跳重新过校验】
// 目标站点可以 302 到 `http://127.0.0.1:8080/` —— 只校验初始 URL 等于没防。
// 路由每跟一跳就把 location 解析成绝对地址、再完整走一遍本文件的判据（含 DNS）。
//
// 【IPv4 拒绝清单】0/8、10/8、100.64/10、127/8、169.254/16、172.16/12、
// 192.0.0/24、192.0.2/24（文档）、192.88.99/24（6to4 中继）、192.168/16、
// 198.18/15（基准测试）、198.51.100/24（文档）、203.0.113/24（文档）、
// 224/4（组播）、240/4（保留）。
//
// 【IPv6 拒绝清单】::、::1、fc00::/7（唯一本地）、fe80::/10（链路本地）、
// ff00::/8（组播）、2001:db8::/32（文档）、100::/64（discard）、
// 2001::/32（Teredo）、2002::/16（6to4）、fec0::/10（旧站点本地）、
// 64:ff9b::/96（NAT64）、::ffff:0:0/96（IPv4 映射 → 按 IPv4 判）、
// 以及 IPv4 兼容 / 全零前缀的保留地址。
// ─────────────────────────────────────────────────────────────────────────────

import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { intToIpv4, ipv4ToInt, parseIpv6 } from './subnet';

/** 允许的目标端口。 */
export const ALLOWED_TARGET_PORTS: readonly number[] = [80, 443];

/** 最多跟随多少次重定向（超过即报错，不再继续）。 */
export const MAX_REDIRECTS = 3;

/** URL 被策略拒绝（协议 / 端口 / 凭据 / 域名 / 私网地址）。 */
export class TargetRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TargetRejectedError';
  }
}

/** 域名解析失败（DNS 不可用 / 无记录）。 */
export class TargetLookupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TargetLookupError';
  }
}

/** 可注入的 DNS 解析器：返回该主机名解析到的**全部**地址。 */
export type AddressResolver = (host: string) => Promise<string[]>;

async function defaultResolve(host: string): Promise<string[]> {
  const found = await lookup(host, { all: true });
  return found.map((entry) => entry.address);
}

// ── hostname 归一 ───────────────────────────────────────────────────────────

/**
 * 归一 URL 里的 hostname：小写、去 IPv6 方括号、去末尾的点。
 *
 * `localhost.` / `LOCALHOST` / `[::1]` 都是合法的 URL 写法，不归一会绕过字面量比对。
 */
export function normalizeTargetHostname(hostname: string): string {
  let host = hostname.trim().toLowerCase();
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  if (host.endsWith('.')) host = host.replace(/\.+$/, '');
  return host;
}

const BLOCKED_HOSTNAMES = new Set(['localhost']);
const BLOCKED_HOST_SUFFIXES = ['.localhost', '.local', '.internal'];

/** 本机 / 内网域名判据；不拦截返回 null。 */
export function blockedHostnameReason(hostname: string): string | null {
  const host = normalizeTargetHostname(hostname);
  if (!host) return '目标地址缺少主机名';
  if (BLOCKED_HOSTNAMES.has(host)) return `不允许访问本机域名（${host}）`;
  for (const suffix of BLOCKED_HOST_SUFFIXES) {
    if (host.endsWith(suffix)) return `不允许访问内网域名（${host}）`;
  }
  return null;
}

// ── IPv4 判定 ───────────────────────────────────────────────────────────────

interface Ipv4Range {
  base: number;
  prefix: number;
  reason: string;
}

const BLOCKED_IPV4_RANGES: readonly Ipv4Range[] = [
  { base: ipv4ToInt('0.0.0.0')!, prefix: 8, reason: '0.0.0.0/8（保留：本网络）' },
  { base: ipv4ToInt('10.0.0.0')!, prefix: 8, reason: '10.0.0.0/8（私有地址）' },
  { base: ipv4ToInt('100.64.0.0')!, prefix: 10, reason: '100.64.0.0/10（运营商级 NAT）' },
  { base: ipv4ToInt('127.0.0.0')!, prefix: 8, reason: '127.0.0.0/8（回环）' },
  { base: ipv4ToInt('169.254.0.0')!, prefix: 16, reason: '169.254.0.0/16（链路本地）' },
  { base: ipv4ToInt('172.16.0.0')!, prefix: 12, reason: '172.16.0.0/12（私有地址）' },
  { base: ipv4ToInt('192.0.0.0')!, prefix: 24, reason: '192.0.0.0/24（保留）' },
  { base: ipv4ToInt('192.0.2.0')!, prefix: 24, reason: '192.0.2.0/24（文档地址）' },
  { base: ipv4ToInt('192.88.99.0')!, prefix: 24, reason: '192.88.99.0/24（6to4 中继，保留）' },
  { base: ipv4ToInt('192.168.0.0')!, prefix: 16, reason: '192.168.0.0/16（私有地址）' },
  { base: ipv4ToInt('198.18.0.0')!, prefix: 15, reason: '198.18.0.0/15（基准测试）' },
  { base: ipv4ToInt('198.51.100.0')!, prefix: 24, reason: '198.51.100.0/24（文档地址）' },
  { base: ipv4ToInt('203.0.113.0')!, prefix: 24, reason: '203.0.113.0/24（文档地址）' },
  { base: ipv4ToInt('224.0.0.0')!, prefix: 4, reason: '224.0.0.0/4（组播）' },
  { base: ipv4ToInt('240.0.0.0')!, prefix: 4, reason: '240.0.0.0/4（保留）' },
];

function ipv4InRange(value: number, base: number, prefix: number): boolean {
  if (prefix === 0) return true;
  const mask = (0xffffffff << (32 - prefix)) >>> 0;
  return ((value & mask) >>> 0) === ((base & mask) >>> 0);
}

/** IPv4 私网 / 保留地址判据；不拦截返回 null。 */
export function blockedIpv4Reason(value: number): string | null {
  const n = value >>> 0;
  for (const range of BLOCKED_IPV4_RANGES) {
    if (ipv4InRange(n, range.base, range.prefix)) return range.reason;
  }
  return null;
}

// ── IPv6 判定 ───────────────────────────────────────────────────────────────

interface Ipv6Range {
  base: bigint;
  prefix: number;
  reason: string;
}

function ipv6Range(text: string, prefix: number, reason: string): Ipv6Range {
  const base = parseIpv6(text);
  if (base === null) throw new Error(`net-guard 内置的 IPv6 网段非法：${text}`);
  return { base, prefix, reason };
}

const BLOCKED_IPV6_RANGES: readonly Ipv6Range[] = [
  ipv6Range('::', 128, '::（未指定地址）'),
  ipv6Range('::1', 128, '::1（回环）'),
  ipv6Range('fc00::', 7, 'fc00::/7（唯一本地地址）'),
  ipv6Range('fe80::', 10, 'fe80::/10（链路本地）'),
  ipv6Range('ff00::', 8, 'ff00::/8（组播）'),
  ipv6Range('2001:db8::', 32, '2001:db8::/32（文档地址）'),
  ipv6Range('100::', 64, '100::/64（discard-only）'),
  ipv6Range('2001::', 32, '2001::/32（Teredo 隧道）'),
  ipv6Range('2002::', 16, '2002::/16（6to4 隧道）'),
  ipv6Range('fec0::', 10, 'fec0::/10（旧站点本地）'),
  ipv6Range('64:ff9b::', 96, '64:ff9b::/96（NAT64）'),
];

function ipv6InRange(value: bigint, base: bigint, prefix: number): boolean {
  if (prefix === 0) return true;
  const all = (1n << 128n) - 1n;
  const mask = all ^ ((1n << BigInt(128 - prefix)) - 1n);
  return (value & mask) === (base & mask);
}

/** IPv6 私网 / 保留地址判据；不拦截返回 null。 */
export function blockedIpv6Reason(value: bigint): string | null {
  if (value < 0n || value > (1n << 128n) - 1n) return 'IPv6 数值超出 128 位范围';
  // 先给两个最特殊的地址精确归因（否则会落进下面的 ::/96 通用分支）
  if (value === 0n) return '::（未指定地址）';
  if (value === 1n) return '::1（回环）';
  // IPv4 映射（::ffff:a.b.c.d）按 IPv4 判 —— 它实际连的就是那个 v4 地址
  if (value >> 32n === 0xffffn) {
    const mapped = Number(value & 0xffffffffn);
    const reason = blockedIpv4Reason(mapped);
    return reason ? `IPv4 映射地址 ${intToIpv4(mapped)}：${reason}` : null;
  }
  // ::/96 与 IPv4 兼容地址（已废弃）都是保留段
  if (value >> 32n === 0n) return 'IPv4 兼容 / 保留地址（::/96）';
  for (const range of BLOCKED_IPV6_RANGES) {
    if (ipv6InRange(value, range.base, range.prefix)) return range.reason;
  }
  return null;
}

/** 任意 IP 字面量（v4 / v6）的私网 / 保留地址判据；不是 IP 或可放行都返回 null。 */
export function blockedAddressReason(ip: string): string | null {
  const family = isIP(ip);
  if (family === 4) {
    const value = ipv4ToInt(ip);
    if (value === null) return '无法解析的 IPv4 地址';
    return blockedIpv4Reason(value);
  }
  if (family === 6) {
    const value = parseIpv6(ip);
    if (value === null) return '无法解析的 IPv6 地址';
    return blockedIpv6Reason(value);
  }
  return '不是合法的 IP 地址';
}

// ── URL 级判据 ──────────────────────────────────────────────────────────────

/**
 * 校验一个已经 `new URL()` 过的目标：协议 / 凭据 / 端口 / 域名 / IP 字面量。
 * **不做 DNS** —— IP 字面量在这里直接判，域名留到 `assertFetchableUrl` 解析后再判。
 */
export function assertAllowedUrl(url: URL): void {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new TargetRejectedError('只允许 http / https 地址');
  }
  if (url.username || url.password) {
    throw new TargetRejectedError('目标地址不允许携带用户名或密码');
  }
  const host = normalizeTargetHostname(url.hostname);
  if (!host) throw new TargetRejectedError('目标地址缺少主机名');
  const hostReason = blockedHostnameReason(host);
  if (hostReason) throw new TargetRejectedError(hostReason);

  if (url.port !== '') {
    const port = Number(url.port);
    if (!ALLOWED_TARGET_PORTS.includes(port)) {
      throw new TargetRejectedError(`只允许 80 / 443 端口（当前是 ${url.port}）`);
    }
  }

  const family = isIP(host);
  if (family !== 0) {
    const reason = blockedAddressReason(host);
    if (reason) throw new TargetRejectedError(`目标地址不允许：${reason}（${host}）`);
  }
}

/** 解析主机的全部地址（失败抛 TargetLookupError，不吞掉空结果）。 */
export async function resolveTargetAddresses(
  hostname: string,
  resolve: AddressResolver = defaultResolve
): Promise<string[]> {
  const host = normalizeTargetHostname(hostname);
  let addresses: string[];
  try {
    addresses = await resolve(host);
  } catch {
    throw new TargetLookupError(`无法解析域名 ${host}，请检查地址是否正确或稍后重试`);
  }
  if (!Array.isArray(addresses) || addresses.length === 0) {
    throw new TargetLookupError(`域名 ${host} 没有解析到任何地址`);
  }
  return addresses;
}

/** 解析结果里任一地址落在受限网段就拒绝。 */
export function assertPublicAddresses(hostname: string, addresses: readonly string[]): void {
  const host = normalizeTargetHostname(hostname);
  for (const address of addresses) {
    const reason = blockedAddressReason(address);
    if (reason) {
      throw new TargetRejectedError(`目标域名 ${host} 解析到受限地址：${reason}（${address}）`);
    }
  }
}

/**
 * 完整校验（含 DNS）。IP 字面量不解析，直接按地址判。
 * `resolve` 可注入替身，单测因此完全不需要联网。
 */
export async function assertFetchableUrl(
  url: URL,
  resolve: AddressResolver = defaultResolve
): Promise<void> {
  assertAllowedUrl(url);
  const host = normalizeTargetHostname(url.hostname);
  if (isIP(host) !== 0) return; // 字面量已在 assertAllowedUrl 判过，跳过 DNS
  const addresses = await resolveTargetAddresses(host, resolve);
  assertPublicAddresses(host, addresses);
}
