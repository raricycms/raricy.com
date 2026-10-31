// ─────────────────────────────────────────────────────────────────────────────
// subnet.ts — 子网计算的纯逻辑（IPv4 / IPv6，零 React / 零 DOM）
//
// 【为什么分成两种结果形状】
//   · IPv4：网络地址 / 广播地址 / 掩码 / 通配符 / 首末可用 / 主机数 / 地址类别，
//     全部能用 number 精确表示（2^32 < Number.MAX_SAFE_INTEGER），所以用 number；
//   · IPv6：地址总数是 2^(128-prefix)，**只能用 BigInt**（数字类型会静默丢精度）。
//     这里把 BigInt 留在返回类型里，页面负责 `toString()` 展示 —— 中途转成 number
//     是最容易犯的错，且错了看不出来。
//
// 【/31 与 /32 的口径】按 RFC 3021：
//   · /31 两个地址都算可用（点对点链路），首 = 网络地址、尾 = 广播地址；
//   · /32 只有一个地址，首 = 尾 = 该地址，可用数 1。
// 传统计算器把它们显示成「0 个可用」是旧的 /30 口径遗留，会误导做点对点配置的人。
//
// 【IPv6 的「首尾地址」】IPv6 没有广播概念：首地址 = 网络前缀，尾地址 =
// 网络前缀 | 主机位全 1（即该前缀下最后一个地址）。
// ─────────────────────────────────────────────────────────────────────────────

export interface SubnetV4Result {
  version: 4;
  /** 原始输入（去掉首尾空白的原文）。 */
  input: string;
  /** 规范化 CIDR，例如 192.168.1.0/24。 */
  cidr: string;
  prefix: number;
  network: string;
  broadcast: string;
  netmask: string;
  wildcard: string;
  firstHost: string;
  lastHost: string;
  /** 可用主机数（/31 = 2、/32 = 1，见文件头）。 */
  usableHosts: number;
  /** 地址总数（含网络地址与广播地址）。 */
  totalAddresses: number;
  /** 地址类别（A/B/C/D/E）或特殊网段的说明。 */
  addressClass: string;
  /** 补充说明（/31、/32 的特殊口径等）。 */
  note: string;
}

export interface SubnetV6Result {
  version: 6;
  input: string;
  /** 规范化 CIDR，例如 2001:db8::/32。 */
  cidr: string;
  prefix: number;
  /** 规范化（RFC 5952 压缩）网络前缀。 */
  network: string;
  /** 首地址（= 网络前缀）。 */
  firstAddress: string;
  /** 尾地址（主机位全 1）。 */
  lastAddress: string;
  /** 地址总数 2^(128-prefix)，用 BigInt 保证不丢精度。 */
  totalAddresses: bigint;
  note: string;
}

export type SubnetResult = SubnetV4Result | SubnetV6Result;

// ── IPv4 基础运算 ────────────────────────────────────────────────────────────

/** 严格解析点分十进制 IPv4 → 无符号 32 位整数；非法返回 null。 */
export function ipv4ToInt(ip: string): number | null {
  const parts = ip.trim().split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value >>> 0;
}

/** 无符号 32 位整数 → 点分十进制。 */
export function intToIpv4(value: number): string {
  const n = value >>> 0;
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff].join('.');
}

/** 前缀长度 → IPv4 掩码（无符号 32 位整数）。 */
export function ipv4Mask(prefix: number): number {
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) {
    throw new Error('IPv4 前缀长度必须在 0–32 之间');
  }
  return prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
}

/** 地址类别（按地址首字节判，不按网络地址判）。 */
export function ipv4Class(value: number): string {
  const first = (value >>> 24) & 0xff;
  if (first === 0) return '0/8（保留，表示「本网络」）';
  if (first === 127) return '127/8（回环）';
  if (first <= 126) return 'A 类（1–126）';
  if (first <= 191) return 'B 类（128–191）';
  if (first <= 223) return 'C 类（192–223）';
  if (first <= 239) return 'D 类（224–239，组播）';
  return 'E 类（240–255，保留）';
}

