import { requireCoreUser } from '@/lib/guard';
import { listQuoteHistory } from '@/lib/daily-quote-service';
import SitePager from '@/app/components/SitePager';
import QuoteHistory from '@/app/checkin/quotes/QuoteHistory';
import QuotePageShell from '../QuotePageShell';
export const dynamic='force-dynamic';
// P02（2026-11-07）：往期一言不再要求「发布过文章」，资格由 listQuoteHistory 内部的
// requireQuoteParticipant（未归档 core+）判；页面只负责渲染结果。
export default async function HistoryPage({searchParams}:{searchParams:Promise<{page?:string}>}){
  const {page}=await searchParams;
  const user=await requireCoreUser('/quotes/history'+(page?'?page='+encodeURIComponent(page):''));
  const result=await listQuoteHistory(user.id,Number(page??1));
  return <QuotePageShell title="往期一言" current="history">
    {result.total?<QuoteHistory entries={result.editions}/>:<div className="daily-quote-state"><p>还没有往期一言。</p></div>}
    {result&&<SitePager page={result.page} pages={result.pages} href={p=>'/quotes/history?page='+p}/>}
  </QuotePageShell>;
}
