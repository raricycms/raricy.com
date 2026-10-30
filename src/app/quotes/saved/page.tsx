import Link from 'next/link';
import { requireCoreUser } from '@/lib/guard';
import { hasPublishedBlog } from '@/lib/checkin-service';
import { listSavedQuotes } from '@/lib/daily-quote-service';
import QuoteBlogRequired from '@/app/components/QuoteBlogRequired';
import SitePager from '@/app/components/SitePager';
import SavedQuotes from '@/app/favorite/quotes/SavedQuotes';
import QuotePageShell from '../QuotePageShell';
export const dynamic='force-dynamic';
export default async function SavedPage({searchParams}:{searchParams:Promise<{page?:string}>}){
  const {page}=await searchParams;
  const user=await requireCoreUser('/quotes/saved'+(page?'?page='+encodeURIComponent(page):''));
  const allowed=await hasPublishedBlog(user.id);
  const result=allowed?await listSavedQuotes(user.id,Number(page??1)):null;
  return <QuotePageShell title="我的收藏" current="saved">
    {!allowed?<QuoteBlogRequired embedded/>:<><p className="daily-quote-page__note">私密 · {result?.total??0} 条</p>
      {result?.total?<SavedQuotes rows={result.quotes}/>:<div className="daily-quote-state"><p>还没有收藏的一言。</p><Link href="/quotes/history" className="read-btn">看看往期一言</Link></div>}</>}
    {result&&<SitePager page={result.page} pages={result.pages} href={p=>'/quotes/saved?page='+p}/>}
  </QuotePageShell>;
}
