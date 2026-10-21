'use client';

import { useId, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { QUOTE_CATEGORIES, QUOTE_CONTENT_MAX, quoteLength } from '@/lib/daily-quote';
import ExpandSelect from './ExpandSelect';

export default function DailyQuoteForm({ onDone }: { onDone?: () => void }) {
  const router = useRouter();
  const id = useId();
  const [content, setContent] = useState('');
  const [sourceType, setSourceType] = useState('original');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const form = new FormData(event.currentTarget);
    setBusy(true); setError('');
    try {
      const response = await fetch('/api/daily-quotes/submissions', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(Object.fromEntries(form)),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || '投稿失败，请稍后重试');
      setDone(true);
      router.refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : '投稿失败'); }
    finally { setBusy(false); }
  }

  if (done) return <div className="daily-quote-form">
    <p role="status">投稿已提交，等待管理员审核。</p>
    <Link href="/checkin/submissions" className="read-btn">查看我的投稿</Link>
    <button type="button" className="daily-quote-primary" onClick={() => { setContent(''); setSourceType('original'); setDone(false); }}>继续投稿</button>
    {onDone && <button type="button" className="daily-quote-primary" onClick={onDone}>返回每日一言</button>}
  </div>;

  return <form className="daily-quote-form" onSubmit={(event) => void submit(event)}>
    <label>一言内容
      <textarea name="content" value={content} onChange={(event) => setContent(event.target.value)}
        required rows={3} aria-describedby="daily-quote-length" />
    </label>
    <p id="daily-quote-length" className="daily-quote-card__hint numeric">{quoteLength(content)} / {QUOTE_CONTENT_MAX} 字</p>
    <div className="daily-quote-form__field"><label htmlFor={`${id}-category`}>类型</label>
      <ExpandSelect id={`${id}-category`} ariaLabel="类型" name="category" defaultValue={QUOTE_CATEGORIES[0]}
        groups={[{ options: QUOTE_CATEGORIES.map((category) => ({ value: category, label: category })) }]} disabled={busy} />
    </div>
    <div className="daily-quote-form__field"><label htmlFor={`${id}-signature`}>署名方式</label>
      <ExpandSelect id={`${id}-signature`} ariaLabel="署名方式" name="signature" defaultValue="nickname"
        groups={[{ options: [{ value: 'nickname', label: '昵称' }, { value: 'anonymous', label: '匿名' }] }]} disabled={busy} />
    </div>
    <div className="daily-quote-form__field"><label htmlFor={`${id}-source`}>来源</label>
      <ExpandSelect id={`${id}-source`} ariaLabel="来源" name="source_type" value={sourceType} onChange={setSourceType}
        groups={[{ options: [{ value: 'original', label: '原创' }, { value: 'quotation', label: '引用' }] }]} disabled={busy} />
    </div>
    {sourceType === 'quotation' && <label>原作者或出处
      <input name="source_name" required maxLength={100} placeholder="原作者、作品名" />
    </label>}
    <p className="daily-quote-card__hint">每天最多投稿5次。通过审核后进入内容池；被拒绝的内容不能再次提交。匿名仅隐藏对其他用户的署名，管理员仍可查看投稿人。</p>
    {error && <p className="daily-quote-error" role="alert">{error}</p>}
    <button type="submit" className="daily-quote-primary" disabled={busy || !content.trim() || quoteLength(content) > QUOTE_CONTENT_MAX}>
      {busy ? '提交中…' : '提交投稿'}
    </button>
  </form>;
}
