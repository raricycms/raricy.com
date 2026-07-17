import Link from 'next/link';
import Gomoku from '@/app/components/Gomoku';

export const metadata = {
  title: '五子棋 · 聪明山',
};

export default function GomokuPage() {
  return (
    <main className="wrap" style={{ paddingTop: 40 }}>
      <Link href="/game" className="lede" style={{ display: 'inline-block', marginBottom: 12 }}>
        ← 返回玩具
      </Link>
      <h1 className="section-title">五子棋</h1>
      <p className="lede">
        15×15 棋盘，五子连线即获胜。支持双人对战与人机对战（AI 带深度搜索，人执黑先手）。
      </p>
      <Gomoku />
    </main>
  );
}
