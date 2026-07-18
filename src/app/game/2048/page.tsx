import Link from 'next/link';
import Game2048 from '@/app/components/Game2048';

export const metadata = {
  title: '2048 · 聪明山',
};

export default function Game2048Page() {
  return (
    <main className="wrap" style={{ paddingTop: 40 }}>
      <Link href="/game" className="lede" style={{ display: 'inline-block', marginBottom: 12 }}>
        ← 返回玩具
      </Link>
      <h1 className="section-title">2048</h1>
      <p className="lede">用方向键滑动合并数字方块，挑战 2048。</p>
      <Game2048 />
    </main>
  );
}
