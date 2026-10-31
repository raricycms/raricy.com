import { ArrowLeftRight, ShoppingBag } from 'lucide-react';
import PageHeader from '@/app/components/PageHeader';
import FishEntry from '../FishEntry';
import MarketLegacyLink from './MarketLegacyLink';
export const dynamic='force-dynamic';
/** 旧页含两个任务；hash 不到服务端，保留选择壳并在客户端识别旧商品锚点。 */
export default async function LegacyMarketPage(){
  return <div className="content-wrapper fish-page">
    <PageHeader title="小鱼干" back={{ href: '/fish', label: '返回账户' }} />
    <MarketLegacyLink />
    <nav className="fish-more fish-more--narrow" aria-label="小鱼干操作">
      <ul className="fish-more__list">
        <li><FishEntry slug="transfer" href="/fish/transfer" icon={<ArrowLeftRight />} name="转账" desc="向其他成员转出小鱼干" /></li>
        <li><FishEntry slug="shop" href="/fish/shop" icon={<ShoppingBag />} name="商城" desc="租用头像框与聊天气泡" /></li>
      </ul>
    </nav>
  </div>;
}
