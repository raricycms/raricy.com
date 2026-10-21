// 游戏模块不能依赖 Next.js、Prisma 或主站会话密钥。
import type { RealtimeIdentity } from '../../../shared/realtime/protocol.js';
export type { RealtimeIdentity } from '../../../shared/realtime/protocol.js';

export type GameMessage =
  | { binary: false; data: string }
  | { binary: true; data: Uint8Array };

export interface RealtimePeer {
  id: string;
  identity: Readonly<RealtimeIdentity>;
  send(data: string | Uint8Array): boolean;
  disconnect(): void;
}

export interface RealtimeSession {
  receive(message: GameMessage): void;
  close(): void;
}

export interface RealtimeGame {
  id: string;
  /** 必须验证票据绑定的 gameId，并原子消费；signal 在超时、断连时取消验证。 */
  authenticate(input: { gameId: string; ticket: string; signal: AbortSignal }): Promise<RealtimeIdentity | null>;
  /** 定期复核主站会话版本、账号状态与「是否屏蔽玩具区」，失败即关闭现有连接。 */
  revalidate(input: { identity: RealtimeIdentity; signal: AbortSignal }): Promise<boolean>;
  /** 认证成功后才进入游戏；帧处理保持同步，异步存储放在游戏自己的边界。 */
  connect(peer: RealtimePeer): RealtimeSession;
}
