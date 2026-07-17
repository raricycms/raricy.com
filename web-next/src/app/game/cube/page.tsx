import Link from 'next/link';
import CubeRoll from '@/app/components/CubeRoll';

export const metadata = {
  title: '立方体滚滚 · 聪明山',
};

export default function CubePage() {
  return (
    <main className="wrap" style={{ paddingTop: 40 }}>
      <Link href="/game" className="lede" style={{ display: 'inline-block', marginBottom: 12 }}>
        ← 返回玩具
      </Link>
      <h1 className="section-title">立方体滚滚</h1>
      <p className="lede">
        在多面体上涂满蓝色。每当你把多面体滚到蓝色格子上时，多面体底面和格子的颜色就会互换。
        使用方向键、点击格子周围或滑动屏幕来滚动多面体。
      </p>
      <CubeRoll />
    </main>
  );
}
