import GamePageShell from '@/app/components/GamePageShell';
import CubeTicTacToe from '@/app/components/CubeTicTacToe';

export const metadata = {
  title: '立方棋 · 聪明山',
};

export default function CubeTicTacToePage() {
  return (
    <GamePageShell
      title="立方棋"
      pageClass="cubettt-page"
      backClass="cubettt-back"
      description="4×4×4 立体井字棋，76 条连线四子连珠即获胜。拖拽旋转视角，A/S/D 键展开爆炸视图。本地双人对战，红方先手。"
    >
      <CubeTicTacToe />
    </GamePageShell>
  );
}