// ── IPv6 基础运算 ────────────────────────────────────────────────────────────

const IPV6_GROUP = /^[0-9a-f]{1,4}$/i;

/**
 * 解析 IPv6 文本 → 128 位 BigInt；非法返回 null。
 *
 * 支持：`::` 压缩（至多一次、至少压缩一组）、完整的 8 组、末尾内嵌 IPv4
 * （如 `::ffff:192.168.0.1`）。不支持 zone id（`%eth0`）—— 那不是一个可路由地址。
 */
export function parseIpv6(input: string): bigint | null {
  const text = input.trim().toLowerCase();
  if (!text || !/^[0-9a-f:.]+$/.test(text)) return null;

  const halves = text.split('::');
  if (halves.length > 2) return null;
  const compressed = halves.length === 2;

  const splitGroups = (part: string): string[] => (part === '' ? [] : part.split(':'));
  const head = splitGroups(halves[0]);
  const tail = compressed ? splitGroups(halves[1]) : [];

  // 内嵌 IPv4 只可能出现在「整串地址的最后」：无压缩时在 head 末尾，有压缩时在 tail 末尾
  const endSide = compressed ? tail : head;
  if (endSide.length > 0) {
    const last = endSide[endSide.length - 1];
    if (last.includes('.')) {
      const v4 = ipv4ToInt(last);
      if (v4 === null) return null;
      endSide.splice(
        endSide.length - 1,
        1,
        ((v4 >>> 16) & 0xffff).toString(16),
        (v4 & 0xffff).toString(16)
      );
    }
  }

  const all = [...head, ...tail];
  if (compressed) {
    // '::' 至少代表一个全零组，所以显式组数必须 < 8
    if (all.length >= 8) return null;
  } else if (all.length !== 8) {
    return null;
  }
  for (const group of all) {
    if (!IPV6_GROUP.test(group)) return null;
  }

  const zeroCount = compressed ? 8 - all.length : 0;
  const groups = [...head, ...Array.from({ length: zeroCount }, () => '0'), ...tail];
  let value = 0n;
  for (const group of groups) {
    value = (value << 16n) | BigInt(parseInt(group, 16));
  }
  return value;
}

/** 128 位 BigInt → RFC 5952 规范的压缩小写文本（最长连续零组用 `::`，平手取最左）。 */
export function formatIpv6(value: bigint): string {
  if (value < 0n || value > (1n << 128n) - 1n) throw new Error('IPv6 数值超出 128 位范围');
  const groups: number[] = [];
  let rest = value;
  for (let i = 0; i < 8; i += 1) {
    groups.unshift(Number(rest & 0xffffn));
    rest >>= 16n;
  }

  let bestStart = -1;
  let bestLength = 0;
  for (let i = 0; i < 8; ) {
    if (groups[i] !== 0) {
      i += 1;
      continue;
    }
    let j = i;
    while (j < 8 && groups[j] === 0) j += 1;
    const length = j - i;
    if (length > bestLength) {
      bestStart = i;
      bestLength = length;
    }
    i = j;
  }

  const hex = groups.map((group) => group.toString(16));
  if (bestLength < 2) return hex.join(':');
  const before = hex.slice(0, bestStart).join(':');
  const after = hex.slice(bestStart + bestLength).join(':');
  return `${before}::${after}`;
}

/** 前缀长度 → IPv6 掩码（128 位 BigInt）。 */
export function ipv6Mask(prefix: number): bigint {
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 128) {
    throw new Error('IPv6 前缀长度必须在 0–128 之间');
  }
  const all = (1n << 128n) - 1n;
  return prefix === 0 ? 0n : all ^ ((1n << BigInt(128 - prefix)) - 1n);
}

// ── 输入解析 ────────────────────────────────────────────────────────────────

/**
 * 解析「CIDR」或「IP + 前缀」两种写法：
 *   · `192.168.1.0/24`、`192.168.1.0 24`；
 *   · `2001:db8::/32`、`2001:db8:: 32`。
 *
 * 输入非法一律抛**中文**错误（页面直接展示 message）。
 */
