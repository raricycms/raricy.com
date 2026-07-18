// ─────────────────────────────────────────────────────────────────────────────
// turnstile.ts — Cloudflare Turnstile 服务端校验（对齐 Flask flask-turnstile）。
//
// Flask 行为（app/web/auth/sign_up.py）：
//   if config['TURNSTILE_AVAILABLE'] and not turnstile.verify(token): 拒绝
// 即：未启用 Turnstile 时直接放行。这里镜像该逻辑：
//   env TURNSTILE_AVAILABLE !== 'True' → 返回 true（视为通过 / 已禁用）。
// ─────────────────────────────────────────────────────────────────────────────

const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

/**
 * 校验 Turnstile token。禁用时（TURNSTILE_AVAILABLE !== 'True'）直接放行。
 * 任何网络/解析异常均视为校验失败（fail-closed），返回 false。
 */
export async function verifyTurnstile(token: string, ip?: string): Promise<boolean> {
  if (process.env.TURNSTILE_AVAILABLE !== 'True') {
    // 未启用 → 放行（镜像 Flask）。
    return true;
  }

  const secret = process.env.TURNSTILE_SECRET_KEY;
  if (!secret || !token) return false;

  try {
    const form = new URLSearchParams();
    form.set('secret', secret);
    form.set('response', token);
    if (ip) form.set('remoteip', ip);

    const res = await fetch(SITEVERIFY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form,
      cache: 'no-store',
    });
    if (!res.ok) return false;

    const data = (await res.json()) as { success?: boolean };
    return data.success === true;
  } catch {
    return false;
  }
}
