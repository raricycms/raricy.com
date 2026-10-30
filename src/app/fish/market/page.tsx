import Link from 'next/link';
import MarketLegacyLink from './MarketLegacyLink';
export const dynamic='force-dynamic';
/** 旧页含两个任务；hash 不到服务端，保留选择壳并在客户端识别旧商品锚点。 */
export default async function LegacyMarketPage(){
  return <div className="content-wrapper"><h1 className="page-title">小鱼干</h1>
    <MarketLegacyLink />
    <nav className="fish-card__actions" aria-label="小鱼干操作">
      <Link className="button button-primary" href="/fish/transfer">转账</Link>
      <Link className="button button-secondary" href="/fish/shop">商城</Link>
    </nav>
  </div>;
}
