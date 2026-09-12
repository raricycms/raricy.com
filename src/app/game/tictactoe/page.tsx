import GamePageShell from '@/app/components/GamePageShell';
import OnlineTicTacToe from '@/app/components/OnlineTicTacToe';
import { OnlineFocusLock } from '@/app/components/OnlineRoomPanel';
import { normalizeRoomCode } from '@/lib/board-shared';
import { requireCoreUser } from '@/lib/guard';

// 读 searchParams（?room=）分发邀请链接，故不能静态化。
// 代价：本页失去静态预渲染；收益是零 Suspense、零 hydration 闪烁
// （用 useSearchParams 就必须在外层包 <Suspense>，否则 next build 直接报错）。
export const dynamic = 'force-dynamic';

export const metadata = { title: '井字棋 · 聪明山' };

const DESC = '3×3 棋盘，三子连线即获胜。创建房间或输入房号，和真人对手隔空对弈。支持观战。';

/**
 * 井字棋只有联机一个模式（单机的三连棋站内已有「超级井字棋」与「立方棋」两款），
 * 所以**无条件**要求登录 + core+ —— 不像五子棋那样要按 ?mode= 分单机/联机两支。
 * 页面壳与权限口径对齐 /game/gomoku?mode=online，免得两款棋的联机体验不一致。
 */
export default async function TicTacToePage({
  searchParams,
}: {
  searchParams: Promise<{ room?: string }>;
}) {
  const sp = await searchParams;

  const user = await requireCoreUser();

  // 专注模式给一张带出路的提示卡，而不是 forbidden() —— 用户需要知道怎么关掉它。
  // 服务端接口同样是硬 403（见 api/game/_shared.ts）。
  const body = user.focusMode ? (
    <OnlineFocusLock />
  ) : (
    <OnlineTicTacToe initialRoom={normalizeRoomCode(sp.room ?? null)} />
  );

  return (
    <GamePageShell
      title="井字棋 · 联机"
      pageClass="tictactoe-page"
      backClass="tictactoe-back"
      description={DESC}
    >
      {body}
    </GamePageShell>
  );
}
