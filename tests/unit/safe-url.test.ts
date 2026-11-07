// ─────────────────────────────────────────────────────────────────────────────
// safe-url.test.ts —— 登录回跳的开放重定向防护
//
// 【背景】登录一度**完全忽略** next：跳转硬编码 '/'，登录页那个 name="next" 的
// hidden input 从没被发送过。安全上因此没洞，但用户登录后回不到原页 —— 而这是本站
// 的既定契约：受保护页发现未登录就跳 /login?next=<原URL>，登录成功后回跳原页。
// 补回 next 的同时就引入了开放重定向的风险 —— next 来自 URL，攻击者可控。
//
// 攻击长这样：诱导用户点 https://raricy.com/login?next=https://evil.com，
// 用户在**我们自己的**登录页输完密码，然后被弹去钓鱼站。整个过程地址栏都是
// 可信域名，这正是它比普通钓鱼更危险的地方。
// ─────────────────────────────────────────────────────────────────────────────

import { describe, expect, it } from 'vitest';
import { safeNextPath, loginUrlWithNext, safeExternalReturnUrl } from '@/lib/safe-url';

describe('safeNextPath：只放行站内绝对路径', () => {
  it('站内路径原样放行', () => {
    expect(safeNextPath('/checkin')).toBe('/checkin');
    expect(safeNextPath('/fish/transactions')).toBe('/fish/transactions');
    expect(safeNextPath('/blog/abc-123?tab=1')).toBe('/blog/abc-123?tab=1');
  });

  it('空值回首页', () => {
    expect(safeNextPath(null)).toBe('/');
    expect(safeNextPath(undefined)).toBe('/');
    expect(safeNextPath('')).toBe('/');
  });

  it('★ 绝对 URL 一律拒绝（开放重定向）', () => {
    expect(safeNextPath('https://evil.com')).toBe('/');
    expect(safeNextPath('http://evil.com/phish')).toBe('/');
    expect(safeNextPath('javascript:alert(1)')).toBe('/');
    expect(safeNextPath('data:text/html,<script>alert(1)</script>')).toBe('/');
  });

  it('★ 协议相对 URL 一律拒绝 —— //evil.com 浏览器会当跨站跳转', () => {
    expect(safeNextPath('//evil.com')).toBe('/');
    expect(safeNextPath('//evil.com/phish')).toBe('/');
  });

  it('★ 反斜杠变体一律拒绝 —— 部分浏览器把 \\ 按 / 解析', () => {
    expect(safeNextPath('/\\evil.com')).toBe('/');
    expect(safeNextPath('/\\/evil.com')).toBe('/');
  });

  it('★ 控制字符变形一律拒绝 —— URL 解析器解析前会剥掉 TAB/LF/CR', () => {
    // `/<TAB>/evil.com` 经 new URL 解析后等于 `//evil.com` → 跨站跳转。
    // 它以 `/` 开头、也不含 `\`，上面逐条字符串检查全都看不见，必须单独挡。
    expect(safeNextPath('/\t/evil.com')).toBe('/');
    expect(safeNextPath('/\n/evil.com')).toBe('/');
    expect(safeNextPath('/\r/evil.com')).toBe('/');
    // 编码形态本身无害：URL 解析器不会把路径里的 %09 解码成 TAB，仍是站内。
    // 危险的是**解码后**的 TAB —— 那正是登录页 URLSearchParams 交给我们的东西。
    expect(
      new URL(safeNextPath('/%09/evil.com'), 'https://raricy.com').origin,
      '编码形态解析后仍站内'
    ).toBe('https://raricy.com');
    expect(safeNextPath(`/a${String.fromCharCode(0)}b`), 'NUL').toBe('/');
    expect(safeNextPath('/a b'), '裸空格（站内路径里应为 %20）').toBe('/');
  });

  it('回归：证明上面那条挡得有道理（不加检查时浏览器确实会跨站）', () => {
    expect(new URL('/\t/evil.com', 'https://raricy.com').origin).toBe('https://evil.com');
  });

  it('回跳到 API 没有意义（用户只会看到一坨 JSON）', () => {
    expect(safeNextPath('/api/auth/login')).toBe('/');
    expect(safeNextPath('/api/checkin')).toBe('/');
  });

  it('相对路径拒绝（不以 / 开头的一律不认）', () => {
    expect(safeNextPath('checkin')).toBe('/');
    expect(safeNextPath('../admin')).toBe('/');
  });
});

