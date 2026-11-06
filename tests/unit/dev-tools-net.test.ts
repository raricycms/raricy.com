// ─────────────────────────────────────────────────────────────────────────────
// dev-tools-net.test.ts —— 网络与码家族的纯逻辑单测
//
// 只测**纯函数**：二维码（UTF-8 取字节 / 静区 / 布局）、条码（EAN-13 校验位、
// Code 128 编码表、Code 39 结构）、子网计算（IPv4 / IPv6 / BigInt）、
// net-guard（SSRF 判据，DNS 用注入替身，绝不联网）。
// 页面组件、真实 DNS、真实 HTTP 都不在这里测。
// ─────────────────────────────────────────────────────────────────────────────

import { describe, expect, it } from 'vitest';
import {
  QR_MIN_SIZE,
  QR_MAX_SIZE,
  QR_MIN_MARGIN_MODULES,
  qrTextBytes,
  renderQr,
  resolveQrLayout,
} from '@/lib/dev-tools/qr';
import {
  BARCODE_QUIET_MODULES,
  barcodeBars,
  barcodeSvg,
  ean13CheckDigit,
  encodeBarcode,
  normalizeEan13,
  type BarcodeSymbol,
} from '@/lib/dev-tools/barcode';
import {
  formatIpv6,
  intToIpv4,
  ipv4ToInt,
  parseIpv6,
  parseSubnetInput,
} from '@/lib/dev-tools/subnet';
import {
  TargetLookupError,
  TargetRejectedError,
  assertAllowedUrl,
  assertFetchableUrl,
  blockedAddressReason,
  blockedHostnameReason,
  blockedIpv4Reason,
  blockedIpv6Reason,
  normalizeTargetHostname,
} from '@/lib/dev-tools/net-guard';

// ── 二维码 ──────────────────────────────────────────────────────────────────

describe('qr：UTF-8 取字节（中文不乱码的关键）', () => {
  it('中文按 UTF-8 编码，而不是 Latin-1 截断', () => {
    // '中' = U+4E2D → UTF-8 是 E4 B8 AD；Latin-1 会截成 0x2D（'-'）
    expect(qrTextBytes('中')).toEqual([0xe4, 0xb8, 0xad]);
    expect(qrTextBytes('中文')).toEqual([0xe4, 0xb8, 0xad, 0xe6, 0x96, 0x87]);
  });

  it('ASCII 与 emoji 也都是标准 UTF-8 字节', () => {
    expect(qrTextBytes('A')).toEqual([65]);
    expect(qrTextBytes('😀')).toEqual([0xf0, 0x9f, 0x98, 0x80]);
  });
});

describe('qr：布局与静区', () => {
  it('静区不允许低于 4 个模块，且 marginPx 与 cellSize 严格对应', () => {
    const layout = resolveQrLayout(25, 256, 0);
    expect(layout.marginModules).toBe(QR_MIN_MARGIN_MODULES);
    expect(layout.cellSize).toBe(Math.floor(256 / (25 + QR_MIN_MARGIN_MODULES * 2)));
    expect(layout.marginPx).toBe(layout.marginModules * layout.cellSize);
    expect(layout.pixelSize).toBe(25 * layout.cellSize + layout.marginPx * 2);
  });

  it('目标尺寸被夹到 128–512，模块数过多时 cellSize 退到 1 而不是 0', () => {
    // 目标尺寸是**上限**：size=10 被夹到 128，cellSize = floor(128 / 33) = 3，
    // 所以输出像素是 99 而不是 128 —— 这里钉住夹取行为本身。
    const clamped = resolveQrLayout(25, 10, 4);
    expect(clamped.cellSize).toBe(Math.floor(QR_MIN_SIZE / (25 + 4 * 2)));
    expect(clamped.pixelSize).toBeLessThanOrEqual(QR_MIN_SIZE);
    const big = resolveQrLayout(177, 4096, 4);
    expect(big.cellSize).toBeGreaterThanOrEqual(1);
    expect(big.pixelSize).toBeLessThanOrEqual(QR_MAX_SIZE);
    expect(resolveQrLayout(177, 512, 4).cellSize).toBe(Math.floor(QR_MAX_SIZE / (177 + 4 * 2)));
  });
});

