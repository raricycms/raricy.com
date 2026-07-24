import GamePageShell from '@/app/components/GamePageShell';
import UltimateTicTacToe from '@/app/components/UltimateTicTacToe';

export const metadata = {
  title: '超级井字棋 · 聪明山',
};

export default function UltimateTicTacToePage() {
  return (
    <GamePageShell
      title="超级井字棋"
      pageClass="uttt-page"
      backClass="uttt-back"
      description="大棋盘套小棋盘，你的落子决定对手的战场。本地双人对战，先手为 X。"
    >
      <UltimateTicTacToe />
    </GamePageShell>
  );
}