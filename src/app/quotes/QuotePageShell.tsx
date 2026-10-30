import Link from 'next/link';
import type { ReactNode } from 'react';
import DailyQuoteNav, { type DailyQuoteNavKey } from '@/app/components/DailyQuoteNav';
export default function QuotePageShell({title,current,children}:{title:string;current:DailyQuoteNavKey;children:ReactNode}){
  return <div className="container daily-quote-page">
    <header className="daily-quote-page__header"><h1>{title}</h1><Link className="read-btn" href={current==='today'?'/checkin':'/quotes'}>{current==='today'?'返回签到':'每日一言'}</Link></header>
    <DailyQuoteNav current={current}/>{children}
  </div>;
}
