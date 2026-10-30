'use client';
import { useEffect,useState } from 'react';
import type { DailyQuoteView } from '@/lib/daily-quote';
import DailyQuoteCard from '@/app/components/DailyQuoteCard';
export default function TodayQuote({initial}:{initial:DailyQuoteView}){
  const [quote,setQuote]=useState(initial);
  useEffect(()=>setQuote(initial),[initial]);
  return <DailyQuoteCard quote={quote} onChange={setQuote}/>;
}
