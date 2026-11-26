import { getCurrentUser, isCoreUser } from '@/lib/auth';
import { isFocusFishTradeBlocked } from '@/lib/focus-mode';
import { gameVisibleTo, type GameEntry } from '@/lib/game-catalog';

/**
 * 玩具陈列页共用：按当前会话摘掉查看者看不到的卡。
 *
 * 清单（`game-catalog.ts`）是编译期数据，不知道看的人是谁；门槛写在卡片的 `gate` 上，
 * 由这里一次性翻译成会话事实。两个陈列页都走这个出口，别在页面里各判一半。
 */
export async function gamesVisibleToViewer(games: readonly GameEntry[]): Promise<GameEntry[]> {
  const user = await getCurrentUser();
  const viewer = { core: isCoreUser(user), fishTradeBlocked: isFocusFishTradeBlocked(user) };
  return games.filter((game) => gameVisibleTo(game, viewer));
}
