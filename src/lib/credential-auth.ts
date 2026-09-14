// ─────────────────────────────────────────────────────────────────────────────
// credential-auth.ts — 「用户名 + 密码」校验（两个门口共用）
//
// 用它的两个门口：
//   • POST /api/auth/login —— 校验通过后**签发会话 cookie**；
//   • 鱼干市场的无状态接口（/api/fish/market/*）—— 校验通过后直接以该用户身份
//     执行本次操作，**不签发会话**（站外脚本「单次发包」，运行环境往往存不住 cookie）。
//
// 【为什么必须共用】两处都是「未认证就能让服务端跑一次 scrypt」的入口
// （werkzeug 参数：32MB 内存 + 数十毫秒 CPU），撞库与 CPU DoS 的防线必须逐字相同。
// 各写一份的必然结果是：一边收紧了、另一边忘了改 —— 而那一边就是绕过口，
// 攻击者只会挑松的那个门。
//
// 【限频语义】（与登录完全一致，连桶都共用）
//   · **失败才计数**：成功的校验不消耗配额，正常用户与机器人不会被自己的成功
//     记录挡住（见 rate-limit.ts 的 isRateLimited 注释）；
//   · 双维度：IP（挡「一台机器扫一批账号」）+ 用户名小写归一（挡「一批机器打
//     同一个账号」），任一超限即 429；
//   · 检查放在查库与 verifyPassword **之前** —— 被挡的请求不跑 scrypt。
//   · 桶键就是登录那两个（login:ip: / login:user:）：**同一份凭据、同一个预算**。
//     撞库从哪个门进来都一样贵；代价是机器人拿错密码刷多了会连带把网页登录
//     挡一会儿 —— 那正是我们想要的（那条路径本来就在被撞）。
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from './db';
import { verifyPassword } from './password';
import { isRateLimited, recordRateLimitHit, RULES } from './rate-limit';

/** 校验通过时返回的最小用户快照（两个门口各自需要的字段都在里面）。 */
export interface CredentialUser {
  id: string;
  username: string;
  role: string;
  /** 已归一到 0（签发会话时直接用，不必再判空）。 */
  sessionVersion: number;
  isBanned: boolean | null;
  banUntil: Date | null;
}

export type CredentialResult =
  | { ok: true; user: CredentialUser }
  | { ok: false; status: 401 | 429; message: string };

/**
 * 校验用户名（或邮箱）+ 密码。
 *
 * 密码错误与用户不存在返回**同一条** 401 文案 —— 不给用户名枚举留信道。
 *
 * @param ip clientIp(req) 的结果；取不到时跳过 IP 维度（别传占位串）
 */
export async function verifyCredentials(
  username: string,
  password: string,
  ip?: string
): Promise<CredentialResult> {
  const ipKey = ip ? `login:ip:${ip}` : null;
  const userKey = `login:user:${username.toLowerCase()}`;
  if (
    (ipKey && isRateLimited(ipKey, RULES.loginPerIp)) ||
    isRateLimited(userKey, RULES.loginPerUser)
  ) {
    return { ok: false, status: 429, message: '尝试过于频繁，请 15 分钟后再试' };
  }

  // 支持用户名或邮箱登录（与 /api/auth/login 同款）
  const user = await prisma.user.findFirst({
    where: { OR: [{ username }, { email: username }] },
    select: {
      id: true,
      username: true,
      role: true,
      passwordHash: true,
      sessionVersion: true,
      isBanned: true,
      banUntil: true,
    },
  });

  if (!user || !(await verifyPassword(password, user.passwordHash))) {
    if (ipKey) recordRateLimitHit(ipKey);
    recordRateLimitHit(userKey);
    return { ok: false, status: 401, message: '用户名或密码错误' };
  }

  return {
    ok: true,
    user: {
      id: user.id,
      username: user.username,
      role: user.role,
      sessionVersion: user.sessionVersion ?? 0,
      isBanned: user.isBanned,
      banUntil: user.banUntil,
    },
  };
}
