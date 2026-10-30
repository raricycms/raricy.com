import Link from 'next/link';
const items=[['trade','/fish/trade','行情与持仓'],['history','/fish/trade/history','交易记录'],['stats','/fish/trade/stats','统计']] as const;
export default function TradeNav({current}:{current:'trade'|'history'|'stats'}){
  return <nav className="fish-filter-bar" aria-label="练手盘">{items.map(([key,href,label])=>key===current?<span key={key} className="filter-btn active" aria-current="page">{label}</span>:<Link className="filter-btn" key={key} href={href}>{label}</Link>)}</nav>;
}
