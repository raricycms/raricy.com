import Link from 'next/link';
import { requireCoreUser } from '@/lib/guard';
import { getTodayQuote } from '@/lib/daily-quote-service';
import QuotePageShell from './QuotePageShell';
import TodayQuote from './TodayQuote';
export const dynamic='force-dynamic';
export const metadata={title:'每日一言',robots:{index:false,follow:false}};
export default async function QuotesPage(){
  const user=await requireCoreUser('/quotes');
  // P02（2026-11-07）：查看今日一言不再要求签到/发文；资格由 requireQuoteParticipant
  // （未归档 core+）判，状态由发行记录决定（P03）。
  const result=await getTodayQuote(user.id);
  // P03：今天的状态由发行记录决定（不再由读者触发选句）——四种状态各有文案。
  let content;
  if(result.state==='published'&&result.quote) content=<TodayQuote initial={result.quote}/>;
  else if(result.state==='failed') content=<div className="daily-quote-state"><p>今日一言发行失败，请稍后刷新重试。</p></div>;
  else if(result.state==='unavailable') content=<div className="daily-quote-state"><p>今日一言已下架。</p></div>;
  else content=<div className="daily-quote-state"><p>今日一言尚未发行，请稍后刷新。</p></div>;
  return <QuotePageShell title="每日一言" current="today">{content}</QuotePageShell>;
}
