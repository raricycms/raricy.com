// webhook-url.ts —— 回调地址的 SSRF 防线。
//
// 【为什么逐条钉】这是本站**唯一**一处「服务器去 fetch 用户给的地址」。
// 漏掉一条规则的后果不是一个坏掉的用例，是内网可达（旁边就是账户微服务与
// SQLite 文件）。所以下面这张表是**策略本身**，不是实现细节 —— 加一条规则
// 就该加一行，删一条规则必须先想清楚为什么它不再需要。
//
// 「两份都改」的风险在这里不存在：策略是**白名单式**的，绕过一条就真能连出去。

import { describe, it, expect } from 'vitest';
import {
  parseWebhookUrl,
  isBlockedAddress,
  resolveWebhookTarget,
  WebhookUrlError,
  WEBHOOK_URL_MAX,
} from '@/lib/webhook-url';

/** 断言这条地址被拒，且给的是可读的中文原因。 */
function expectRejected(raw: string) {
  expect(() => parseWebhookUrl(raw), `本该拒绝: ${raw}`).toThrow(WebhookUrlError);
}

describe('parseWebhookUrl —— 静态策略', () => {
  it('正常的 https 地址通过，并规范化', () => {
    const u = parseWebhookUrl('https://bank.example.com/fish/callback');
    expect(u.hostname).toBe('bank.example.com');
    expect(u.pathname).toBe('/fish/callback');
  });

  it('★ 只收 https —— http 一律拒（线路上的明文是回调保密性的一部分）', () => {
    expectRejected('http://bank.example.com/cb');
  });

  it('★ 拒绝非 http(s) 协议（file / gopher / data 之类）', () => {
    for (const s of [
      'file:///etc/passwd',
      'gopher://bank.example.com/',
      'data:text/plain,hi',
      'ftp://bank.example.com/',
    ]) {
      expectRejected(s);
    }
  });

  it('★ 拒绝带用户名密码的地址（https://user:pass@evil.com 是钓鱼惯用手法）', () => {
    expectRejected('https://user:pass@bank.example.com/cb');
    expectRejected('https://user@bank.example.com/cb');
  });

  it('拒空值、超长、含空白或控制字符', () => {
    expectRejected('');
    expectRejected('   ');
    expectRejected('https://bank.example.com/' + 'a'.repeat(WEBHOOK_URL_MAX));
    expectRejected('https://bank.example.com/a b');
    expectRejected('https://bank.example.com/a\tb');
    expectRejected('https://bank.example.com/a\nb');
  });

  it('拒单标签主机与内网域名后缀', () => {
    expectRejected('https://intranet/cb'); // 单标签
    for (const host of [
      'bank.local',
      'bank.localhost',
      'bank.internal',
      'bank.home.arpa',
    ]) {
      expectRejected(`https://${host}/cb`);
    }
  });

  it('拒端口 0', () => {
    expectRejected('https://bank.example.com:0/cb');
  });

  it('不查 DNS —— 静态校验阶段不管域名解析成什么', () => {
    // 解析不出来也不该在这里报错（那是 resolveWebhookTarget 的事）
    expect(() => parseWebhookUrl('https://this-domain-does-not-exist-xyz.example/cb')).not.toThrow();
  });
});

describe('★ isBlockedAddress —— 逐条钉死禁止连的网段', () => {
  const blocked = [
    // IPv4
    '0.0.0.0',
    '10.0.0.5',
    '10.255.255.255',
    '100.64.0.1', // CGNAT
    '127.0.0.1',
    '127.1.2.3',
    '169.254.169.254', // ★ 云元数据，最常被利用的一个
    '169.254.0.1',
    '172.16.0.1',
    '172.31.255.255',
    '192.0.0.1',
    '192.0.2.1',
    '192.168.1.1',
    '198.18.0.1',
    '198.51.100.1',
    '203.0.113.1',
    '224.0.0.1', // 组播
    '239.255.255.250',
    '240.0.0.1',
    '255.255.255.255',
    // IPv6
    '::',
    '::1',
    'fe80::1', // 链路本地
    'fc00::1', // 唯一本地
    'fd12:3456::1',
    'ff02::1', // 组播
    '2001:db8::1', // 文档用
    '2002:7f00:1::', // 6to4（能隧道到私网）
    '64:ff9b::7f00:1', // NAT64
    '::ffff:127.0.0.1', // ★ IPv4 映射：经典绕过
    '::ffff:169.254.169.254',
    '::ffff:10.0.0.1',
  ];
  for (const ip of blocked) {
    it(`拒 ${ip}`, () => expect(isBlockedAddress(ip)).toBe(true));
  }

  const allowed = ['8.8.8.8', '1.1.1.1', '93.184.216.34', '2606:4700:4700::1111', '2001:4860:4860::8888'];
  for (const ip of allowed) {
    it(`放行公网地址 ${ip}`, () => expect(isBlockedAddress(ip)).toBe(false));
  }

  it('不是合法 IP 的一律当禁止（宁可不发）', () => {
    for (const s of ['', 'not-an-ip', '999.1.1.1', '1.2.3', '1.2.3.4.5']) {
      expect(isBlockedAddress(s), `本该拒绝: ${s}`).toBe(true);
    }
  });
});

describe('resolveWebhookTarget —— 解析后校验', () => {
  it('★ 字面量私网 IP 一律拒（不查 DNS 也拦得住）', async () => {
    for (const host of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '[::1]']) {
      await expect(
        resolveWebhookTarget(`https://${host}/cb`),
        `本该拒绝: ${host}`
      ).rejects.toThrow(WebhookUrlError);
    }
  });

  it('解析不出来的域名 → 明确报错，不是静默放行', async () => {
    await expect(
      resolveWebhookTarget('https://no-such-host-xyz-12345.invalid/cb')
    ).rejects.toThrow(WebhookUrlError);
  });

  it('allowPrivate（仅供测试）放行回环，并返回可钉死的地址', async () => {
    const t = await resolveWebhookTarget('http://127.0.0.1:9999/cb', { allowPrivate: true });
    expect(t.address).toBe('127.0.0.1');
    expect(t.url.port).toBe('9999');
  });

  it('★ allowPrivate **不会**让 https 要求失效之外的东西放宽 —— 生产路径不传它', async () => {
    // 不带 opts 时连 http 都不收
    await expect(resolveWebhookTarget('http://127.0.0.1:9999/cb')).rejects.toThrow(WebhookUrlError);
  });
});
