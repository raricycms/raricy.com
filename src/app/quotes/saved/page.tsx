import Link from 'next/link';
import { requireCoreUser } from '@/lib/guard';
import { listSavedQuotes } from '@/lib/daily-quote-service';
import SitePager from '@/app/components/SitePager';
import SavedQuotes from '@/app/favorite/quotes/SavedQuotes';
import QuotePageShell from '../QuotePageShell';
export const dynamic='force-dynamic';
// P02（2026-11-07）：收藏列表不再要求「发布过文章」；资格由 listSavedQuotes 内部判。
export default async function SavedPage({searchParams}:{searchParams:Promise<{page?:string}>}){
  const {page}=await searchParams;
  const user=await requireCoreUser('/quotes/saved'+(page?'?page='+encodeURIComponent(page):''));
  const result=await listSavedQuotes(user.id,Number(page??1));
  return <QuotePageShell title="我的收藏" current="saved">
    <p className="daily-quote-page__note">私密 · {result.total} 条</p>
    {result.total?<SavedQuotes rows={result.quotes}/>:<div className="daily-quote-state"><p>还没有收藏的一言。</p><Link href="/quotes/history" className="read-btn">看看往期一言</Link></div>}
    <SitePager page={result.page} pages={result.pages} href={p=>'/quotes/saved?page='+p}/>
  </QuotePageShell>;
}
