// 网络入口的密码计算预算：会话付款、登录、改密、签发凭据共用用户 ID 桶，
// OAuth 按实际 clientId 使用自己的档位。CLI 不走网络预算；所有计算仍受 password.ts
// 的进程内在途上限保护。先同步检查全部维度，再一起记数，拒绝不耗其他桶。
import { isRateLimited, recordRateLimitHit, RULES, type RateRule } from './rate-limit';

export function allowPasswordAttempt(subject: string, ip?: string, rule: RateRule = RULES.passwordPerUser): boolean {
  const budgets = [
    { key: 'password:global', rule: RULES.passwordGlobal },
    { key: `password:${subject}`, rule },
    ...(ip ? [{ key: `password:ip:${ip}`, rule: RULES.passwordPerIp }] : []),
  ];
  if (budgets.some(({ key, rule }) => isRateLimited(key, rule))) return false;
  for (const { key } of budgets) recordRateLimitHit(key);
  return true;
}