describe('qr：生成结果', () => {
  it('中文内容能生成，data URL 与 SVG 都拿得到', () => {
    const result = renderQr('中文链接 https://raricy.com/中文', { level: 'Q', size: 256 });
    expect(result.dataUrl.startsWith('data:image/gif;base64,')).toBe(true);
    expect(result.svg.startsWith('<svg')).toBe(true);
    expect(result.svg).toContain('fill="white"');
    expect(result.moduleCount).toBeGreaterThanOrEqual(21);
    expect(result.marginModules).toBeGreaterThanOrEqual(QR_MIN_MARGIN_MODULES);
    expect(result.pixelSize).toBeLessThanOrEqual(256);
    expect(result.marginPx).toBe(result.marginModules * result.cellSize);
  });

  it('空内容与超长内容给出中文错误', () => {
    expect(() => renderQr('   ')).toThrow(/请输入/);
    expect(() => renderQr('x'.repeat(2001))).toThrow(/最多/);
  });

  it('未超本工具上限但超二维码容量 → 「超出容量」提示可达（R3-496）', () => {
    // qrcode-generator 内部 `throw 'code length overflow…'`（字符串，不是 Error）。
    // 只认 e.message 的话这里永远落到「未知错误」，容量提示不可达。
    expect(() => renderQr('x'.repeat(1500), { level: 'H' })).toThrow(/超出二维码容量/);
  });
});

// ── 条形码 ──────────────────────────────────────────────────────────────────

describe('barcode：EAN-13 校验位', () => {
  it('已知样例的校验位', () => {
    // 590123412345 → 7（公开样例）；400638133393 → 1
    expect(ean13CheckDigit('590123412345')).toBe(7);
    expect(ean13CheckDigit('400638133393')).toBe(1);
  });

  it('12 位自动补校验位，13 位校验位错误必须报错', () => {
    const normalized = normalizeEan13('590123412345');
    expect(normalized.digits).toBe('5901234123457');
    expect(normalized.note).toContain('自动补');
    expect(normalizeEan13('5901234123457').note).toContain('校验位正确');
    expect(() => normalizeEan13('5901234123450')).toThrow(/校验位不正确/);
    expect(() => normalizeEan13('12345')).toThrow(/12 位或 13 位/);
  });

  it('编码结果是 95 模块，起止都是 101', () => {
    const symbol = encodeBarcode('ean13', '5901234123457');
    expect(symbol.modules).toHaveLength(95);
    const bits = symbol.modules.map((dark) => (dark ? '1' : '0')).join('');
    expect(bits.startsWith('101')).toBe(true);
    expect(bits.endsWith('101')).toBe(true);
  });
});

