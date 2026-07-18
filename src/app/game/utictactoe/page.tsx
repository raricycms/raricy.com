import Link from 'next/link';
import UltimateTicTacToe from '@/app/components/UltimateTicTacToe';

export const metadata = {
  title: '超级井字棋 · 聪明山',
};

export default function UltimateTicTacToePage() {
  return (
    <main className="wrap" style={{ paddingTop: 40 }}>
      <Link href="/game" className="lede" style={{ display: 'inline-block', marginBottom: 12 }}>
        ← 返回玩具
      </Link>
      <h1 className="section-title">超级井字棋</h1>
      <p className="lede">
        大棋盘套小棋盘，你的落子决定对手的战场。本地双人对战，先手为 X。
      </p>
      <UltimateTicTacToe />
    </main>
  );
}
