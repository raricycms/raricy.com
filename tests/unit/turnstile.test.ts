// ─────────────────────────────────────────────────────────────────────────────
// turnstile.test.ts —— 服务端人机校验的**失败分类**
//
// 这里钉的不是「Cloudflare 通不通过」（那是外部服务，不该在单测里断言），而是
// **我们把每种结果归类成了什么**：
//   • token 不合格（invalid-input-response / timeout-or-duplicate）→ rejected → 400
//   • 我们这一侧出问题（密钥、请求体、IP、网络、超时、非 2xx、非 JSON）→ unavailable → 503
//
// 为什么值得单独钉：这两类曾经一起塌缩成 `false` + 同一句「人机验证失败，请重试」。
// 于是「生产机连不上 challenges.cloudflare.com」被显示成「你的验证码没过」——
// 用户去反复重试一个他无能为力的验证码，排查的人被引向配置和 token，而病根在出口网络。
// 分类错了既不会报错、也不会让构建变红，只会让线上继续骗人 —— 所以要有用例盯着。
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { verifyTurnstile } from '@/lib/turnstile';

/** 桩掉 fetch；res 传 Error 表示请求抛异常（连不上 / 超时 / DNS 失败）。 */
function stubFetch(res: Response | Error) {
  const fn = vi.fn(async () => {
    if (res instanceof Error) throw res;
    return res;
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

/** 取第 n 次 fetch 调用的参数（函数体没声明形参，故从 mock.calls 里取）。 */
function callArgs(fn: ReturnType<typeof stubFetch>, n = 0): [string, RequestInit] {
  return fn.mock.calls[n] as unknown as [string, RequestInit];
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

beforeEach(() => {
  vi.stubEnv('TURNSTILE_AVAILABLE', 'True');
  vi.stubEnv('TURNSTILE_SECRET_KEY', 'test-secret');
  // 失败一定走 console.error：用例里用 vi.mocked(console.error) 取断言，同时挡掉噪声
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('开关与前置检查', () => {
  it('未启用时直接放行，且不发起任何请求', async () => {
    vi.stubEnv('TURNSTILE_AVAILABLE', 'False');
    const fetchMock = stubFetch(json({ success: false }));
    expect(await verifyTurnstile('')).toEqual({ ok: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('开关开着却没配密钥 → unavailable（部署问题，不能说成用户验证码没过）', async () => {
    vi.stubEnv('TURNSTILE_SECRET_KEY', '');
    const fetchMock = stubFetch(json({ success: true }));
    expect(await verifyTurnstile('tok')).toMatchObject({ ok: false, kind: 'unavailable' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('前端没带 token → rejected（用户重试有意义）', async () => {
    const fetchMock = stubFetch(json({ success: true }));
    expect(await verifyTurnstile('')).toMatchObject({ ok: false, kind: 'rejected' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('请求本身', () => {
  it('success=true → ok', async () => {
    stubFetch(json({ success: true, hostname: 'raricy.com' }));
    expect(await verifyTurnstile('tok')).toEqual({ ok: true });
  });

  it('打到 siteverify，带上 secret / response 与超时信号，且**不带 remoteip**', async () => {
    const fetchMock = stubFetch(json({ success: true }));
    await verifyTurnstile('the-token');

    const [url, init] = callArgs(fetchMock);
    const body = String(init.body);
    expect(url).toBe('https://challenges.cloudflare.com/turnstile/v0/siteverify');
    expect(init.method).toBe('POST');
    expect(body).toContain('secret=test-secret');
    expect(body).toContain('response=the-token');

    // 护栏：remoteip 只可能来自客户端可伪造的头（CF-Connecting-IP / XFF 首段，
    // 见 turnstile.ts 注释），传错比不传更糟 —— 别「好心」加回来。
    expect(body).not.toContain('remoteip');

    // 没有超时信号的话，连不上时会一直挂着（线上被 undici 的 10s 连接超时兜着）
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
});

describe('失败分类', () => {
  it('invalid-input-response → rejected（用户 token 的问题）', async () => {
    stubFetch(json({ success: false, 'error-codes': ['invalid-input-response'] }));
    expect(await verifyTurnstile('tok')).toMatchObject({ ok: false, kind: 'rejected' });
  });

  it('timeout-or-duplicate → rejected（token 过期或被重复提交）', async () => {
    stubFetch(json({ success: false, 'error-codes': ['timeout-or-duplicate'] }));
    expect(await verifyTurnstile('tok')).toMatchObject({ ok: false, kind: 'rejected' });
  });

  it('invalid-input-secret（HTTP 400）→ unavailable，不是 rejected', async () => {
    // 密钥填错会让**所有人**失败。报成「你的验证码没过」等于让所有人去改一个他们改不了的东西。
    stubFetch(json({ success: false, 'error-codes': ['invalid-input-secret'] }, 400));
    expect(await verifyTurnstile('tok')).toMatchObject({ ok: false, kind: 'unavailable' });
  });

  it('invalid-input-remoteip → unavailable（是我们发错了 IP，用户无解）', async () => {
    stubFetch(json({ success: false, 'error-codes': ['invalid-input-remoteip'] }));
    expect(await verifyTurnstile('tok')).toMatchObject({ ok: false, kind: 'unavailable' });
  });

  it('success=false 却没给 error-codes → unavailable（原因不明就不甩锅给用户）', async () => {
    stubFetch(json({ success: false }));
    expect(await verifyTurnstile('tok')).toMatchObject({ ok: false, kind: 'unavailable' });
  });

  it('连接超时 / DNS 失败 → unavailable（这条以前被吞成「人机验证失败」）', async () => {
    stubFetch(Object.assign(new Error('Connect Timeout Error'), { name: 'TimeoutError' }));
    expect(await verifyTurnstile('tok')).toMatchObject({ ok: false, kind: 'unavailable' });
  });

  it('HTTP 500 → unavailable', async () => {
    stubFetch(new Response('boom', { status: 500 }));
    expect(await verifyTurnstile('tok')).toMatchObject({ ok: false, kind: 'unavailable' });
  });

  it('200 但不是 JSON → unavailable', async () => {
    stubFetch(new Response('<html>gateway</html>', { status: 200 }));
    expect(await verifyTurnstile('tok')).toMatchObject({ ok: false, kind: 'unavailable' });
  });
});

describe('日志（线上排查的唯一线索）', () => {
  it('网络失败要留下日志，而不是静默返回 false', async () => {
    stubFetch(Object.assign(new Error('Connect Timeout Error'), { name: 'TimeoutError' }));
    await verifyTurnstile('tok');

    expect(vi.mocked(console.error)).toHaveBeenCalledTimes(1);
    expect(String(vi.mocked(console.error).mock.calls[0][0])).toContain('siteverify');
  });

  it('日志里出现 error-codes，便于一眼分清密钥 / token / IP', async () => {
    stubFetch(json({ success: false, 'error-codes': ['invalid-input-response'] }));
    await verifyTurnstile('tok');

    const logged = vi.mocked(console.error).mock.calls.flat().join(' ');
    expect(logged).toContain('invalid-input-response');
  });

  it('日志绝不落 token / secret', async () => {
    stubFetch(json({ success: false, 'error-codes': ['invalid-input-response'] }));
    await verifyTurnstile('super-secret-token-value');

    const logged = vi.mocked(console.error).mock.calls.flat().join(' ');
    expect(logged).not.toContain('super-secret-token-value');
    expect(logged).not.toContain('test-secret');
  });
});
