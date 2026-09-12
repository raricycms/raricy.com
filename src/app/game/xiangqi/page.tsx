import Combined from '@/app/components/Xiangqi';
import GamePageShell from '@/app/components/GamePageShell';
import { OnlineFocusLock } from '@/app/components/OnlineRoomPanel';
import Online from '@/app/components/OnlineXiangqi';
import { normalizeRoomCode } from '@/lib/board-shared';
import { requireCoreUser } from '@/lib/guard';

// 读 searchParams（?mode= / ?room=）分发模式，故不能静态化。
// 代价：本页失去静态预渲染；收益是零 Suspense、零 hydration 闪烁
// （用 useSearchParams 就必须在外层包 <Suspense>，否则 next build 直接报错）。
export const dynamic = 'force-dynamic';

export const metadata = { title: '中国象棋 · 聪明山' };

const SOLO_DESC = '红先黑后，9 路 10 行。马蹩腿、象塞眼、炮翻山、兵过河，将死或困毙即分胜负。同一台设备两人轮流走。';
const ONLINE_DESC = '创建房间或输入房号，和真人对手隔空对弈。支持观战。';

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ mode?: string; room?: string }>;
}) {
  const sp = await searchParams;

  // 单机：保持匿名可玩、专注模式也能直达（与五子棋单机同一约定）
  if (sp.mode !== 'online') {
    return (
      <GamePageShell
        title="中国象棋"
        pageClass="xiangqi-page"
        backClass="xiangqi-back"
        description={SOLO_DESC}
      >
        <Combined />
      </GamePageShell>
    );
  }

  // 联机：登录 + core+。未登录 → 跳登录页并带 next 回跳本页；已登录非 core → 403。
  // **只在联机分支调** —— 单机必须保持匿名可玩，无条件调用会把单机也挡在门外。
  const user = await requireCoreUser();

  // 专注模式给一张带出路的提示卡，而不是 forbidden() —— 用户需要知道怎么关掉它。
  // 服务端接口同样是硬 403（见 api/game/_shared.ts）。
  const body = user.focusMode ? (
    <OnlineFocusLock />
  ) : (
    <Online initialRoom={normalizeRoomCode(sp.room ?? null)} />
  );

  return (
    <GamePageShell
      title="中国象棋 · 联机"
      pageClass="xiangqi-page"
      backClass="xiangqi-back"
      description={ONLINE_DESC}
    >
      {body}
    </GamePageShell>
  );
}