describe('barcode：Code 128', () => {
  /** 由宽度串展开成模块位串（测试里独立实现，避免直接复用生产代码）。 */
  function widthsToBits(pattern: string): string {
    let dark = true;
    let bits = '';
    for (const ch of pattern) {
      bits += (dark ? '1' : '0').repeat(Number(ch));
      dark = !dark;
    }
    return bits;
  }

  it('ASCII 文本用 B 子集，模块数 = 11 × 符号数（Stop 13）', () => {
    // 'A'：Start B(104) + 33 + 校验位 34 + Stop(106) = 4 个符号
    // 校验位 = (104 + 33×1) % 103 = 34
    const symbol = encodeBarcode('code128', 'A');
    expect(symbol.modules).toHaveLength(11 * 3 + 13);
    const bits = symbol.modules.map((dark) => (dark ? '1' : '0')).join('');
    expect(bits.slice(0, 11)).toBe(widthsToBits('211214')); // Start B
    expect(bits.slice(11, 22)).toBe(widthsToBits('111323')); // 'A'
    expect(bits.slice(22, 33)).toBe(widthsToBits('131123')); // 校验位 34
    expect(bits.slice(33)).toBe(widthsToBits('2331112')); // Stop
  });

  it('整串数字自动走 C 子集（两位一符号）', () => {
    const symbol = encodeBarcode('code128', '1234');
    // Start C + '12' + '34' + 校验位 + Stop = 5 个符号
    expect(symbol.modules).toHaveLength(11 * 4 + 13);
    expect(symbol.note).toContain('C 子集');
    expect(symbol.modules.map((dark) => (dark ? '1' : '0')).join('').slice(0, 11)).toBe(
      widthsToBits('211232') // Start C
    );
  });

  it('奇数个数字：C 压缩 + 末位落回 B', () => {
    const symbol = encodeBarcode('code128', '12345');
    // Start C + 12 + 34 + Code B + '5' + 校验位 + Stop = 7 个符号
    expect(symbol.modules).toHaveLength(11 * 6 + 13);
  });

  it('不支持的字符直接报错，不做静默替换', () => {
    expect(() => encodeBarcode('code128', '中文')).toThrow(/ASCII/);
    expect(() => encodeBarcode('code128', '')).toThrow(/请输入/);
  });
});

describe('barcode：Code 39', () => {
  it('每字符 15 模块 + 字符间 1 模块间隔，含起止符 *', () => {
    // '*ABC*' = 5 个字符 → 5×15 + 4 个间隔 = 79
    const symbol = encodeBarcode('code39', 'ABC');
    expect(symbol.modules).toHaveLength(79);
    expect(symbol.note).toContain('无校验位');
  });

  it('字符集校验：不接受小写字母与未登记符号', () => {
    expect(() => encodeBarcode('code39', 'abc')).toThrow(/大写字母/);
    expect(() => encodeBarcode('code39', 'A#B')).toThrow(/只支持/);
    expect(() => encodeBarcode('code39', '')).toThrow(/请输入/);
    expect(encodeBarcode('code39', 'A-1 $/+%').modules.length).toBeGreaterThan(0);
  });
});

describe('barcode：矩形与 SVG 渲染', () => {
  it('barcodeBars 从静区之后开始，总宽 = 编码宽 + 两侧静区', () => {
    const symbol = encodeBarcode('ean13', '5901234123457');
    const { bars, totalWidth } = barcodeBars(symbol, BARCODE_QUIET_MODULES);
    expect(totalWidth).toBe(symbol.modules.length + BARCODE_QUIET_MODULES * 2);
    expect(bars[0].x).toBe(BARCODE_QUIET_MODULES);
    const dark = symbol.modules.filter(Boolean).length;
    expect(bars.reduce((sum, bar) => sum + bar.width, 0)).toBe(dark);
    expect(bars.some((bar) => bar.width > 1)).toBe(true);
  });

  it('下载用 SVG 是白底黑条，且文本被转义', () => {
    const symbol: BarcodeSymbol = {
      format: 'code39',
      label: 'Code 39',
      text: '<A&B>',
      modules: [true, false, true, true],
      note: '',
    };
    const svg = barcodeSvg(symbol);
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg.endsWith('</svg>')).toBe(true);
    expect(svg).toContain('fill="#fff"');
    expect(svg).toContain('fill="#000"');
    expect(svg).toContain('&lt;A&amp;B&gt;');
    expect(svg).not.toContain('<A&B>');
  });
});

// ── 子网计算 ────────────────────────────────────────────────────────────────

