// 鱼干市场接口统一鉴权：**会话优先；没有会话时退回请求体里的 username + password**。
//
// 【为什么允许凭据进 body】站外脚本 / 机器人要「一次发包完成一笔转账」——
// 很多运行环境存不住 cookie，分两步（先 /api/auth/login 再带 cookie 打业务接口）
// 等于要求调用方自己维护会话。这里让凭据随请求走一次，不签发会话。
//
// 【它不是一条更弱的门】校验走 credential-auth.ts 的同一份实现（werkzeug 兼容的
// 哈希校验 + 与 /api/auth/login **共用**的撞库限频桶），禁言判定与会话路径同款；
// 失败文案也一致。三处差异都是刻意的：
//   1. 无状态路径**每次请求**都要跑一次 scrypt ⇒ 多一道「成功也计数」的配额
//      （RULES.fishApiPerUser / fishApiPerIp），会话路径不花 CPU 故不受它管；
//   2. 凭据只用于本次校验，绝不写日志、绝不进响应（密码是调用方的，不是我们的）；
//   3. 同时给了会话与凭据时以**会话**为准 —— 浏览器里带着登录态再传凭据是误用，
//      按会话走不会出现「用自己的号却按别人的号记账」。
//
// 【CSRF】凭据在 body 里而不是 cookie 里，跨站页面拿不到密码就伪造不出请求；
// CSRF 中间件对「无 Origin/Referer」的原生客户端本就放行（见 src/middleware.ts），
// 因此不需要把它加进豁免名单。

import { getCurrentUser, isCurrentlyBanned } from '@/lib/auth';
import { verifyCredentials } from '@/lib/credential-auth';
import { clientIp } from '@/lib/request-ip';
import { rateLimit, RULES } from '@/lib/rate-limit';
import { apiErr } from '@/lib/format';

/** 通过鉴权的操作者。两个路径都只保底到「id + 用户名」（各路由只用这两样）。 */
export interface MarketActor {
  id: string;
  username: string;
}

/** 禁言文案：三条接口共用一条，别各写各的。 */
const BANNED_MESSAGE = '你已被禁言，暂时无法使用鱼干市场';

export async function requireMarketActor(
  req: Request,
  body: unknown
): Promise<MarketActor | Response> {
  // ① 会话优先（网页）
  const session = await getCurrentUser();
  if (session) {
    if (isCurrentlyBanned(session)) return apiErr(403, BANNED_MESSAGE);
    return { id: session.id, username: session.username };
  }

  // ② 无会话 → 凭据随请求走（站外脚本 / 机器人）
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

  return { id: cred.user.id, username: cred.user.username };
}
