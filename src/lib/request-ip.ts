// 客户端 IP 只读取入口 nginx 覆盖的 X-Real-IP，绝不回退到客户端可控的
// CF-Connecting-IP / X-Forwarded-For。信任边界由部署保证：Next 仅监听回环，
// nginx 覆盖该头；Cloudflare 的真实 IP 只可由 nginx 的可信 CIDR real_ip 配置还原。
// 详见 docs/deploy.md §6/§7。Request 没有 socket 地址，不能在这里验证代理身份。

import { isIP } from 'node:net';

/** 路由和服务端页面共用。缺失/非法时不使用占位 IP，调用方仍须保留用户和全局预算。 */
export function clientIp(req: { headers: Headers }): string | undefined {
  const raw = req.headers.get('x-real-ip')?.trim();
  if (!raw || raw.includes('%')) return undefined;
  const family = isIP(raw);
  if (family === 4) return raw;
  if (family !== 6) return undefined;

  // 归一大小写、压缩形态及 IPv4 映射，避免同一地址通过不同拼写轮换桶。
  const canonical = new URL(`http://[${raw}]/`).hostname.slice(1, -1);
  const mapped = /^::ffff:([0-9a-f]+):([0-9a-f]+)$/.exec(canonical);
  if (!mapped) return canonical;
  const high = parseInt(mapped[1], 16);
  const low = parseInt(mapped[2], 16);
  return [high >>> 8, high & 255, low >>> 8, low & 255].join('.');
}