export function parseSubnetInput(raw: string): SubnetResult {
  const input = (raw ?? '').trim();
  if (!input) throw new Error('请输入 IP 地址或 CIDR，例如 192.168.1.0/24');

  let address = input;
  let prefixText: string | null = null;

  if (input.includes('/')) {
    const parts = input.split('/');
    if (parts.length !== 2) throw new Error('CIDR 只能包含一个斜杠，例如 192.168.1.0/24');
    address = parts[0].trim();
    prefixText = parts[1].trim();
  } else {
    const parts = input.split(/\s+/);
    if (parts.length === 2) {
      address = parts[0];
      prefixText = parts[1];
    } else if (parts.length > 2) {
      throw new Error('无法识别的输入格式，请使用 192.168.1.0/24 或 2001:db8::/32');
    }
  }

  if (!address) throw new Error('缺少 IP 地址');
  if (prefixText === null) {
    throw new Error('缺少前缀长度，请写成 192.168.1.0/24（IPv6 如 2001:db8::/32）');
  }
  if (!/^\d{1,3}$/.test(prefixText)) {
    throw new Error('前缀长度必须是整数：IPv4 为 0–32，IPv6 为 0–128');
  }
  const prefix = Number(prefixText);

  const isV6 = address.includes(':');
  if (isV6) return computeIpv6(input, address, prefix);
  return computeIpv4(input, address, prefix);
}

function computeIpv4(input: string, address: string, prefix: number): SubnetV4Result {
  if (prefix > 32) throw new Error('IPv4 前缀长度必须在 0–32 之间');
  const value = ipv4ToInt(address);
  if (value === null) {
    throw new Error(`不是合法的 IPv4 地址：${address}（每段应为 0–255 的十进制数字）`);
  }

  const mask = ipv4Mask(prefix);
  const network = (value & mask) >>> 0;
  const broadcast = (network | (~mask >>> 0)) >>> 0;
  const total = 2 ** (32 - prefix);

  let firstHost: number;
  let lastHost: number;
  let usableHosts: number;
  let note = '';
  if (prefix === 32) {
    firstHost = network;
    lastHost = network;
    usableHosts = 1;
    note = '/32 只有一个地址（单主机路由），首尾都是它本身';
  } else if (prefix === 31) {
    firstHost = network;
    lastHost = broadcast;
    usableHosts = 2;
    note = '/31 按 RFC 3021 视为点对点链路，首尾两个地址都可用';
  } else {
    firstHost = network + 1;
    lastHost = broadcast - 1;
    usableHosts = total - 2;
  }

  return {
    version: 4,
    input,
    cidr: `${intToIpv4(network)}/${prefix}`,
    prefix,
    network: intToIpv4(network),
    broadcast: intToIpv4(broadcast),
    netmask: intToIpv4(mask),
    wildcard: intToIpv4((~mask) >>> 0),
    firstHost: intToIpv4(firstHost),
    lastHost: intToIpv4(lastHost),
    usableHosts,
    totalAddresses: total,
    addressClass: ipv4Class(value),
    note,
  };
}

function computeIpv6(input: string, address: string, prefix: number): SubnetV6Result {
  if (prefix > 128) throw new Error('IPv6 前缀长度必须在 0–128 之间');
  const value = parseIpv6(address);
  if (value === null) {
    throw new Error(`不是合法的 IPv6 地址：${address}（可用 :: 压缩连续的全零组）`);
  }

  const hostBits = 128 - prefix;
  const mask = ipv6Mask(prefix);
  const network = value & mask;
  const last = network | ((1n << BigInt(hostBits)) - 1n);
  const totalAddresses = 1n << BigInt(hostBits);

  return {
    version: 6,
    input,
    cidr: `${formatIpv6(network)}/${prefix}`,
    prefix,
    network: formatIpv6(network),
    firstAddress: formatIpv6(network),
    lastAddress: formatIpv6(last),
    totalAddresses,
    note:
      prefix === 128
        ? '/128 只有一个地址（单主机路由）'
        : prefix === 127
          ? '/127 是 IPv6 点对点链路的常用前缀（RFC 6164）'
          : '',
  };
}
