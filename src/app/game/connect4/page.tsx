import Link from 'next/link';
import Connect4 from '@/app/components/Connect4';

export const metadata = {
  title: '四子棋 · 聪明山',
};

export default function Connect4Page() {
  return (
    <main className="wrap" style={{ paddingTop: 40 }}>
      <Link href="/game" className="lede" style={{ display: 'inline-block', marginBottom: 12 }}>
        ← 返回玩具
      </Link>
      <h1 className="section-title">四子棋</h1>
      <p className="lede">
        4×7 棋盘，重力落子，四子连线即获胜。支持普通、障碍、盲棋、盲棋2 四种模式，可点击或按数字键 1-7 落子。
      </p>
      <Connect4 />
    </main>
  );
}
