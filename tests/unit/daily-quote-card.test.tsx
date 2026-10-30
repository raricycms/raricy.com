// @vitest-environment jsdom
import { describe,it,expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import DailyQuoteCard from '@/app/components/DailyQuoteCard';
import type { DailyQuoteView } from '@/lib/daily-quote';
const quote:DailyQuoteView={id:'q',content:'一言正文',category:'哲思',kind:'builtin',author:'作者',source_type:'quotation',source_name:'作品',source_url:null,submitter_name:null,resonance_count:1,resonated:false,favorited:false,resonance_fish:0,can_resonate:true,can_favorite:true,resonance_unavailable:null};
describe('一言操作信息',()=>{
  it('免费常态不强调规则，付费在操作旁明确标价',()=>{
    const free=renderToStaticMarkup(<DailyQuoteCard quote={quote}/>);
    expect(free).not.toMatch(/免费|每人每句|限一次/);
    const paid=renderToStaticMarkup(<DailyQuoteCard quote={{...quote,kind:'community',resonance_fish:1}}/>);
    expect(paid).toContain('投喂 1 条鱼干');
  });
  it('已经共鸣只呈现完成和禁用状态，不重复显示价格',()=>{
    const html=renderToStaticMarkup(<DailyQuoteCard quote={{...quote,resonated:true,can_resonate:false,resonance_fish:1}}/>);
    const body=document.createElement('div');body.innerHTML=html;
    const action=body.querySelector('[aria-label="已共鸣"]') as HTMLButtonElement;
    expect(action.disabled).toBe(true);expect(action.getAttribute('aria-pressed')).toBe('true');
    expect(body.textContent).not.toContain('投喂 1');
  });
});
