// 鱼干市场接口统一鉴权：**三道门，按下面的顺序试**。
//
//   ① 会话（浏览器）
//   ② 只读凭据 `Authorization: Bearer <token>` —— **只在 opts.allowReadToken 的路由上**
//   ③ 请求体里的 username + password（站外脚本的「一次发包」，不签发会话）
//
// 【②为什么单列一道门，而不是并进③】两者是两种东西：
//   · ③ 是账号密码，**每次请求跑一次 scrypt**，能查也能转，且是全账号一把；
//   · ② 是站点签发的只读凭据，不跑哈希、**只能读**、可单独吊销（见 fish-token-service.ts）。
// 把②并进③就等于让长期凭据也获得转账能力，收银台那道 step-up 闸门从后门白装了。
//
// 【②的路由白名单是靠 opts 默认关门实现的】`allowReadToken` 缺省 false ——
// 新写的路由忘了传，令牌在它上面**不生效**，而不是悄悄多开一扇门。只有
// balance 与 transactions 传 true；transfer / pay / users 一律不传。
// 带着令牌打写接口会拿到明确的 403（「该凭据只能读取」），不是含糊的 401。
//
// 【③为什么允许凭据进 body】站外脚本 / 机器人要「一次发包完成一笔转账」——
// 很多运行环境存不住 cookie，分两步（先 /api/auth/login 再带 cookie 打业务接口）
// 等于要求调用方自己维护会话。这里让凭据随请求走一次，不签发会话。
//
// 【③不是一条更弱的门】校验走 credential-auth.ts 的同一份实现（werkzeug 兼容的
// 哈希校验 + 与 /api/auth/login **共用**的撞库限频桶），禁言判定与会话路径同款；
// 失败文案也一致。三处差异都是刻意的：
//   1. 无状态路径**每次请求**都要跑一次 scrypt ⇒ 多一道「成功也计数」的配额
//      （RULES.fishApiPerUser / fishApiPerIp），会话路径不花 CPU 故不受它管；
//   2. 凭据只用于本次校验，绝不写日志、绝不进响应（密码是调用方的，不是我们的）；
//   3. 同时给了会话与凭据时以**会话**为准 —— 浏览器里带着登录态再传凭据是误用，
//      按会话走不会出现「用自己的号却按别人的号记账」。
//
// 【禁言（三道门都要过）】会话靠 sessionVersion 失效链，但那对②无效 ——
// 凭据是长期凭据，改密码都不会作废它。所以②必须**每次实时查** isCurrentlyBanned，
// 否则被禁言的机器人拿着凭据照跑，而站长没有任何手段能拦住它。
//
// 【CSRF】②与③的凭据都在 header/body 里而不是 cookie 里，跨站页面拿不到就伪造不出
// 请求；CSRF 中间件对「无 Origin/Referer」的原生客户端本就放行（见 src/middleware.ts），
// 因此都不需要加进豁免名单。

import { getCurrentUser, isCurrentlyBanned } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { verifyCredentials } from '@/lib/credential-auth';
import { validateFishToken, touchFishTokenUsage } from '@/lib/fish-token-service';
import { clientIp } from '@/lib/request-ip';
import { rateLimit, RULES } from '@/lib/rate-limit';
import { apiErr } from '@/lib/format';

/**
 * 取 `Authorization: Bearer <token>` 里的令牌；没有或格式不对返回 null。
 * 大小写不敏感地匹配 `Bearer`（各家 HTTP 客户端大小写写法不一，RFC 7235 说 scheme 不敏感）。
 */
function bearerToken(req: Request): string | null {
  const raw = req.headers.get('authorization');
  if (!raw) return null;
  const m = /^Bearer\s+(.+)$/i.exec(raw.trim());
  return m ? m[1].trim() : null;
}

/** 通过鉴权的操作者。各路由只保底到「id + 用户名」。 */
export interface MarketActor {
  id: string;
  username: string;
  /** 走的哪道门 —— 供路由做能力判断与排障，不参与授权决策本身。 */
  via: 'session' | 'credentials' | 'read-token';
}

/**
 * 禁言文案：本命名空间的接口共用一条，别各写各的。
 *
 * 导出是为了 `rent/route.ts` —— 那条路由不走这里的三道门（它只认会话，
 * 理由见它自己的文件头），但禁言这一道**必须一致**：同一个页面上，
 * 转账说「无法使用鱼干市场」而租框说别的，用户只会以为其中一条坏了。
 */