describe('loginUrlWithNext', () => {
  it('站内路径拼进 next 且做 URL 编码', () => {
    expect(loginUrlWithNext('/checkin')).toBe('/login?next=%2Fcheckin');
    expect(loginUrlWithNext('/fish/transactions')).toBe('/login?next=%2Ffish%2Ftransactions');
  });

  it('首页不必带 next（省掉一个没用的参数）', () => {
    expect(loginUrlWithNext('/')).toBe('/login');
  });

  it('★ 不安全的路径不会被拼进登录链接', () => {
    expect(loginUrlWithNext('https://evil.com')).toBe('/login');
    expect(loginUrlWithNext('//evil.com')).toBe('/login');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// safeExternalReturnUrl —— 唯一允许跨站的地址校验（收银台 / 资料卡 link 块）
//
// 【为什么单独一组】它与 safeNextPath 的策略**相反**（这里必须允许跨站），所以
// 上面 12 条用例一条都覆盖不到它；而它一旦退化成「随便放行」，收银台就是一个
// 由不可信商户参数驱动的钓鱼入口（页面会显示主机名，但地址栏仍是本站域名）。
// ─────────────────────────────────────────────────────────────────────────────

describe('safeExternalReturnUrl：跨站回跳的地址校验', () => {
  it('正常 http / https 地址放行并规范化', () => {
    expect(safeExternalReturnUrl('https://merchant.example/pay/done?id=1')).toBe(
      'https://merchant.example/pay/done?id=1'
    );
    expect(safeExternalReturnUrl('http://merchant.example/back')).toBe(
      'http://merchant.example/back'
    );
    // 规范化：补结尾斜杠由 URL 决定，调用方只把它渲染成链接
    expect(safeExternalReturnUrl('https://merchant.example')).toBe('https://merchant.example/');
    // 前后空白先 trim 再判
    expect(safeExternalReturnUrl('  https://merchant.example/ok  ')).toBe(
      'https://merchant.example/ok'
    );
  });

  it('空值 / 纯空白 → null（页面不显示返回按钮）', () => {
    expect(safeExternalReturnUrl(null)).toBeNull();
    expect(safeExternalReturnUrl(undefined)).toBeNull();
    expect(safeExternalReturnUrl('')).toBeNull();
    expect(safeExternalReturnUrl('   ')).toBeNull();
  });

  it('★ 超过 300 字符 → null（防超长参数打爆渲染/日志）', () => {
    expect(safeExternalReturnUrl('https://merchant.example/' + 'a'.repeat(280))).toBeNull();
    // 恰好 300 仍可
    const ok = 'https://merchant.example/' + 'a'.repeat(300 - 'https://merchant.example/'.length);
    expect(safeExternalReturnUrl(ok)).not.toBeNull();
  });

  it('★ 控制字符（含 TAB/LF/CR 变形）→ null', () => {
    expect(safeExternalReturnUrl('https://merchant.example/\tpath')).toBeNull();
    expect(safeExternalReturnUrl('https://merchant.example/\nevil')).toBeNull();
    // 内部的 CR 会被控制字符闸门拦下；**行尾** CR 只是被 trim 掉（与「前后空白先 trim」
    // 同一条规则），规范化后仍是原地址，不当作攻击。
    expect(safeExternalReturnUrl('https://merchant.example/a\rb')).toBeNull();
    expect(safeExternalReturnUrl('https://merchant.example/\r')).toBe(
      'https://merchant.example/'
    );
  });

  it('★ 非 http(s) 协议 → null（javascript: / data: / ftp:）', () => {
    expect(safeExternalReturnUrl('javascript:alert(1)')).toBeNull();
    expect(safeExternalReturnUrl('data:text/html,<script>alert(1)</script>')).toBeNull();
    expect(safeExternalReturnUrl('ftp://merchant.example/file')).toBeNull();
    // `http:/x` 会被 URL 规范化为 http://x —— 仍是 http 协议，放行是规范化的正常结果
    expect(safeExternalReturnUrl('http:/merchant.example')).toBe('http://merchant.example/');
  });

  it('★ 带用户名 / 密码的地址 → null（地址栏伪装成可信域名的钓鱼惯用法）', () => {
    expect(safeExternalReturnUrl('https://raricy.com@evil.com/')).toBeNull();
    expect(safeExternalReturnUrl('https://user:pass@merchant.example/')).toBeNull();
  });

  it('★ new URL 解析失败 → null（不抛给调用方）', () => {
    expect(safeExternalReturnUrl('not a url')).toBeNull();
    expect(() => safeExternalReturnUrl('http://[')).not.toThrow();
    expect(safeExternalReturnUrl('http://[')).toBeNull();
  });
});
