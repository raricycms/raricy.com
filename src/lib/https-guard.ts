// ─────────────────────────────────────────────────────────────────────────────
// https-guard.ts — 「练手盘与玩具区只走 https」的判据（零 import，Edge 中间件可直接吃）
// 【覆盖】练手盘：/fish/trade 及下面一切 + 四个 /api/fish/trade/* 接口；玩具区：/game 及下面
//   一切 + 四个 /api/game/*/launch 启动接口。两区共用判据，差别只在 403 文案点名的名字
//   （GuardedArea.label）。路径清单只在这一张表里维护。
// 【判据】信号是 X-Forwarded-Proto：nginx 写、Next 不覆盖；没反代时 Next 按 socket 自填；
//   头缺失 → 放行（不猜）。isConfirmedHttp 只在头明确为 http 时否决。
// 【玩具区为什么也拦】/api/game/*/launch 的一次性票据在响应体里，明文链路可被截走冒用身份；
//   实时地址在回环外不许 ws:（realtime-url.ts 抛错），页面层一起收紧。
//   /game/quandi/play 是 iframe 文档路由（route handler 不是页面），落在 /game 前缀下按页面
//   走 308 —— 刻意：只有 GET，跟到 https 无损。
// 【回环豁免】判据是「对外 Host 落在回环」（isLoopbackHost，私网段不算）。它让 dev 与全部 e2e
//   能活（playwright 设 COOKIE_SECURE=false）；不豁免 = 练手盘与玩具区在本地与 e2e 整体 403。
// 【已知残余缺口】nginx 只透传 XFP、不透传 Host / X-Forwarded-Host 时，Next 看到的 Host 是上游
//   127.0.0.1:3000 → 被当本机豁免，闸静默失效。兜底：那种配置下 CSRF / 登录态早已明显坏了；
//   scripts/smoke.mjs 拿对外域名探 http 命中就报错（§1）。别拿它当放宽理由。
// 【别与 session.ts 的 cookie 判定合并】那边缺信息倾向「加 Secure」，这边缺信息倾向「放行」；
//   方向相反，合并会让改一处静默改另一处。两处注释互指，别互相 import。
// 设计背景与取舍：docs/source-design-notes.md §4
// ─────────────────────────────────────────────────────────────────────────────

/** 协议闸覆盖的一个区域。加一个区域 = 这里加一行；**别在别处再维护一份路径清单**。 */
interface GuardedArea {
  /** 403 文案里点名的名字（「练手盘仅支持 HTTPS 访问」）。 */
  readonly label: string;
  /** 页面前缀：`/x` 与 `/x/…` 都算。用前缀而不是逐条枚举 —— 以后加 `/x/y` 自动在闸内。
   *  漏掉一个页面的失效是无声的：那一页照常在 http 下可达、照常渲染。 */
  readonly pageRoots: readonly string[];
  /** 接口**逐条列全**，理由见下面 `GUARDED_APIS` 的注释。 */
  readonly apis: readonly string[];
}

const GUARDED_AREAS: readonly GuardedArea[] = [
  {
    label: '练手盘',
    pageRoots: ['/fish/trade'],
    apis: [
      '/api/fish/trade/quote',
      '/api/fish/trade/buy',
      '/api/fish/trade/sell',
      '/api/fish/trade/candles',
    ],
  },
  {
    label: '玩具',
    pageRoots: ['/game'],
    apis: [
      '/api/game/wand/launch',
      '/api/game/wand2/launch',
      '/api/game/quandi/launch',
      '/api/game/public-space/launch',
    ],
  },
];

/**
 * 闸覆盖的全部接口（由上面那张表推出来，供测试拿文件系统对账）。
 *
 * ⚠️ 别图省事把某一格写成前缀常量（`/api/fish/trade`、`/api/game`）：scripts/check-links.mjs
 *    第 2 节会把 `src/**` 里所有 `/api/…` 字面量拿去和真实路由表比对，而那种前缀不是
 *    任何一条路由 —— 当场报一条「调用不存在的 API」。表里每一条都必须是真路由。
 * ⚠️ 新增 `src/app/api/fish/trade/<x>/route.ts` 或 `src/app/api/game/<x>/launch/route.ts`
 *    时必须往这张表补一条：tests/unit/https-guard.test.ts 拿文件系统与本清单**双向对账**。
 */
export const GUARDED_APIS: readonly string[] = GUARDED_AREAS.flatMap((area) => area.apis);

/** 这条路径过不过协议闸；过的话是哪一档、403 文案点名谁。不覆盖则 null。 */
export interface GuardHit {
  /** 页面走 308、接口回 403（理由见 src/middleware.ts 的调用点）。 */
  readonly kind: 'page' | 'api';
  /** `GuardedArea.label` —— 只用来拼 403 文案。 */
  readonly label: string;
}

function stripTrailingSlash(p: string): string {
  return p.length > 1 && p.endsWith('/') ? p.slice(0, -1) : p;
}

/**
 * 路径是否过闸。页面前缀先判（区域表顺序即是优先级），接口逐条比。
 * 结论连着 `label` 一起返回：中间件那边不再自己猜「这条路径属于哪个区域」，
 * 否则加第三个区域时就会出现「闸认得了、文案点名却还写着练手盘」的缝。
 */
export function guardFor(pathname: string): GuardHit | null {
  const p = stripTrailingSlash(pathname);
  for (const area of GUARDED_AREAS) {
    for (const root of area.pageRoots) {
      if (p === root || p.startsWith(`${root}/`)) return { kind: 'page', label: area.label };
    }
    if (area.apis.includes(p)) return { kind: 'api', label: area.label };
  }
  return null;
}

