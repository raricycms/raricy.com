// ─────────────────────────────────────────────────────────────────────────────
// jwt.ts —— 开发者工具「JWT 解析」的纯逻辑
//
// 【只解码，不验签】本模块**刻意不做**签名验证：没有密钥 / 公钥就验不了，而页面上
// 只贴 token 的人通常也没有。所以这里只回答「里面写了什么」，不回答「它是否可信」——
// 页面必须把这句话原样告诉用户（`alg: none` 还会额外警告）。
//
// 【零依赖、零 React】与 datetime.ts 同一纪律。base64url 解码用 `atob` +
// `TextDecoder`（浏览器与 Node 都内置），不引 Buffer —— 引了会拖进客户端包。
//
// 【「现在」从参数来】exp / nbf 的状态与「还有多久过期」全部基于调用方给的 nowMs，
// 单测能冻住时间（db-time-guard 也要求 src/lib 不自己取当前时刻）。
// ─────────────────────────────────────────────────────────────────────────────

import { formatDuration, formatIsoUtc, formatSiteTime, relativeTime } from './datetime';

export type Base64UrlDecodeResult = { ok: true; text: string } | { ok: false; error: string };

/**
 * base64url → UTF-8 文本。
 *
 * 规则（RFC 4648 §5）：字母表是 `A-Za-z0-9-_`，padding 可省略。这里**自动补齐**
 * padding，因为 JWT 的 header / payload 通常不带 `=`；非法字符、非法长度、
 * 非 UTF-8 字节都返回错误而不是硬解出乱码。
 */
export function decodeBase64UrlText(input: string): Base64UrlDecodeResult {
  const text = input.trim();
  if (text === '') return { ok: false, error: '内容是空的' };

  const withoutPadding = text.replace(/=+$/, '');
  if (withoutPadding === '') return { ok: false, error: '内容只有填充字符' };
  if (!/^[A-Za-z0-9_-]+$/.test(withoutPadding)) {
    return { ok: false, error: '含非法 base64url 字符（只允许 A-Z a-z 0-9 - _ 与末尾填充）' };
  }

  const remainder = withoutPadding.length % 4;
  if (remainder === 1) return { ok: false, error: 'base64url 长度非法（除以 4 余 1）' };

  const padded = withoutPadding + '='.repeat((4 - remainder) % 4);
  const base64 = padded.replace(/-/g, '+').replace(/_/g, '/');

  let binary: string;
  try {
    binary = atob(base64);
  } catch {
    return { ok: false, error: 'base64 解码失败' };
  }

  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

  try {
    return { ok: true, text: new TextDecoder('utf-8', { fatal: true }).decode(bytes) };
  } catch {
    return { ok: false, error: '解码结果不是合法的 UTF-8 文本' };
  }
}

export type JwtTimeState = 'missing' | 'valid' | 'expired' | 'future' | 'invalid';

export interface JwtTimeStatus {
  state: JwtTimeState;
  /** 该声明对应的时间（Unix 毫秒）；没有 / 非法时为 null。 */
  atMs: number | null;
  /** 中文状态说明（徽章旁的文字）。 */
  text: string;
}

export interface JwtClaimRow {
  key: string;
  label: string;
  value: string;
}

export interface JwtDecoded {
  /** 解析后的头部 / 载荷（JSON 对象）。 */
  header: Record<string, unknown>;
  payload: Record<string, unknown>;
  headerJson: string;
  payloadJson: string;
  /** 第三段原文（签名），没有就是空串。 */
  signature: string;
  signaturePresent: boolean;
  /** 头部声明的算法；没写或不是字符串时为 null。 */
  alg: string | null;
  expMs: number | null;
  nbfMs: number | null;
  iatMs: number | null;
  exp: JwtTimeStatus;
  nbf: JwtTimeStatus;
  /** 安全提示（alg: none、声明类型不对…），页面原样展示。 */
  warnings: string[];
}

export type JwtDecodeResult = { ok: true; decoded: JwtDecoded } | { ok: false; error: string };

