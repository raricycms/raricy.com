// request-ip.ts —— 反代 / Cloudflare 之后取真实客户端 IP。
//
// 【为什么值得单独测】它是全站唯一按 IP 分桶的限频的输入。取错一个头，或取不到时
// 返回一个占位串，后果都是静默的：要么把所有人并进同一个桶（一个人刷满就挡住全站），
// 要么让攻击者换一个头就绕开配额。两者都不会报错。
//
// 另有一组专门钉「两种形状都收」—— 那是第 2 期把签名从 `Request` 拓宽成
// `{ headers: Headers }` 的**全部理由**（页面侧拿不到 Request，只有 `headers()`）。
// 没有那组断言的话，下一个人把签名改回 `Request` 时不会有人发现 —— 直到
// `/explore` 的限频在某次重构后静默失效。

import { describe, it, expect } from 'vitest';
import { clientIp } from '@/lib/request-ip';

describe('clientIp / 取值优先级', () => {
  it('cf-connecting-ip 优先于 x-forwarded-for（CF 会覆写它，客户端伪造不了）', () => {
    const headers = new Headers({
      'cf-connecting-ip': '1.2.3.4',
      'x-forwarded-for': '9.9.9.9, 8.8.8.8',
    });
    expect(clientIp(new Request('https://raricy.com/', { headers }))).toBe('1.2.3.4');
  });

  it('没有 cf 头时取 x-forwarded-for 的**第一个**（最左 = 原始客户端，右面是各级代理）', () => {
    const headers = new Headers({ 'x-forwarded-for': '1.2.3.4, 10.0.0.1, 10.0.0.2' });
    expect(clientIp(new Request('https://raricy.com/', { headers }))).toBe('1.2.3.4');
  });

  it('去掉 x-forwarded-for 条目两侧的空白（真实代理常写成 "1.2.3.4, 5.6.7.8"）', () => {
    const headers = new Headers({ 'x-forwarded-for': '  1.2.3.4  , 5.6.7.8' });
    expect(clientIp(new Request('https://raricy.com/', { headers }))).toBe('1.2.3.4');
  });

  it('单条 x-forwarded-for 也照常返回', () => {
    const headers = new Headers({ 'x-forwarded-for': '1.2.3.4' });
    expect(clientIp(new Request('https://raricy.com/', { headers }))).toBe('1.2.3.4');
  });

  it('不读 x-real-ip（本站的 nginx 配置不透传它，读了只会得到一个恒 undefined 的维度）', () => {
    const headers = new Headers({ 'x-real-ip': '1.2.3.4' });
    expect(clientIp(new Request('https://raricy.com/', { headers }))).toBeUndefined();
  });
});

describe('clientIp / 取不到时返回 undefined —— **绝不是**占位串', () => {
  const withHeaders = (h: Record<string, string>) =>
    clientIp(new Request('https://raricy.com/', { headers: new Headers(h) }));

  it('两个头都没有（直连 / 本地开发）→ undefined', () => {
    expect(withHeaders({})).toBeUndefined();
  });

  it('【回归】空字符串的 x-forwarded-for → undefined，**不是** ""', () => {
    // 这条逮到过一个真实缺陷：原实现用 `??` 串两级，而 `??` 只认 null/undefined，
    // 于是 `''.split(',')[0].trim()` 得到的 `''` 被当成有效值一路返回 —— 所有
    // 「头存在但为空」的请求落进同一个 '' 桶，一个人刷满就把别人全挡在门外。
    expect(withHeaders({ 'x-forwarded-for': '' })).toBeUndefined();
    expect(withHeaders({ 'x-forwarded-for': '   ' })).toBeUndefined();
    expect(withHeaders({ 'x-forwarded-for': ',,,' }), '只有逗号时首段为空').toBeUndefined();
  });

  it('【回归】空的 cf-connecting-ip 不能挡住后面的 x-forwarded-for', () => {
    expect(
      withHeaders({ 'cf-connecting-ip': '', 'x-forwarded-for': '1.2.3.4' }),
      '空的首选头应当让位给兜底头'
    ).toBe('1.2.3.4');
  });

  it('★ 返回的从不是 "unknown" 之类占位串 —— 调用方据此**跳过**该维度，而不是共用一个桶', () => {
    const got = withHeaders({});
    expect(got).not.toBe('unknown');
    expect(got).not.toBe('0.0.0.0');
    expect(got === undefined).toBe(true);
  });
});

// 上面所有用例走的都是 `Request` 形状（route handler 那条路）。这一组补另一条：
// **页面 / 服务端组件**里拿不到 Request 对象，只有 `await headers()`。
// 签名从 `Request` 拓宽成 `{ headers: Headers }` 的全部理由就在这里。
describe('clientIp / 两种调用形状都收', () => {
  it('路线 B：直接喂一个 Headers（页面 / 服务端组件的形状）', () => {
    expect(clientIp({ headers: new Headers({ 'cf-connecting-ip': '5.6.7.8' }) })).toBe('5.6.7.8');
    expect(clientIp({ headers: new Headers({ 'x-forwarded-for': '5.6.7.8, 10.0.0.1' }) })).toBe(
      '5.6.7.8'
    );
    expect(clientIp({ headers: new Headers() })).toBeUndefined();
  });

  it('路线 A（Request）结构上满足 `{ headers }` —— 既有调用点一行都不用改', () => {
    const req = new Request('https://raricy.com/api/og/blog/x', {
      headers: { 'cf-connecting-ip': '1.2.3.4' },
    });
    // 同一个函数、同一种调用，只是多了一层类型上的兼容
    expect(clientIp(req)).toBe('1.2.3.4');
  });

  it('★ 两条路线对**同一组头**给出同一个结果（否则就是在两个桶里限频同一台机器）', () => {
    const raw = { 'x-forwarded-for': '1.2.3.4, 10.0.0.1' };
    expect(clientIp(new Request('https://raricy.com/', { headers: raw }))).toBe(
      clientIp({ headers: new Headers(raw) })
    );
  });
});
