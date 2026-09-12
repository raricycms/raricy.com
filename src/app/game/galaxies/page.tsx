import GamePageShell from '@/app/components/GamePageShell';
import Galaxies from '@/app/components/Galaxies';

export const metadata = {
  title: '螺旋星系 · 聪明山',
};

export default function GalaxiesPage() {
  return (
    <GamePageShell
      title="螺旋星系"
      pageClass="puzzle-page"
      backClass="puzzle-back"
      description="将网格划分为星系区域。每个区域必须围绕一个圆点保持 180 度旋转对称，且每个区域恰好包含一个圆点。左键点击边来放置 / 移除边界，右键拖动来标记每个格子归属的圆点。"
    >
      <Galaxies />
    </GamePageShell>
  );
}