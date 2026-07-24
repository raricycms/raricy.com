import GamePageShell from '@/app/components/GamePageShell';
import Atamas from '@/app/components/Atamas/Atamas';

export const metadata = {
  title: 'ATÅMAS · 聪明山',
};

export default function AtamasPage() {
  return (
    <GamePageShell
      title="ATÅMAS"
      pageClass="game-atamas-page"
      backClass="game-atamas-back"
      description="在圆环上放置数字和加号，通过巧妙布局触发链式合并，挑战最高分！"
    >
      <Atamas />
    </GamePageShell>
  );
}