const KNOWN_CLAIM_LABELS: Readonly<Record<string, string>> = {
  iss: '签发者 iss',
  sub: '主体 sub',
  aud: '接收方 aud',
  exp: '过期时间 exp',
  nbf: '生效时间 nbf',
  iat: '签发时间 iat',
  jti: '唯一 ID jti',
  scope: '权限范围 scope',
  scp: '权限 scp',
  azp: '授权方 azp',
  typ: '类型 typ',
  sid: '会话 ID sid',
  name: '名称 name',
  email: '邮箱 email',
  role: '角色 role',
  roles: '角色 roles',
  nonce: '随机数 nonce',
};

const CLAIM_ORDER = Object.keys(KNOWN_CLAIM_LABELS);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function formatJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/** 数字秒 → 毫秒；不是有限数字则 null。 */
function secondsToMs(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.trunc(value * 1000);
}

/** 头部 / 载荷里的一个值 → 表格里的一行文本。 */
function claimValueText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return String(value);
  if (Array.isArray(value)) {
    const parts = value.map((v) => (typeof v === 'string' ? v : formatJson(v)));
    return parts.join(', ');
  }
  return formatJson(value);
}

function claimTimeText(ms: number, nowMs: number): string {
  return `${formatSiteTime(ms)}（UTC+8，${relativeTime(ms, nowMs)}）`;
}

/** 声明表：已知声明在前（固定顺序 + 中文名），其余按原文顺序追加。 */
export function buildClaimRows(payload: Record<string, unknown>, nowMs: number): JwtClaimRow[] {
  const rows: JwtClaimRow[] = [];
  const seen = new Set<string>();

  const push = (key: string, value: string) => {
    rows.push({ key, label: KNOWN_CLAIM_LABELS[key] ?? key, value });
    seen.add(key);
  };

  for (const key of CLAIM_ORDER) {
    if (!Object.prototype.hasOwnProperty.call(payload, key)) continue;
    const value = payload[key];
    const ms = key === 'exp' || key === 'nbf' || key === 'iat' ? secondsToMs(value) : null;
    if (ms !== null) {
      push(key, `${claimTimeText(ms, nowMs)}；Unix 秒 ${value}；ISO ${formatIsoUtc(ms)}`);
    } else {
      push(key, claimValueText(value));
    }
  }

  for (const key of Object.keys(payload)) {
    if (seen.has(key)) continue;
    push(key, claimValueText(payload[key]));
  }

  return rows;
}

/**
 * exp 检查：过期 / 仍有效 / 未声明 / 类型不对。
 * `remainingMs` 为正表示还没过期，为负表示已经过期多久。
 */
export function describeExp(payload: Record<string, unknown>, nowMs: number): JwtTimeStatus {
  if (!Object.prototype.hasOwnProperty.call(payload, 'exp')) {
    return {
      state: 'missing',
      atMs: null,
      text: '未声明 exp（按 JWT 规范，不声明就代表永不过期；使用方可能另有判断）',
    };
  }
  const expMs = secondsToMs(payload.exp);
  if (expMs === null) {
    return { state: 'invalid', atMs: null, text: 'exp 不是合法的数字时间戳' };
  }
  const remainingMs = expMs - nowMs;
  if (remainingMs <= 0) {
    return {
      state: 'expired',
      atMs: expMs,
      text: `已过期（${relativeTime(expMs, nowMs)}，即已过期 ${formatDuration(remainingMs)}）`,
    };
  }
  return {
    state: 'valid',
    atMs: expMs,
    text: `未过期（${relativeTime(expMs, nowMs)}到期，还剩 ${formatDuration(remainingMs)}）`,
  };
}

