import { describe, it, expect } from 'vitest';
import { clientIp } from '@/lib/request-ip';

const from = (headers: Record<string, string>) => clientIp({ headers: new Headers(headers) });

describe('可信入口 IP', () => {
  it('只读 nginx 覆盖的 X-Real-IP，伪造 CF/XFF 不影响桶', () => {
    expect(from({ 'x-real-ip': '203.0.113.7', 'cf-connecting-ip': '1.1.1.1', 'x-forwarded-for': '2.2.2.2' })).toBe('203.0.113.7');
    expect(from({ 'cf-connecting-ip': '1.1.1.1', 'x-forwarded-for': '2.2.2.2' })).toBeUndefined();
  });
  it.each(['', ' ', 'unknown', '1.1.1.1, 2.2.2.2', '999.1.1.1', '1.1.1.1:80', 'fe80::1%eth0', '[::1]'])('非法 IP %s 不进入限频桶', (ip) => {
    expect(from({ 'x-real-ip': ip })).toBeUndefined();
  });
  it('缺少 IP 不把所有人并入占位桶', () => expect(from({})).toBeUndefined());
  it('去除空白并归一 IPv6 拼写和映射 IPv4', () => {
    expect(from({ 'x-real-ip': ' 203.0.113.7 ' })).toBe('203.0.113.7');
    expect(from({ 'x-real-ip': '2001:0DB8:0:0:0:0:0:1' })).toBe('2001:db8::1');
    expect(from({ 'x-real-ip': '::ffff:203.0.113.7' })).toBe('203.0.113.7');
    expect(from({ 'x-real-ip': '0:0:0:0:0:FFFF:cb00:7107' })).toBe('203.0.113.7');
  });
  it('Request 与页面 headers 的调用形状给出同一值', () => {
    const headers = new Headers({ 'x-real-ip': '203.0.113.7' });
    expect(clientIp(new Request('https://raricy.com/', { headers }))).toBe(clientIp({ headers }));
  });
});
