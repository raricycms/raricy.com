'use client';
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
export default function MarketLegacyLink(){
  const router=useRouter();
  useEffect(()=>{if(window.location.hash==='#shop')router.replace('/fish/shop#shop');},[router]);
  return null;
}
