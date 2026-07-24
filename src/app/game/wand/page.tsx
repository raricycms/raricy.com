import GamePageShell from '@/app/components/GamePageShell';
import WandDemo from '@/app/components/WandDemo';

export const metadata = {
  title: '魔法棒 · 聪明山',
};

export default function WandPage() {
  return (
    <GamePageShell
      title="魔法棒"
      pageClass="wand-page"
      backClass="wand-back"
      description="方向键移动白点，蓝色是湖不能进。登录后会向服务器申请一次性令牌并连接实时 WebSocket（demo）。"
    >
      <WandDemo />
    </GamePageShell>
  );
}