describe('subnet：IPv4', () => {
  const v4 = (input: string) => {
    const result = parseSubnetInput(input);
    if (result.version !== 4) throw new Error('expected IPv4 result');
    return result;
  };

  it('/24 的完整结果', () => {
    const result = v4('192.168.1.10/24');
    expect(result.cidr).toBe('192.168.1.0/24');
    expect(result.network).toBe('192.168.1.0');
    expect(result.broadcast).toBe('192.168.1.255');
    expect(result.netmask).toBe('255.255.255.0');
    expect(result.wildcard).toBe('0.0.0.255');
    expect(result.firstHost).toBe('192.168.1.1');
    expect(result.lastHost).toBe('192.168.1.254');
    expect(result.usableHosts).toBe(254);
    expect(result.totalAddresses).toBe(256);
    expect(result.addressClass).toContain('C 类');
  });

  it('/31 按 RFC 3021 两点点对点，/32 单主机', () => {
    const p31 = v4('10.0.0.0/31');
    expect(p31.firstHost).toBe('10.0.0.0');
    expect(p31.lastHost).toBe('10.0.0.1');
    expect(p31.usableHosts).toBe(2);

    const p32 = v4('10.0.0.7/32');
    expect(p32.firstHost).toBe('10.0.0.7');
    expect(p32.lastHost).toBe('10.0.0.7');
    expect(p32.usableHosts).toBe(1);
    expect(p32.totalAddresses).toBe(1);
  });

  it('/0 的地址总数是 2^32，且 number 精确', () => {
    const result = v4('0.0.0.0/0');
    expect(result.totalAddresses).toBe(4294967296);
    expect(result.usableHosts).toBe(4294967294);
    expect(result.netmask).toBe('0.0.0.0');
    expect(result.wildcard).toBe('255.255.255.255');
  });

  it('支持空格写法与 public 辅助函数', () => {
    expect(v4('192.168.0.0 16').broadcast).toBe('192.168.255.255');
    expect(ipv4ToInt('0.0.0.1')).toBe(1);
    expect(ipv4ToInt('255.255.255.255')).toBe(0xffffffff);
    expect(ipv4ToInt('256.0.0.1')).toBeNull();
    expect(intToIpv4(0)).toBe('0.0.0.0');
  });

  it('非法输入报中文错误', () => {
    expect(() => parseSubnetInput('')).toThrow(/请输入/);
    expect(() => parseSubnetInput('192.168.1.1')).toThrow(/缺少前缀长度/);
    expect(() => parseSubnetInput('192.168.1.0/33')).toThrow(/0–32/);
    expect(() => parseSubnetInput('192.168.1.256/24')).toThrow(/不是合法的 IPv4/);
    expect(() => parseSubnetInput('192.168.1.0/24/8')).toThrow(/一个斜杠/);
  });
});

describe('subnet：IPv6', () => {
  const v6 = (input: string) => {
    const result = parseSubnetInput(input);
    if (result.version !== 6) throw new Error('expected IPv6 result');
    return result;
  };

  it('/64 的总数是 BigInt 的 2^64，首尾地址正确', () => {
    const result = v6('2001:db8::1/64');
    expect(result.cidr).toBe('2001:db8::/64');
    expect(result.network).toBe('2001:db8::');
    expect(result.firstAddress).toBe('2001:db8::');
    expect(result.lastAddress).toBe('2001:db8::ffff:ffff:ffff:ffff');
    expect(result.totalAddresses).toBe(2n ** 64n);
  });

  it('/128 只有 1 个地址', () => {
    const result = v6('2001:db8::1/128');
    expect(result.totalAddresses).toBe(1n);
    expect(result.firstAddress).toBe('2001:db8::1');
    expect(result.lastAddress).toBe('2001:db8::1');
  });

  it('/0 的总数是 2^128', () => {
    expect(v6('::/0').totalAddresses).toBe(2n ** 128n);
  });

  it('RFC 5952 压缩：最长零段用 ::，平手取最左', () => {
    expect(formatIpv6(0n)).toBe('::');
    expect(formatIpv6(1n)).toBe('::1');
    const parsed = parseIpv6('2001:0db8:0000:0000:0000:0000:0000:0001');
    expect(parsed).not.toBeNull();
    expect(formatIpv6(parsed as bigint)).toBe('2001:db8::1');
    // 两个同样长的零段 → 压缩最左的那个
    expect(formatIpv6(parseIpv6('1:0:0:1:0:0:1:1') as bigint)).toBe('1::1:0:0:1:1');
  });

  it('支持内嵌 IPv4 写法，非法输入报错', () => {
    expect(formatIpv6(parseIpv6('::ffff:192.168.0.1') as bigint)).toBe('::ffff:c0a8:1');
    expect(parseIpv6('1:2:3:4:5:6:7:8')).not.toBeNull();
    expect(parseIpv6('1:2:3:4:5:6:7')).toBeNull();
    expect(parseIpv6('1::2::3')).toBeNull();
    expect(parseIpv6('gggg::1')).toBeNull();
    expect(() => parseSubnetInput('2001:db8::/129')).toThrow(/0–128/);
  });
});

