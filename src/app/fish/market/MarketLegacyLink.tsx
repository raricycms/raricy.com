'use client';
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
export default function MarketLegacyLink(){
  const router=useRouter();
  useEffect(()=>{
    const redirectShop=()=>{if(window.location.hash==='#shop')router.replace('/fish/shop#shop');};
    redirectShop();
    // 同页补上旧锚点不会重新挂载组件，前进/后退也需要重新识别。
    window.addEventListener('hashchange',redirectShop);
    return()=>window.removeEventListener('hashchange',redirectShop);
  },[router]);
  return null;
}
