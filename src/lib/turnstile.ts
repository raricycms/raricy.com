// ─────────────────────────────────────────────────────────────────────────────
// turnstile.ts — Cloudflare Turnstile 服务端校验。
//
// 开关语义（注册流程依赖它）：
//   env TURNSTILE_AVAILABLE === 'True' 时才校验 token，不通过即拒绝；
//   env TURNSTILE_AVAILABLE !== 'True' → 放行（视为通过 / 已禁用）。
//
// 【为什么返回值不是 boolean】
// 曾经失败一律返回 false，调用方再统一报「人机验证失败，请重试」。后果是**任何故障
// 都长得像「用户的验证码没过」**：线上生产机连不上 challenges.cloudflare.com
// （GFW 对 Cloudflare IP 的 SYN 丢包 / RST 注入，curl 实测 10/10 拿不到响应），
// 每次 siteverify 都在网络层就死了，却让所有用户看到「人机验证失败」——用户去反复
// 重试一个他无能为力的验证码，排查的人也被指向配置和 token，而病根在出口网络。
// 所以现在分三类，让调用方能分别对待：ok / rejected（用户侧）/ unavailable（服务侧）。
// ─────────────────────────────────────────────────────────────────────────────

const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

/**
 * 单次校验的墙钟上限。正常往返 < 1s（国内实测约 0.5s），给到 8s 是为了容忍慢而
 * 仍可用的链路，同时把「连接被黑洞」的等待从 undici 默认的 10s 连接超时压下来。
 */
const TIMEOUT_MS = 8000;

/**
 * 这些 error-codes 说明问题在**我们这一侧**（密钥 / 请求体 / IP），不是用户的 token。
 * 不在表里的（invalid-input-response、timeout-or-duplicate）才是用户重试有意义的。
 * 官方清单：https://developers.cloudflare.com/turnstile/get-started/server-side-validation/
 */
const SERVER_SIDE_CODES = new Set([
  'missing-input-secret',
  'invalid-input-secret',
  'missing-input-response', // 我们已保证 token 非空，CF 还说缺 → 是我们发错了
  'invalid-input-remoteip',
  'bad-request',
  'internal-error',
]);

export type TurnstileResult =
  /** 通过，或 Turnstile 未启用（放行）。 */
  | { ok: true }
  /** 用户的 token 不合格 —— 报 400，重试有意义。 */
  | { ok: false; kind: 'rejected'; codes: string[] }
  /** 校验服务本身不可用（网络 / 超时 / 密钥配置）—— 报 503，**不是**用户的错。 */
  | { ok: false; kind: 'unavailable'; detail: string };

/** siteverify 的响应体（只取我们用得到的字段）。 */
type SiteverifyBody = { success?: boolean; 'error-codes'?: string[]; hostname?: string };

/**
 * 校验 Turnstile token。禁用时（TURNSTILE_AVAILABLE !== 'True'）直接放行。
 *
 * ⚠️ 这里**刻意不传 `remoteip`**。它是可选参数，而本站在 nginx 之后（见
 * docs/deploy.md §6），真实客户端 IP 只能靠反代**覆写**的头拿到：
 *   • `CF-Connecting-IP` —— 本站没走 Cloudflare，没有任何可信代理会写它，是纯客户端输入；
 *   • `X-Forwarded-For` —— nginx 用 `$proxy_add_x_forwarded_for`，会把客户端自带的放在
 *     **最前面**，取 `split(',')[0]` 等于直接采信伪造值。
 * 而 `remoteip` 在 Cloudflare 那边用于「token 在 A IP 解、却从 B IP 提交」的判定，
 * **传一个错的比不传更糟**。token 本身是一次性的（重放由 timeout-or-duplicate 覆盖），
 * `remoteip` 的增量价值很小 —— 宁缺毋滥。若将来要加回来，唯一可信来源是反代覆写的
 * `X-Real-IP`，且必须先校验它确实是合法 IP。
 */
export async function verifyTurnstile(token: string): Promise<TurnstileResult> {
  if (process.env.TURNSTILE_AVAILABLE !== 'True') {
    return { ok: true }; // 未启用 → 放行
  }

  const secret = process.env.TURNSTILE_SECRET_KEY;
  if (!secret) {
    // 开关开着却没有密钥 = 部署配置错误。报「人机验证失败」会把所有人挡在门外，
    // 还把矛头指向一个用户根本改不了的地方。
    console.error('[turnstile] TURNSTILE_AVAILABLE=True 但 TURNSTILE_SECRET_KEY 为空，注册将被全部拒绝');
    return { ok: false, kind: 'unavailable', detail: 'secret-not-configured' };
  }
  if (!token) {
    // 前端没带上 token（widget 没渲染 / 没完成 / 过期后被清空）—— 用户侧，重试有意义。
    return { ok: false, kind: 'rejected', codes: ['missing-token'] };
  }

  const form = new URLSearchParams({ secret, response: token });

  let res: Response;
  try {
    res = await fetch(SITEVERIFY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form,
      cache: 'no-store',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    // 连不上 / 超时 / DNS 失败。**不要吞成 false** —— 这就是「所有人都注册不了，
    // 却显示人机验证失败」的成因。日志只记异常本身，绝不记 token / secret。
    const detail = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    console.error(`[turnstile] siteverify 请求失败（网络或超时，上限 ${TIMEOUT_MS}ms）: ${detail}`);
    return { ok: false, kind: 'unavailable', detail };
  }

  const raw = await res.text().catch(() => '');

  if (!res.ok) {
    // CF 用 HTTP 状态区分故障类别（invalid-input-secret → 400，token 不合格 → 200）。
    // 非 2xx 一律算我们这一侧的问题。
    console.error(`[turnstile] siteverify 返回 HTTP ${res.status}（服务端配置 / 接口问题）: ${raw.slice(0, 500)}`);
    return { ok: false, kind: 'unavailable', detail: `http-${res.status}` };
  }

  let data: SiteverifyBody;
  try {
    data = JSON.parse(raw) as SiteverifyBody;
  } catch {
    console.error(`[turnstile] siteverify 响应不是 JSON: ${raw.slice(0, 500)}`);
    return { ok: false, kind: 'unavailable', detail: 'bad-json' };
  }

  if (data.success === true) return { ok: true };

  const codes = data['error-codes'] ?? [];
  // 没有 error-codes 时按服务端问题处理：原因不明，就不该告诉用户「你的验证码没过」。
  const serverSide = codes.length === 0 || codes.some((c) => SERVER_SIDE_CODES.has(c));
  console.error(
    `[turnstile] 校验未通过：error-codes=[${codes.join(', ')}]` +
      `${data.hostname ? ` hostname=${data.hostname}` : ''}` +
      ` → 判为${serverSide ? '服务端问题（503）' : '用户 token 问题（400）'}`
  );
  return serverSide
    ? { ok: false, kind: 'unavailable', detail: `codes:${codes.join(',') || 'none'}` }
    : { ok: false, kind: 'rejected', codes };
}
