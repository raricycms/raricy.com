import { redirect, forbidden } from 'next/navigation';
import { getCurrentUser,isCoreUser } from '@/lib/auth';
import { loginUrlWithNext } from '@/lib/safe-url';
import { getBalance } from '@/lib/fish-service';
import { listShopItems } from '@/lib/frame-shop-service';
import { listBubbleShopItems } from '@/lib/bubble-shop-service';
import PageHeader from '@/app/components/PageHeader';
import ShopPanel from '../market/ShopPanel';
export const dynamic='force-dynamic';
export const metadata={title:'鱼干商城',robots:{index:false,follow:false}};
export default async function ShopPage({searchParams}:{searchParams:Promise<{category?:string}>}){
  const {category}=await searchParams;
  const selected=category==='frame'||category==='bubble'?category:null;
  const user=await getCurrentUser();
  if(!user) redirect(loginUrlWithNext('/fish/shop'+(selected?'?category='+selected:'')));
  if(!isCoreUser(user)) forbidden();
  const [balance,frames,bubbles]=await Promise.all([getBalance(user.id),listShopItems(user.id),listBubbleShopItems(user.id)]);
  return <div className="content-wrapper fish-page">
    <PageHeader title="鱼干商城" titleId="shop" back={{ href: '/fish', label: '返回账户' }} />
    <ShopPanel userId={user.id} balance={balance} initialCategory={selected??'all'} items={[...frames.map(item=>({...item,kind:'frame' as const})),...bubbles]} />
  </div>;
}
