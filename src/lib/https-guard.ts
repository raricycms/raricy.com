// ─────────────────────────────────────────────────────────────────────────────
// https-guard.ts — 「鱼干练手盘只走 https」的判据（零 import，Edge 中间件可直接吃）
//
// 【为什么闸只做在中间件一处，而不是跟着档位在那六个判定点各写一遍】
// 那六处判的是「谁够不够格用这个功能」（core 档位 / 专注模式 / 禁言），是业务档位；
// 这里判的是「这次请求是怎么来的」，是传输层属性。混在一起之后，改档位就得顺手想
// 一遍协议，改协议也得顺手想一遍档位 —— 两边都不是对方的事。
//
// ── ★ 判据（这一段是实测出来的，别按「反代才设这个头」的直觉改）★ ──────────
// 信号是 `X-Forwarded-Proto`，但它**不是**「只有反代才有」：
//   · nginx 在场时由 nginx 写（`proxy_set_header X-Forwarded-Proto $scheme`），
//     **Next 不会覆盖它**（实测：客户端/反代显式给了 https，中间件看到的就是 https）；
//   · 没有反代时 **Next 自己按 socket 填**（实测：直连 `next start` 打明文 http，
//     中间件里读到的就是 `http`）。
// 所以「头缺失 ⇒ 读不到协议 ⇒ 放行」这条路在 Next 上**基本走不到** ——
// 缺失只可能发生在被人为剥掉头的场合，那一档仍然放行（不猜）。
//
// 【回环地址豁免：这是让 `npm run dev` 与全部 e2e 还能用的那一条】
// 判据是「对外 Host 落在回环」（`isLoopbackHost`，**私网段不算**）。理由不是「图方便」，而是这道闸要防的是
// **跨公网那一段链路上的第三方**：请求如果压根没离开本机或本局域网，没有那个第三方，
// 也就不需要 TLS。而 dev（http://localhost:3000）与 e2e（http://127.0.0.1:3100，
// playwright.config.ts 显式设了 COOKIE_SECURE=false）都正是这种请求 ——
// 不豁免的话练手盘在本地开发与整个 e2e 里会**整体 403**。
//
// ⚠️ **已知残余缺口（照实写）**：nginx 若只透传了 X-Forwarded-Proto、没透传
//    Host / X-Forwarded-Host，Next 看到的 Host 就是上游地址（127.0.0.1:3000），
//    于是被当成「本机」而豁免 —— 闸静默失效。
//    这正是 2026-07-16 那次 CSRF 事故的配置形状。两层兜底：
//      · 那种配置下 CSRF 判定与「登录态不粘」早就先坏了，站是**明显**不可用的；
//      · scripts/smoke.mjs 拿**对外域名**去探 http，命中就报错（§1）。
//    别把这条残余缺口当成「可以顺手放宽」的理由 —— 它是在已经坏掉的部署上才成立。
//
// 【为什么不与 session.ts 的 cookie 判定共用一份实现】
// 那边问的是「cookie 要不要加 Secure」，判定链是 COOKIE_SECURE → XFP → NODE_ENV
// 三级兜底，**缺信息时倾向『加』**；这边问的是「要不要拦下这次请求」，
// **缺信息时倾向『放行』**。方向相反的两套策略并成一个函数，等于让改一处静默改
// 另一处 —— 与「档位六处各判一次」同一个理由。两处注释互指，别互相 import。
// ─────────────────────────────────────────────────────────────────────────────

/** 闸覆盖的页面根：`/fish/trade` 与它下面的一切（统计页就在下面）。
 *  用**前缀**而不是逐条枚举：以后加 `/fish/trade/xxx` 自动在闸内。
 *  漏掉一个页面的失效是无声的 —— 那一页照常在 http 下可达、照常渲染。 */
const PAGE_ROOT = '/fish/trade';

/**
 * 闸覆盖的四个接口，**逐条列全**。
 *
 * ⚠️ 别图省事写成前缀常量 `/api/fish/trade`：scripts/check-links.mjs 第 2 节会把
 *    `src/**` 里所有 `/api/…` 字面量拿去和真实路由表比对，而那条前缀不是任何一条
 *    路由 —— 当场报一条「调用不存在的 API」。下面四条各自都是真路由，所以合法。
 * ⚠️ 新增 `src/app/api/fish/trade/<x>/route.ts` 时必须往这里补一条：
 *    tests/unit/https-guard.test.ts 拿文件系统与本清单**双向对账**。
 */
export const GUARDED_APIS = [
  '/api/fish/trade/quote',
  '/api/fish/trade/buy',
  '/api/fish/trade/sell',
  '/api/fish/trade/candles',
] as const;

function stripTrailingSlash(p: string): string {
  return p.length > 1 && p.endsWith('/') ? p.slice(0, -1) : p;
}

/** 这条路径过不过协议闸；过的话是哪一档（页面跳转 / 接口 403）。不覆盖则 null。 */
export function guardedKind(pathname: string): 'page' | 'api' | null {
  const p = stripTrailingSlash(pathname);
  if (p === PAGE_ROOT || p.startsWith(`${PAGE_ROOT}/`)) return 'page';
  return (GUARDED_APIS as readonly string[]).includes(p) ? 'api' : null;
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
