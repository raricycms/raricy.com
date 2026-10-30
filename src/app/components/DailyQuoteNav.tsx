import Link from 'next/link';
const ITEMS=[
  {key:'today',href:'/quotes',label:'今日'},
  {key:'history',href:'/quotes/history',label:'往期一言'},
  {key:'saved',href:'/quotes/saved',label:'我的收藏'},
  {key:'submissions',href:'/quotes/submissions',label:'我的投稿'},
] as const;
export type DailyQuoteNavKey=(typeof ITEMS)[number]['key'];
export default function DailyQuoteNav({current}:{current?:DailyQuoteNavKey}){
  return <nav className="daily-quote-nav" aria-label="每日一言">{ITEMS.map(item=>item.key===current
    ?<span key={item.key} className="daily-quote-nav__item is-active" aria-current="page">{item.label}</span>
    :<Link key={item.key} href={item.href} className="daily-quote-nav__item">{item.label}</Link>)}</nav>;
}
