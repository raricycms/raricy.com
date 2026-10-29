import Link from 'next/link';
import { QUOTE_BLOG_REQUIRED, QUOTE_INTRO_HREF } from '@/lib/daily-quote';

/** 页面与请求中途失去博客资格的弹窗 / 表单共用，保持同一条前置说明与行动入口。 */
export default function QuoteBlogRequired({ embedded = false }: { embedded?: boolean }) {
  const content = <>
      <p>{QUOTE_BLOG_REQUIRED}</p>
      <div className="daily-quote-card__actions">
        <Link href={QUOTE_INTRO_HREF} className="read-btn">看看大家的「自我介绍」</Link>
        <Link href="/blog/upload" className="read-btn">发表博客</Link>
      </div>
  </>;
  return embedded ? <div className="daily-quote-state">{content}</div> :
    <div className="container daily-quote-page"><section className="daily-quote-panel"><h1>请先发表博客</h1>{content}</section></div>;
}
