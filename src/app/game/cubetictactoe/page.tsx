import Link from 'next/link';
import CubeTicTacToe from '@/app/components/CubeTicTacToe';

export const metadata = {
  title: '立方棋 · 聪明山',
};

export default function CubeTicTacToePage() {
  return (
    <main className="wrap" style={{ paddingTop: 40 }}>
      <Link href="/game" className="lede" style={{ display: 'inline-block', marginBottom: 12 }}>
        ← 返回玩具
      </Link>
      <h1 className="section-title">立方棋</h1>
      <p className="lede">
        4×4×4 立体井字棋，76 条连线四子连珠即获胜。拖拽旋转视角，A/S/D 键展开爆炸视图。本地双人对战，红方先手。
      </p>
      <CubeTicTacToe />
    </main>
  );
}
