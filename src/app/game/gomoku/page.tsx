import GamePageShell from '@/app/components/GamePageShell';
import Gomoku from '@/app/components/Gomoku';
import { OnlineGomokuFocusLock } from '@/app/components/OnlineGomoku';
import { normalizeRoomCode } from '@/lib/gomoku-shared';
import { requireCoreUser } from '@/lib/guard';

// 读 searchParams（?mode= / ?room=）分发模式，故不能静态化。
// 代价：本页失去静态预渲染；收益是零 Suspense、零 hydration 闪烁
// （用 useSearchParams 就必须在外层包 <Suspense>，否则 next build 直接报错）。
export const dynamic = 'force-dynamic';

export const metadata = { title: '五子棋 · 聪明山' };

const SOLO_DESC =
  '15×15 棋盘，五子连线即获胜。支持双人对战与人机对战（AI 带深度搜索，人执黑先手）。';
const ONLINE_DESC = '创建房间或输入房号，和真人对手隔空对弈。支持观战。';

export default async function GomokuPage({
  searchParams,
}: {
  searchParams: Promise<{ mode?: string; room?: string }>;
}) {
  const sp = await searchParams;

  // 单机：保持匿名可玩、专注模式也能直达（现有行为，别动）
  if (sp.mode !== 'online') {
    return (
      <GamePageShell
        title="五子棋"
        pageClass="gomoku-page"
        backClass="gomoku-back"
        description={SOLO_DESC}
      >
        <Gomoku />
      </GamePageShell>
    );
  }

  // 联机：登录 + core+。未登录 → 跳登录页并带 next 回跳本页；已登录非 core → 403。
  // **只在联机分支调** —— 单机必须保持匿名可玩，无条件调用会把单机也挡在门外。
  const user = await requireCoreUser();

  // 专注模式给一张带出路的提示卡，而不是 forbidden() —— 用户需要知道怎么关掉它。
  // 服务端接口同样是硬 403（见 api/game/gomoku/_shared.ts）。
  const body = user.focusMode ? (
    <OnlineGomokuFocusLock />
  ) : (
    <Gomoku defaultMode="online" initialRoom={normalizeRoomCode(sp.room ?? null)} />
  );

  return (
    <GamePageShell
      title="五子棋 · 联机"
      pageClass="gomoku-page"
      backClass="gomoku-back"
      description={ONLINE_DESC}
    >
      {body}
    </GamePageShell>
  );
}