export const BANNED_MESSAGE = '你已被禁言，暂时无法使用鱼干市场';

export interface MarketAuthOptions {
  /**
   * 是否放行只读凭据（`Authorization: Bearer <token>`）。**默认 false**。
   *
   * 默认关门是刻意的：新增路由忘了传 opts 时，令牌在这条路上是**不生效**的，
   * 而不是「悄悄多开了一扇门」。只有 balance 与 transactions 两条读接口传 true。
   * 转账 / 收银台 / 用户搜索**一律不传** —— 凭据的全部意义就是「只能读」。
   */
  allowReadToken?: boolean;
}

export async function requireMarketActor(
  req: Request,
  body: unknown,
  opts?: MarketAuthOptions
): Promise<MarketActor | Response> {
  // ① 会话优先（网页）
  const session = await getCurrentUser();
  if (session) {
    if (isCurrentlyBanned(session)) return apiErr(403, BANNED_MESSAGE);
    return { id: session.id, username: session.username, via: 'session' };
  }

  // ② 只读凭据（站外机器人 / 银行）。只在读接口上放行，见 MarketAuthOptions。
  const bearer = bearerToken(req);
  if (bearer && opts?.allowReadToken) {
    const token = await validateFishToken(bearer);
    if (!token) return apiErr(401, '凭据无效、已吊销或已过期');
    const holder = await prisma.user.findUnique({
      where: { id: token.userId },
      select: { id: true, username: true, role: true, isBanned: true, banUntil: true },
    });
    if (!holder) return apiErr(401, '凭据无效、已吊销或已过期');
    // 禁言必须实时拦：凭据不是会话，不走 sessionVersion 那条失效链 ——
    // 它是**长期**凭据，改密码都不会作废它，所以治理动作只能在这里生效。
    // 这是站长处理失控机器人的唯一手段，绝不能漏。
    if (isCurrentlyBanned(holder)) return apiErr(403, BANNED_MESSAGE);

    // 限频：不跑 scrypt，所以不用 fishApi* 那两条 CPU 闸门（见 rate-limit.ts 的注释）。
    const ip = clientIp(req);
    const userQuota = rateLimit(`fish-token:${holder.id}`, RULES.fishTokenPerUser);
    const ipQuota = ip ? rateLimit(`fish-token:ip:${ip}`, RULES.fishTokenPerIp) : null;
    if (!userQuota.allowed || (ipQuota && !ipQuota.allowed)) {
      return apiErr(429, '请求过于频繁，请稍后再试');
    }

    void touchFishTokenUsage(bearer);
    return { id: holder.id, username: holder.username, via: 'read-token' };
  }
  // 带着令牌打**写**接口：明确告诉它为什么不行，而不是让它掉进下面
  // 「两边都没带凭据」的 401 —— 那会让人以为是自己密码写错了。
  if (bearer) {
    return apiErr(403, '该凭据只能读取余额与流水，不能转账');
  }

  // ③ 无会话、无令牌 → 凭据随请求走（站外脚本 / 机器人）
  const b = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
  const username = typeof b.username === 'string' ? b.username.trim() : '';
  const password = typeof b.password === 'string' ? b.password : '';
  if (!username || !password) {
    return apiErr(401, '请先登录，或在请求体里带上 username 与 password');
  }

  // CPU 保护：见文件头第 1 条。两条配额都调用（与点赞同款：不短路，免得
  // 「用户名桶满了就不记 IP 桶」让攻击者换用户名白嫖 IP 预算）。
  const ip = clientIp(req);
  const userQuota = rateLimit(`fish-api:${username.toLowerCase()}`, RULES.fishApiPerUser);
  const ipQuota = ip ? rateLimit(`fish-api:ip:${ip}`, RULES.fishApiPerIp) : null;
  if (!userQuota.allowed || (ipQuota && !ipQuota.allowed)) {
    return apiErr(429, '请求过于频繁，请稍后再试');
  }

  const cred = await verifyCredentials(username, password, ip);
  if (!cred.ok) return apiErr(cred.status, cred.message);
  if (isCurrentlyBanned(cred.user)) return apiErr(403, BANNED_MESSAGE);

  return { id: cred.user.id, username: cred.user.username, via: 'credentials' };
}