// ── SSRF 判据 ───────────────────────────────────────────────────────────────

describe('net-guard：IPv4 私网 / 保留地址', () => {
  it('拒绝清单里的网段全部命中', () => {
    const blocked = [
      '0.0.0.0',
      '10.1.2.3',
      '100.64.0.1',
      '127.0.0.1',
      '169.254.169.254',
      '172.16.0.1',
      '172.31.255.255',
      '192.0.0.1',
      '192.0.2.1',
      '192.88.99.1',
      '192.168.0.1',
      '198.18.0.1',
      '198.51.100.1',
      '203.0.113.1',
      '224.0.0.1',
      '240.0.0.1',
      '255.255.255.255',
    ];
    for (const ip of blocked) {
      const value = ipv4ToInt(ip);
      expect(value, ip).not.toBeNull();
      expect(blockedIpv4Reason(value as number), ip).not.toBeNull();
    }
  });

  it('公网地址放行', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.32.0.1', '192.169.0.1']) {
      const value = ipv4ToInt(ip);
      expect(value, ip).not.toBeNull();
      expect(blockedIpv4Reason(value as number), ip).toBeNull();
    }
  });
});

describe('net-guard：IPv6 私网 / 保留地址', () => {
  function v6(text: string): bigint {
    const value = parseIpv6(text);
    if (value === null) throw new Error(`测试用 IPv6 非法：${text}`);
    return value;
  }

  it('拒绝回环 / 唯一本地 / 链路本地 / 组播 / 文档 / 隧道地址', () => {
    for (const text of [
      '::',
      '::1',
      'fc00::1',
      'fd12:3456::1',
      'fe80::1',
      'ff02::1',
      '2001:db8::1',
      '2001::1',
      '2002::1',
      'fec0::1',
      '64:ff9b::1',
      '100::1',
    ]) {
      expect(blockedIpv6Reason(v6(text)), text).not.toBeNull();
    }
  });

  it('IPv4 映射按 IPv4 判：映射到 127.0.0.1 拒绝，映射到 8.8.8.8 放行', () => {
    expect(blockedIpv6Reason(v6('::ffff:127.0.0.1'))).toContain('IPv4 映射');
    expect(blockedIpv6Reason(v6('::ffff:10.0.0.1'))).not.toBeNull();
    expect(blockedIpv6Reason(v6('::ffff:8.8.8.8'))).toBeNull();
  });

  it('公网 IPv6 放行', () => {
    expect(blockedIpv6Reason(v6('2606:4700:4700::1111'))).toBeNull();
    expect(blockedIpv6Reason(v6('2001:4860:4860::8888'))).toBeNull();
  });

  it('blockedAddressReason 对任意 IP 字面量统一判断', () => {
    expect(blockedAddressReason('127.0.0.1')).not.toBeNull();
    expect(blockedAddressReason('::1')).not.toBeNull();
    expect(blockedAddressReason('8.8.8.8')).toBeNull();
    expect(blockedAddressReason('not-an-ip')).not.toBeNull();
  });
});

