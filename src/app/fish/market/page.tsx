import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Bot, ReceiptText } from 'lucide-react';
import { getCurrentUser } from '@/lib/auth';
import { loginUrlWithNext } from '@/lib/safe-url';
import { getBalance } from '@/lib/fish-service';
import TransferPanel from './TransferPanel';

// 鱼干市场 —— 第一期只有一个功能：用户间转账（无手续费）。
// 需登录，不要求 core+（与 /fish 面板、签到同档）。
export const dynamic = 'force-dynamic';

export default async function FishMarketPage() {
  const user = await getCurrentUser();
  if (!user) redirect(loginUrlWithNext('/fish/market'));

  const balance = await getBalance(user.id);

  return (
    <div className="content-wrapper">
      <h1 className="page-title">
        <span className="icon icon-market" aria-hidden="true" style={{ marginRight: '0.5rem' }}></span>
        鱼干市场
      </h1>
      <p className="market-subtitle">给任意一位站内用户转账 —— 零手续费，即时到账。</p>

      <TransferPanel balance={balance} />

      <p className="market-foot">
        <Link className="market-foot__link" href="/fish/transactions?type=transfer_all">
          <ReceiptText aria-hidden="true" /> 查看转账记录
        </Link>
      </p>

      {/* 入口放这里而不是 /fish 的行动条：那一行被 fish-layout.spec.ts 钉死为 3 颗，
          且三颗必须同行 —— 加第四颗会把它挤到第二行（那正是该用例存在的理由）。 */}
      <p className="market-foot">
        <Link className="market-foot__link" href="/fish/api">
          <Bot aria-hidden="true" /> 接口 / 机器人接入
        </Link>
      </p>
    </div>
  );
}
