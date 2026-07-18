// ─────────────────────────────────────────────────────────────────────────────
// safe-url.test.ts —— 登录回跳的开放重定向防护
//
// 【背景】Next 侧的登录一度**完全忽略** next：跳转硬编码 '/'，登录页那个
// name="next" 的 hidden input 从没被发送过。安全上因此没洞，但行为与 Flask
// 不符（Flask 有 64 个 @login_required 路由 + login_view，登录后会回到原页）。
// 补回 next 的同时就引入了开放重定向的风险 —— next 来自 URL，攻击者可控。
//
// 攻击长这样：诱导用户点 https://raricy.com/login?next=https://evil.com，
// 用户在**我们自己的**登录页输完密码，然后被弹去钓鱼站。整个过程地址栏都是
// 可信域名，这正是它比普通钓鱼更危险的地方。
// ─────────────────────────────────────────────────────────────────────────────

import { describe, expect, it } from 'vitest';
import { safeNextPath, loginUrlWithNext } from '@/lib/safe-url';

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