/**
 * 协议是**明文 http**。取 X-Forwarded-Proto 的第一段（多值形式 `https, http` 取第一个，
 * 与 session.ts 的读法一致）。头缺失 / 空串 / 畸形 → false（**放行**，不猜）。
 */
export function isConfirmedHttp(headers: Headers): boolean {
  const proto = headers.get('x-forwarded-proto')?.split(',')[0]?.trim().toLowerCase();
  return proto === 'http';
}

/** 去掉端口与 IPv6 方括号，得到裸主机名。 */
function bareHost(host: string): string {
  return host
    .replace(/:\d+$/, '')
    .replace(/^\[|\]$/g, '')
    .trim()
    .toLowerCase();
}

/**
 * 回环地址：`npm run dev`（localhost:3000）与 e2e（127.0.0.1:3100）就长这样。
 * **只有它豁免** —— 豁免面收窄到「请求压根没离开这台机器」，
 * 这是唯一一个「链路上必然没有第三方」的形态。
 *
 * ⚠️ 别把私网段也并进来「顺手放宽」：那会让「nginx 的上游在同一局域网」也变成豁免，
 *    而那种部署恰恰是最需要这道闸的（多机部署）。私网地址另有用途，见 isLocalHost。
 */
export function isLoopbackHost(host: string): boolean {
  const bare = bareHost(host);
  if (!bare) return false;
  return (
    bare === 'localhost' ||
    bare === '::1' ||
    bare === '0.0.0.0' ||
    bare.endsWith('.localhost') ||
    /^127\./.test(bare)
  );
}

/**
 * 「不是公网地址」：回环 + 私网段 + 链路本地 + `.local`。
 *
 * **只用来否决 308 的跳转目标**，不用来豁免请求。理由：反代漏配 Host / X-Forwarded-Host
 * 时（2026-07-16 那次事故的形状），Next 看到的 Host 就是上游地址 ——
 * 照它拼 `https://127.0.0.1:3000/...`（或局域网里的某台机器）会被浏览器**永久**缓存，
 * 而服务端每次「正确地」返回 308、不报任何错，只能清缓存才好。
 * 宁可回 403（运维当场看得见、可恢复）也不跳到一个肯定错的地址上。
 */
export function isLocalHost(host: string): boolean {
  const bare = bareHost(host);
  if (!bare) return false;
  if (isLoopbackHost(bare)) return true;
  if (bare.endsWith('.local')) return true;
  return (
    /^10\./.test(bare) ||
    /^192\.168\./.test(bare) ||
    /^169\.254\./.test(bare) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(bare)
  );
}

/**
 * 308 跳转要用的对外 Host：`X-Forwarded-Host`（多值取第一段）→ `Host`；都没有 → null。
 *
 * 与中间件里 CSRF 那套「三源并集」不是一回事：那边问「哪些 Origin 可信」（可以多个，
 * 取并集判是否命中），这里问「把浏览器送到哪个域名」（只能是一个）。
 * ⚠️ 这里**不**替调用方过滤本机地址 —— 那是 `isLocalHost` 的活，两件事分开写，
 * 因为「要不要豁免这次请求」与「能不能拿它当跳转目标」判的不是同一件事。
 */
export function outwardHost(headers: Headers): string | null {
  const xf = headers.get('x-forwarded-host')?.split(',')[0]?.trim();
  const raw = (xf || headers.get('host') || '').trim();
  if (!raw) return null;
  // 容错：反代偶尔会把 scheme 一起塞进来（`X-Forwarded-Host $scheme://$host` 之类），
  // 或带上网关路径。剥掉之后取第一段。
  const host = raw.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').split('/')[0].trim();
  return host || null;
}

/** 协议闸的结论。 */
export type PlaintextVerdict =
  /** 放行 —— 不是明文，或者是本机地址（dev / e2e）。 */
  | { block: false; redirectTo: null }
  /** 拦。`redirectTo` 非空时页面 308 跳到它；为 null（连 Host 都没有）时调用方回 403。 */
  | { block: true; redirectTo: string | null };

const ALLOW: PlaintextVerdict = { block: false, redirectTo: null };

/**
 * 这一次请求该不该被协议闸拦下。
 *
 * 确证是明文 http（值由 Next 或 nginx 给出，见文件头）**且** 对外 Host 不是回环地址
 * → 拦。回环豁免，理由见文件头（dev 与 e2e 就靠它活着）。
 *
 * 三种「拦」的形态分得比看起来细，各有各的代价：
 *   · Host 是回环         → **放行**（dev / e2e）
 *   · Host 是公网域名      → 拦，页面 308 跳到它（`redirectTo`）
 *   · Host 是私网 / 缺失   → 拦，但 `redirectTo` 为 null（调用方回 403）——
 *     拼不出一个**肯定对**的跳转目标就别拼
 *
 * 为什么把结论连着跳转目标一起返回：中间件那边若自己再读一遍头，就会出现
 * 「判据认为该放行、拼串那里却拼了一个跳转」这种两边不一致的缝 ——
 * 而这条缝的症状是跳错域，且 308 会被浏览器长期缓存。
 */
export function plaintextVerdict(headers: Headers): PlaintextVerdict {
  if (!isConfirmedHttp(headers)) return ALLOW;
  const host = outwardHost(headers);
  if (host && isLoopbackHost(host)) return ALLOW;
  if (!host || isLocalHost(host)) return { block: true, redirectTo: null };
  return { block: true, redirectTo: host };
}
