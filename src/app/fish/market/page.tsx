import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Bot, ReceiptText, TrendingUp } from 'lucide-react';
import { getCurrentUser } from '@/lib/auth';
import { loginUrlWithNext } from '@/lib/safe-url';
import { getBalance } from '@/lib/fish-service';
import { listShopItems } from '@/lib/frame-shop-service';
import TransferPanel from './TransferPanel';
import ShopPanel from './ShopPanel';

// 鱼干市场 —— 两块：用户间转账（无手续费）+ 鱼干商城（租头像框）。
// 需登录，不要求 core+（与 /fish 面板、签到同档）。
export const dynamic = 'force-dynamic';

export default async function FishMarketPage() {
  const user = await getCurrentUser();
  if (!user) redirect(loginUrlWithNext('/fish/market'));

  // 商城列表在**服务端**算好（`listShopItems` 已经把「素材在不在、我持有到什么时候、
  // 过没过期」都判成了结果），客户端组件一次都不做时间比较 —— 见 ShopPanel 的文件头。
  const [balance, shopItems] = await Promise.all([
    getBalance(user.id),
    listShopItems(user.id),
  ]);

  return (
    <div className="content-wrapper">
      <h1 className="page-title">
        <span className="icon icon-market" aria-hidden="true" style={{ marginRight: '0.5rem' }}></span>
        鱼干市场
      </h1>
      <p className="market-subtitle">
        给任意一位站内用户转账 —— 零手续费，即时到账；也可以用鱼干租一款头像框。
      </p>

      <TransferPanel balance={balance} />

      {/* ⚠️ 这一节的标题**不能用 .page-title** —— e2e 用裸选择器
          `page.locator('.page-title')` 断言「鱼干市场」，同一页出现第二个就红
          （同一条纪律也管着下面的按钮类名，见 _fish-market.scss 尾部的说明）。
          id 给深链用：/fish 卡片的「鱼干商城」链接直接指到这里。 */}
      <h2 className="market-shop__title" id="shop">
        <span className="icon icon-fish" aria-hidden="true" style={{ marginRight: '0.5rem' }}></span>
        鱼干商城
      </h2>
      <ShopPanel userId={user.id} balance={balance} items={shopItems} />

      <p className="market-foot">
        <Link className="market-foot__link" href="/fish/transactions?type=transfer_all">
          <ReceiptText aria-hidden="true" /> 查看转账记录
        </Link>
      </p>

      <p className="market-foot">
        <Link className="market-foot__link" href="/fish/trade">
          <TrendingUp aria-hidden="true" /> 鱼干练手盘（买入 BTC / ETH）
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
