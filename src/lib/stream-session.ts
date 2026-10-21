import { prisma } from './db';
import { isCoreUser, isCurrentlyBanned } from './auth';
import { isFocusLobbyBlocked } from './focus-mode';

/**
 * 每帧（含心跳）复核数据库，覆盖 CLI 在另一个进程撤权的情形。
 * bus 的同步背压协议保持不变；异步鉴权串行投递、有界排队，失败即断流。
 */
export function verifiedStreamWriter(
  verify: () => Promise<boolean>, write: (chunk: string) => boolean, close: () => void, limit: number
): (chunk: string) => boolean {
  const queue: string[] = [];
  let draining = false;
  let stopped = false;
  async function drain() {
    if (draining) return;
    draining = true;
    try {
      while (queue.length && !stopped) {
        const chunk = queue.shift()!;
        if (!(await verify()) || !write(chunk)) {
          stopped = true; queue.length = 0; close();
        }
      }
    } catch {
      stopped = true; queue.length = 0; close();
    } finally { draining = false; }
  }
  return (chunk) => {
    if (stopped || queue.length >= limit) return false;
    queue.push(chunk);
    void drain();
    return true;
  };
}

/** 先注册可被 kick 的订阅，再复核版本；复核前不得发任何私有帧，堵住鉴权与建流间的撤权窗口。 */
export async function isStreamSessionCurrent(user: { id: string; sessionVersion: number }): Promise<boolean> {
  const current = await prisma.user.findUnique({ where: { id: user.id }, select: { sessionVersion: true } });
  return current?.sessionVersion === user.sessionVersion;
}

/**
 * 讨论还受角色与「大区屏蔽」影响；两者变化不递增会话版本，必须单独复核快照。
 * 快照里存的是**连接建立时算好的 lobbyBlocked**（focusMode && focusBlockLobby），
 * 重连后按新值重新决定收不收大区广播。
 */
export async function isChatStreamSessionCurrent(
  user: { id: string; sessionVersion: number; lobbyBlocked: boolean }
): Promise<boolean> {
  const current = await prisma.user.findUnique({
    where: { id: user.id },
    select: {
      sessionVersion: true,
      role: true,
      isBanned: true,
      banUntil: true,
      focusMode: true,
      focusBlockLobby: true,
    },
  });
  return !!current && current.sessionVersion === user.sessionVersion &&
    isCoreUser(current) && !isCurrentlyBanned(current) &&
    isFocusLobbyBlocked(current) === user.lobbyBlocked;
}
