import GamePageShell from '@/app/components/GamePageShell';
import Gomoku from '@/app/components/Gomoku';

export const metadata = {
  title: '五子棋 · 聪明山',
};

export default function GomokuPage() {
  return (
    <GamePageShell
      title="五子棋"
      pageClass="gomoku-page"
      backClass="gomoku-back"
      description="15×15 棋盘，五子连线即获胜。支持双人对战与人机对战（AI 带深度搜索，人执黑先手）。"
    >
      <Gomoku />
    </GamePageShell>
  );
}