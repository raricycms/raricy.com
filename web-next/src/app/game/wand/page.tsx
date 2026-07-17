import Link from 'next/link';
import WandDemo from '@/app/components/WandDemo';

export const metadata = {
  title: '魔法棒 · 聪明山',
};

export default function WandPage() {
  return (
    <main className="wrap" style={{ paddingTop: 40 }}>
      <Link href="/game" className="lede" style={{ display: 'inline-block', marginBottom: 12 }}>
        ← 返回玩具
      </Link>
      <h1 className="section-title">魔法棒</h1>
      <p className="lede">
        方向键移动白点，蓝色是湖不能进。登录后会向服务器申请一次性令牌并连接实时 WebSocket（demo）。
      </p>
      <WandDemo />
    </main>
  );
}
