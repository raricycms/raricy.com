// session.ts —— JWT 会话签发/校验 + cookie 选项。
//
// 【回归测试】2026-07-16 线上事故：站点走纯 HTTP 时，cookie 被写死 Secure
// （secure: NODE_ENV === 'production'），浏览器直接丢弃 → 登录接口返回 200
// 「登录成功」但会话不粘、刷新仍未登录，且无任何报错。
// 修复：判定顺序 COOKIE_SECURE → X-Forwarded-Proto → NODE_ENV。
//
// 另一半是 session_version 失效机制（对齐 Flask-Login）：改密/强制下线时后端
// 自增 sessionVersion，所有旧 token 立即失效。

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// headers() 来自 next/headers，需在 import session 之前 mock
const mockHeaders = vi.hoisted(() => ({ current: new Map<string, string>() }));
vi.mock('next/headers', () => ({
  headers: async () => ({
    get: (k: string) => mockHeaders.current.get(k.toLowerCase()) ?? null,
  }),
}));

import {
  createSessionToken,
  verifySessionToken,
  sessionCookieOptions,
  SESSION_COOKIE,
} from '@/lib/session';

const ENV_BACKUP = { ...process.env };

beforeEach(() => {
  mockHeaders.current = new Map();
  process.env.SECRET_KEY = 'test-secret-key';
  delete process.env.COOKIE_SECURE;
  vi.stubEnv('NODE_ENV', 'test');
});
afterEach(() => {
  vi.unstubAllEnvs(); // 还原 vi.stubEnv 改过的 NODE_ENV
  process.env = { ...ENV_BACKUP };
});

describe('cookie 名称', () => {
  it('与 Flask 侧约定一致', () => {
    expect(SESSION_COOKIE).toBe('raricy_session');
  });
});

describe('回归：HTTP 部署下 Secure 标记的判定', () => {
  it('✅ X-Forwarded-Proto: http → 不带 Secure（否则浏览器丢 cookie，登录不粘）', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    mockHeaders.current.set('x-forwarded-proto', 'http');
    const opts = await sessionCookieOptions();
    expect(opts.secure, 'HTTP 下带 Secure 会被浏览器丢弃（线上事故重现）').toBe(false);
  });

  it('✅ X-Forwarded-Proto: https → 带 Secure（该加固时必须加固）', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    mockHeaders.current.set('x-forwarded-proto', 'https');
    const opts = await sessionCookieOptions();
    expect(opts.secure).toBe(true);
  });

  it('X-Forwarded-Proto 为 "https, http" 时取第一个', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    mockHeaders.current.set('x-forwarded-proto', 'https, http');
    expect((await sessionCookieOptions()).secure).toBe(true);
  });

  it('COOKIE_SECURE 显式配置优先级最高（覆盖 X-Forwarded-Proto）', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    mockHeaders.current.set('x-forwarded-proto', 'https');
    process.env.COOKIE_SECURE = 'false';
    expect((await sessionCookieOptions()).secure).toBe(false);

    mockHeaders.current.set('x-forwarded-proto', 'http');
    process.env.COOKIE_SECURE = 'true';
    expect((await sessionCookieOptions()).secure).toBe(true);
  });

  it('COOKIE_SECURE 接受 1/0 与大小写', async () => {
    for (const [v, want] of [['1', true], ['0', false], ['TRUE', true], ['False', false]] as const) {
      process.env.COOKIE_SECURE = v;
      expect((await sessionCookieOptions()).secure, `COOKIE_SECURE=${v}`).toBe(want);
    }
  });

  it('无 X-Forwarded-Proto 时回退 NODE_ENV（生产 true / 非生产 false）', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    expect((await sessionCookieOptions()).secure).toBe(true);
    vi.stubEnv('NODE_ENV', 'development');
    expect((await sessionCookieOptions()).secure).toBe(false);
  });
});

describe('cookie 其它属性（安全基线）', () => {
  it('httpOnly + SameSite=lax + path=/ + 30 天有效期', async () => {
    const o = await sessionCookieOptions();
    expect(o.httpOnly, 'httpOnly 必须为 true，否则 XSS 可直接读取会话').toBe(true);
    expect(o.sameSite).toBe('lax');
    expect(o.path).toBe('/');
    expect(o.maxAge).toBe(60 * 60 * 24 * 30);
  });
});

describe('JWT 签发与校验', () => {
  it('签发的 token 能被校验并还原 payload', async () => {
    const token = await createSessionToken({ uid: 'user-123', sv: 7 });
    const payload = await verifySessionToken(token);
    expect(payload).toEqual({ uid: 'user-123', sv: 7 });
  });

  it('篡改 token 校验失败（返回 null 而非抛异常）', async () => {
    const token = await createSessionToken({ uid: 'user-123', sv: 0 });
    const tampered = token.slice(0, -4) + 'AAAA';
    await expect(verifySessionToken(tampered)).resolves.toBeNull();
  });

  it('用另一个密钥签的 token 无法通过校验', async () => {
    const token = await createSessionToken({ uid: 'u', sv: 0 });
    process.env.SECRET_KEY = 'a-different-secret';
    await expect(verifySessionToken(token)).resolves.toBeNull();
  });

  it('垃圾字符串不抛异常', async () => {
    for (const bad of ['', 'garbage', 'a.b.c', '....']) {
      await expect(verifySessionToken(bad), bad).resolves.toBeNull();
    }
  });

  it('SECRET_KEY 未配置时签发抛出明确错误（对齐部署自检的判定）', async () => {
    delete process.env.SECRET_KEY;
    await expect(createSessionToken({ uid: 'u', sv: 0 })).rejects.toThrow('SECRET_KEY');
  });
});

describe('session_version 语义（对齐 Flask-Login 的会话失效）', () => {
  it('token 里带的 sv 快照可被读出，供与 DB 比对', async () => {
    const token = await createSessionToken({ uid: 'u1', sv: 3 });
    const p = await verifySessionToken(token);
    expect(p?.sv).toBe(3);
    // 语义：调用方（auth.getCurrentUser）拿 p.sv 与 user.sessionVersion 比对，
    // 不一致即视为登出 —— 改密码时自增 sessionVersion 即可踢掉所有旧 cookie。
  });

  it('不同 sv 的 token 内容不同（自增后旧 token 必然对不上）', async () => {
    const t1 = await createSessionToken({ uid: 'u1', sv: 1 });
    const t2 = await createSessionToken({ uid: 'u1', sv: 2 });
    expect((await verifySessionToken(t1))?.sv).toBe(1);
    expect((await verifySessionToken(t2))?.sv).toBe(2);
  });
});