/** nbf 检查：尚未生效 / 已生效 / 未声明 / 类型不对。 */
export function describeNbf(payload: Record<string, unknown>, nowMs: number): JwtTimeStatus {
  if (!Object.prototype.hasOwnProperty.call(payload, 'nbf')) {
    return { state: 'missing', atMs: null, text: '未声明 nbf（表示立即可用）' };
  }
  const nbfMs = secondsToMs(payload.nbf);
  if (nbfMs === null) {
    return { state: 'invalid', atMs: null, text: 'nbf 不是合法的数字时间戳' };
  }
  if (nbfMs > nowMs) {
    return {
      state: 'future',
      atMs: nbfMs,
      text: `尚未生效（${relativeTime(nbfMs, nowMs)}才生效，还有 ${formatDuration(nbfMs - nowMs)}）`,
    };
  }
  return { state: 'valid', atMs: nbfMs, text: `已生效（${relativeTime(nbfMs, nowMs)}）` };
}

/** 解出头部与载荷（2 段或 3 段都接受：`header.payload` 是未签名形态）。 */
export function decodeJwt(token: string, nowMs: number): JwtDecodeResult {
  let text = token.trim();
  if (text === '') return { ok: false, error: '请粘贴 JWT。' };
  if (/^bearer\s+/i.test(text)) text = text.replace(/^bearer\s+/i, '').trim();

  const parts = text.split('.');
  if (parts.length < 2) {
    return { ok: false, error: 'JWT 至少要有 2 段（header.payload），用 . 分隔。' };
  }
  if (parts.length > 3) {
    return {
      ok: false,
      error: `JWT 最多 3 段（header.payload.signature），当前有 ${parts.length} 段。`,
    };
  }

  const headerText = decodeBase64UrlText(parts[0]);
  if (!headerText.ok) return { ok: false, error: `头部解码失败：${headerText.error}` };
  const payloadText = decodeBase64UrlText(parts[1]);
  if (!payloadText.ok) return { ok: false, error: `载荷解码失败：${payloadText.error}` };

  let headerValue: unknown;
  let payloadValue: unknown;
  try {
    headerValue = JSON.parse(headerText.text);
  } catch {
    return { ok: false, error: '头部不是合法的 JSON。' };
  }
  try {
    payloadValue = JSON.parse(payloadText.text);
  } catch {
    return { ok: false, error: '载荷不是合法的 JSON。' };
  }

  if (!isPlainObject(headerValue)) {
    return { ok: false, error: '头部必须是 JSON 对象。' };
  }
  if (!isPlainObject(payloadValue)) {
    return { ok: false, error: '载荷必须是 JSON 对象。' };
  }

  const signature = parts.length === 3 ? parts[2] : '';
  const alg = typeof headerValue.alg === 'string' ? headerValue.alg : null;
  const warnings: string[] = [];

  if (alg === null) {
    warnings.push('头部没有声明 alg（签名算法）。');
  } else if (alg.toLowerCase() === 'none') {
    warnings.push('头部声明 alg: none —— 这个 token 没有签名，内容可以被任何人改写。');
  }
  if (alg !== null && alg.toLowerCase() === 'none' && signature !== '') {
    warnings.push('alg 为 none，但第三段（签名）不是空的。');
  }
  if (parts.length === 2) {
    warnings.push('这个 token 只有 2 段，没有签名段。');
  }

  const exp = describeExp(payloadValue, nowMs);
  const nbf = describeNbf(payloadValue, nowMs);
  if (exp.state === 'invalid') warnings.push('exp 声明存在但不是数字，应检查 token 是否被正确生成。');
  if (nbf.state === 'invalid') warnings.push('nbf 声明存在但不是数字，应检查 token 是否被正确生成。');
  if (exp.state === 'missing' && nbf.state === 'missing') {
    warnings.push('既没有 exp 也没有 nbf：这个 token 在时间上没有约束。');
  }

  return {
    ok: true,
    decoded: {
      header: headerValue,
      payload: payloadValue,
      headerJson: formatJson(headerValue),
      payloadJson: formatJson(payloadValue),
      signature,
      signaturePresent: signature !== '',
      alg,
      expMs: secondsToMs(payloadValue.exp),
      nbfMs: secondsToMs(payloadValue.nbf),
      iatMs: secondsToMs(payloadValue.iat),
      exp,
      nbf,
      warnings,
    },
  };
}
