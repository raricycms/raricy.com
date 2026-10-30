'use client';

import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { CircleCheck, LoaderCircle } from 'lucide-react';
import { QUOTE_CATEGORIES, QUOTE_CONTENT_MAX, quoteLength, type QuoteSubmissionDraft } from '@/lib/daily-quote';
import QuoteBlogRequired from './QuoteBlogRequired';
import ExpandSelect from './ExpandSelect';

export default function DailyQuoteForm({ submission, onSaved, onCancel }: {
  submission?: QuoteSubmissionDraft;
  onSaved?: () => void;
  onCancel?: () => void;
}) {
  const router = useRouter();
  const id = useId();
  const textarea = useRef<HTMLTextAreaElement>(null);
  const doneBox = useRef<HTMLDivElement>(null);
  const focusForm = useRef(false);
  const [content, setContent] = useState(submission?.content ?? '');
  const [signature, setSignature] = useState(submission?.signature ?? 'nickname');
  const [sourceType, setSourceType] = useState(submission?.source_type ?? 'original');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [blogRequired, setBlogRequired] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (submission) textarea.current?.focus();
  }, [submission?.id]);

  useEffect(() => {
    if (done) { doneBox.current?.focus(); return; }
    if (focusForm.current) { focusForm.current = false; textarea.current?.focus(); }
  }, [done]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const form = new FormData(event.currentTarget);
    setBusy(true); setError('');
    try {
      const response = await fetch(submission
        ? `/api/daily-quotes/submissions/${encodeURIComponent(submission.id)}` : '/api/daily-quotes/submissions', {
        method: submission ? 'PATCH' : 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...Object.fromEntries(form), ...(submission ? { version: submission.version } : {}) }),
      });
      const data = await response.json();
      if (!response.ok) {
        if (data.reason === 'BLOG_REQUIRED') setBlogRequired(true);
        throw new Error(data.message || '保存失败，请稍后重试');
      }
      if (submission) onSaved?.();
      else setDone(true);
      router.refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : '投稿失败'); }
    finally { setBusy(false); }
  }

  function again() {
    focusForm.current = true;
    setContent('');
    setSourceType('original');
    setSignature('nickname');
    setError('');
    setDone(false);
  }

  if (blogRequired) return <QuoteBlogRequired embedded />;
  if (done) return <div className="daily-quote-form">
    <div ref={doneBox} tabIndex={-1} className="daily-quote-form__done">
      <CircleCheck size={30} aria-hidden="true" />
      <p role="status">投稿已提交，等待管理员审核。</p>
    </div>
    <div className="daily-quote-form__done-actions">
      <Link href="/quotes/submissions" className="read-btn">查看我的投稿</Link>
      <button type="button" className="daily-quote-secondary" onClick={again}>继续投稿</button>
    </div>
  </div>;

  const length = quoteLength(content);
  const tooLong = length > QUOTE_CONTENT_MAX;
  const quoting = sourceType === 'quotation';

  return <form className={`daily-quote-form${submission ? ' daily-quote-form--edit' : ''}`} aria-label={submission ? '编辑一言投稿' : '提交一言'} onSubmit={(event) => void submit(event)}>
    <div className="daily-quote-form__field">
      <label htmlFor={`${id}-content`}>一言内容</label>
      <textarea ref={textarea} id={`${id}-content`} name="content" value={content}
        onChange={(event) => setContent(event.target.value)}
        required rows={3} disabled={busy} aria-describedby={length >= QUOTE_CONTENT_MAX * 0.8 ? `${id}-length` : undefined} />
      {length >= QUOTE_CONTENT_MAX * 0.8 && <p id={`${id}-length`} className={`daily-quote-form__counter numeric${tooLong ? ' is-over' : ''}`}>
        {length} / {QUOTE_CONTENT_MAX} 字
      </p>}
    </div>
    <div className="daily-quote-form__row">
      <div className="daily-quote-form__field"><label htmlFor={`${id}-category`}>类型</label>
        <ExpandSelect id={`${id}-category`} ariaLabel="类型" name="category" defaultValue={submission?.category ?? QUOTE_CATEGORIES[0]}
          groups={[{ options: QUOTE_CATEGORIES.map((category) => ({ value: category, label: category })) }]} disabled={busy} />
      </div>
      <div className="daily-quote-form__field"><label htmlFor={`${id}-signature`}>署名方式</label>
        <ExpandSelect id={`${id}-signature`} ariaLabel="署名方式" name="signature" value={signature} onChange={value => setSignature(value as 'nickname' | 'anonymous')}
          groups={[{ options: [{ value: 'nickname', label: '昵称' }, { value: 'anonymous', label: '匿名' }] }]} disabled={busy} />
      </div>
    </div>
    <div className="daily-quote-form__field"><label htmlFor={`${id}-source`}>来源</label>
      <ExpandSelect id={`${id}-source`} ariaLabel="来源" name="source_type" value={sourceType} onChange={setSourceType}
        groups={[{ options: [{ value: 'original', label: '原创' }, { value: 'quotation', label: '引用' }] }]} disabled={busy} />
      {/* 出处字段不卸载：外壳按内容高度展开，收起时退出焦点与表单数据。 */}
      <div className={`daily-quote-form__reveal${quoting ? ' is-open' : ''}`} inert={!quoting}>
        <div className="daily-quote-form__reveal-clip">
          <label htmlFor={`${id}-source-name`}>原作者或出处</label>
          <input id={`${id}-source-name`} name="source_name" maxLength={100} placeholder="原作者、作品名"
            defaultValue={submission?.source_name ?? ''} disabled={!quoting || busy} required={quoting} />
        </div>
      </div>
    </div>
    {signature === 'anonymous' && <p className="daily-quote-form__hint">对读者匿名，管理员仍可查看投稿人。</p>}
    {submission && <p className="daily-quote-form__hint">保存后重新审核，旧稿与审核意见保留。</p>}
    {error && <p className="daily-quote-error" role="alert">{error}</p>}
    <button type="submit" className="daily-quote-primary daily-quote-form__submit" disabled={busy || !content.trim() || tooLong} aria-busy={busy}>
      {busy ? <><LoaderCircle className="daily-quote-spin" size={18} aria-hidden="true" />保存中…</>
        : submission ? submission.status === 'rejected' ? '修改并重新提交' : '保存修改' : '提交投稿'}
    </button>
    {onCancel && <button type="button" className="daily-quote-secondary" disabled={busy} onClick={onCancel}>取消编辑</button>}
  </form>;
}
