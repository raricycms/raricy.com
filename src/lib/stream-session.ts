import { prisma } from './db';

/** 先注册可被 kick 的订阅，再复核版本；复核前不得发任何私有帧，堵住鉴权与建流间的撤权窗口。 */
export async function isStreamSessionCurrent(user: { id: string; sessionVersion: number }): Promise<boolean> {
  const current = await prisma.user.findUnique({ where: { id: user.id }, select: { sessionVersion: true } });
  return current?.sessionVersion === user.sessionVersion;
}
