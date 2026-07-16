import Link from 'next/link';
import Galaxies from '@/app/components/Galaxies';

export const metadata = {
  title: '螺旋星系 · 聪明山',
};

export default function GalaxiesPage() {
  return (
    <main className="wrap" style={{ paddingTop: 40 }}>
      <Link href="/game" className="lede" style={{ display: 'inline-block', marginBottom: 12 }}>
        ← 返回玩具
      </Link>
      <h1 className="section-title">螺旋星系</h1>
      <p className="lede">
        将网格划分为星系区域。每个区域必须围绕一个圆点保持 180 度旋转对称，且每个区域恰好包含一个圆点。
        左键点击边来放置 / 移除边界，右键拖动来标记每个格子归属的圆点。
      </p>
      <Galaxies />
    </main>
  );
}
