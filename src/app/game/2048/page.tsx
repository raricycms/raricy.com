import Link from 'next/link';
import Game2048 from '@/app/components/Game2048';

export const metadata = {
  title: '2048 · 聪明山',
};

export default function Game2048Page() {
  return (
    <div className="container game-2048-page">
      <Link href="/game" className="game-2048-back">
        ← 返回玩具
      </Link>
      <Game2048 />
    </div>
  );
}