import { prisma } from './db';
import { isCoreUser, isCurrentlyBanned } from './auth';

/** 先注册可被 kick 的订阅，再复核版本；复核前不得发任何私有帧，堵住鉴权与建流间的撤权窗口。 */
export async function isStreamSessionCurrent(user: { id: string; sessionVersion: number }): Promise<boolean> {
  const current = await prisma.user.findUnique({ where: { id: user.id }, select: { sessionVersion: true } });
  return current?.sessionVersion === user.sessionVersion;
}

/** 讨论还受角色与专注模式影响；两者变化不递增会话版本，必须单独复核快照。 */
export async function isChatStreamSessionCurrent(
  user: { id: string; sessionVersion: number; focusMode: boolean | null }
): Promise<boolean> {
  const current = await prisma.user.findUnique({
    where: { id: user.id },
    select: { sessionVersion: true, role: true, isBanned: true, banUntil: true, focusMode: true },
  });
  return !!current && current.sessionVersion === user.sessionVersion &&
    isCoreUser(current) && !isCurrentlyBanned(current) &&
    (current.focusMode ?? false) === (user.focusMode ?? false);
}