describe('net-guard：URL 级判据', () => {
  it('只允许 http / https', () => {
    expect(() => assertAllowedUrl(new URL('ftp://example.com/'))).toThrow(TargetRejectedError);
    expect(() => assertAllowedUrl(new URL('file:///etc/passwd'))).toThrow(TargetRejectedError);
    expect(() => assertAllowedUrl(new URL('https://example.com/'))).not.toThrow();
  });

  it('端口只允许 80 / 443（默认端口算合法）', () => {
    expect(() => assertAllowedUrl(new URL('https://example.com:8443/'))).toThrow(/80 \/ 443/);
    expect(() => assertAllowedUrl(new URL('http://example.com:8080/'))).toThrow(/80 \/ 443/);
    expect(() => assertAllowedUrl(new URL('http://example.com/'))).not.toThrow();
    expect(() => assertAllowedUrl(new URL('https://example.com:443/'))).not.toThrow();
    expect(() => assertAllowedUrl(new URL('http://example.com:443/'))).not.toThrow();
  });

  it('不许带用户名密码', () => {
    expect(() => assertAllowedUrl(new URL('http://user:pass@example.com/'))).toThrow(/用户名或密码/);
  });

  it('本机 / 内网域名与 IP 字面量被拒绝', () => {
    expect(() => assertAllowedUrl(new URL('http://localhost/'))).toThrow(/本机域名/);
    expect(() => assertAllowedUrl(new URL('http://foo.localhost/'))).toThrow(/内网域名/);
    expect(() => assertAllowedUrl(new URL('http://nas.local/'))).toThrow(/内网域名/);
    expect(() => assertAllowedUrl(new URL('http://metadata.internal/'))).toThrow(/内网域名/);
    expect(() => assertAllowedUrl(new URL('http://127.0.0.1/'))).toThrow(/回环/);
    expect(() => assertAllowedUrl(new URL('http://[::1]/'))).toThrow(/回环/);
    expect(() => assertAllowedUrl(new URL('http://93.184.216.34/'))).not.toThrow();
  });

  it('hostname 归一：大小写、IPv6 括号、末尾点', () => {
    expect(normalizeTargetHostname('[::1]')).toBe('::1');
    expect(normalizeTargetHostname('LOCALHOST.')).toBe('localhost');
    expect(blockedHostnameReason('example.com')).toBeNull();
    expect(blockedHostnameReason('Example.COM')).toBeNull();
  });
});

describe('net-guard：DNS 解析（注入替身，不联网）', () => {
  it('任一解析地址落在私网就拒绝', async () => {
    await expect(
      assertFetchableUrl(new URL('http://example.com/'), async () => [
        '93.184.216.34',
        '10.0.0.1',
      ])
    ).rejects.toBeInstanceOf(TargetRejectedError);
  });

  it('全部是公网地址则放行', async () => {
    await expect(
      assertFetchableUrl(new URL('http://example.com/'), async () => ['93.184.216.34'])
    ).resolves.toBeUndefined();
  });

  it('解析失败抛 TargetLookupError，空结果也拒绝', async () => {
    await expect(
      assertFetchableUrl(new URL('http://example.com/'), async () => {
        throw new Error('dns failure');
      })
    ).rejects.toBeInstanceOf(TargetLookupError);
    await expect(
      assertFetchableUrl(new URL('http://example.com/'), async () => [])
    ).rejects.toBeInstanceOf(TargetLookupError);
  });

  it('IP 字面量不做 DNS（解析器根本不会被调用）', async () => {
    const failIfCalled = async (): Promise<string[]> => {
      throw new Error('IP 字面量不应该触发 DNS');
    };
    await expect(
      assertFetchableUrl(new URL('http://93.184.216.34/'), failIfCalled)
    ).resolves.toBeUndefined();
  });
});
