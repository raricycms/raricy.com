import Link from 'next/link';
import { redirect,forbidden } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth';
import { isFocusFishTradeBlocked } from '@/lib/focus-mode';
import { listSettledPositions,settledPositionCount,displaySymbol } from '@/lib/market-service';
import { loginUrlWithNext } from '@/lib/safe-url';
import { fmtFish } from '@/lib/fish-amount';
import { ymdhms } from '@/lib/format';
import SitePager from '@/app/components/SitePager';
import TradeNav from '../TradeNav';
export const dynamic='force-dynamic';
export const metadata={title:'练手盘交易记录',robots:{index:false,follow:false}};
export default async function TradeHistory({searchParams}:{searchParams:Promise<{page?:string}>}){
  const user=await getCurrentUser();if(!user)redirect(loginUrlWithNext('/fish/trade/history'));
  if(isFocusFishTradeBlocked(user))forbidden();
  const sp=await searchParams;const page=Math.max(1,parseInt(sp.page||'1',10)||1);
  const [rows,total]=await Promise.all([listSettledPositions(user.id,20,(page-1)*20),settledPositionCount(user.id)]);
  return <div className="content-wrapper">
    <h1 className="page-title">练手盘交易记录</h1><TradeNav current="history"/>
    <section className="trade-card trade-settled">
      {rows.length?<ul className="trade-settled__list">{rows.map(row=><li className="trade-settled__row" key={row.id} data-position-id={row.id}>
        <span className="trade-settled__name">{displaySymbol(row.symbol)}</span>
        <span>{row.direction==='short'?'做空':'做多'} · {row.leverage}×</span>
        <span className="numeric">投入 {fmtFish(row.stake)}</span>
        <span className="numeric">{row.profit===null?'—':(row.profit>0?'+':'')+fmtFish(row.profit)} · {row.status==='liquidated'?'爆仓':'平仓'}</span>
        <time className="numeric">{ymdhms(row.closedAt)}</time>
      </li>)}</ul>:<p>还没有已结清的交易。</p>}
    </section>
    <SitePager page={page} pages={Math.max(1,Math.ceil(total/20))} href={p=>'/fish/trade/history?page='+p}/>
    <Link href="/fish" className="read-btn">返回账户</Link>
  </div>;
}
