import GamePageShell from '@/app/components/GamePageShell';
import Connect4 from '@/app/components/Connect4';

export const metadata = {
  title: '四子棋 · 聪明山',
};

export default function Connect4Page() {
  return (
    <GamePageShell
      title="四子棋"
      pageClass="connect4-page"
      backClass="connect4-back"
      description="4×7 棋盘，重力落子，四子连线即获胜。支持普通、障碍、盲棋、盲棋2 四种模式，可点击或按数字键 1-7 落子。"
    >
      <Connect4 />
    </GamePageShell>
  );
}