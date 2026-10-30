import Link from 'next/link';
import { redirect, forbidden } from 'next/navigation';
import { getCurrentUser,isCoreUser } from '@/lib/auth';
import { loginUrlWithNext } from '@/lib/safe-url';
import { getBalance } from '@/lib/fish-service';
import { listShopItems } from '@/lib/frame-shop-service';
import { listBubbleShopItems } from '@/lib/bubble-shop-service';
import ShopPanel from '../market/ShopPanel';
export const dynamic='force-dynamic';
export const metadata={title:'鱼干商城',robots:{index:false,follow:false}};
export default async function ShopPage({searchParams}:{searchParams:Promise<{category?:string}>}){
  const user=await getCurrentUser();
  if(!user) redirect(loginUrlWithNext('/fish/shop'));
  if(!isCoreUser(user)) forbidden();
  const {category}=await searchParams;
  const [balance,frames,bubbles]=await Promise.all([getBalance(user.id),listShopItems(user.id),listBubbleShopItems(user.id)]);
  return <div className="content-wrapper">
    <h1 className="page-title" id="shop">鱼干商城</h1>
    <ShopPanel userId={user.id} balance={balance} initialCategory={category==='frame'||category==='bubble'?category:'all'} items={[...frames.map(item=>({...item,kind:'frame' as const})),...bubbles]} />
    <p className="market-foot"><Link className="market-foot__link" href="/fish">返回账户</Link></p>
  </div>;
}
