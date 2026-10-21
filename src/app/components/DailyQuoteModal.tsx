'use client';

import { useEffect, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import Link from 'next/link';
import { X, ArrowLeft } from 'lucide-react';
import type { DailyQuoteView } from '@/lib/daily-quote';
import DailyQuoteCard from './DailyQuoteCard';
import DailyQuoteForm from './DailyQuoteForm';

export default function DailyQuoteModal({ onClose, returnFocus }: { onClose: () => void; returnFocus?: RefObject<HTMLButtonElement | null> }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [submission, setSubmission] = useState(false);
  const [result, setResult] = useState<{ day: string; quote: DailyQuoteView | null } | null>(null);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const element = dialog.current;
    const previousFocus = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    element?.showModal();
    return () => {
      element?.close(); document.body.style.overflow = previousOverflow;
      const target = returnFocus?.current ?? previousFocus;
      if (target?.isConnected) target.focus();
    };
  }, [returnFocus]);

  useEffect(() => {
    const controller = new AbortController();
    setError('');
    void fetch('/api/daily-quotes/today', { signal: controller.signal, cache: 'no-store' })
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok) throw new Error(data.message || '一言加载失败');
        setResult({ day: data.day, quote: data.quote });
      }).catch((cause) => {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : '一言加载失败');
      });
    return () => controller.abort();
  }, [attempt]);

  return createPortal(<dialog ref={dialog} className="daily-quote-dialog" aria-labelledby="daily-quote-title"
    onCancel={(event) => { event.preventDefault(); onClose(); }}
    onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="daily-quote-dialog__body">
      <header className="daily-quote-dialog__header">
        {submission && <button type="button" className="daily-quote-icon" onClick={() => setSubmission(false)} aria-label="返回每日一言"><ArrowLeft size={20} /></button>}
        <div><h2 id="daily-quote-title">{submission ? '我也要投稿' : '每日一言'}</h2>
          {!submission && result && <p className="daily-quote-card__hint numeric">{result.day}</p>}</div>
        <button type="button" className="daily-quote-icon" onClick={onClose} aria-label="关闭每日一言" autoFocus><X size={22} /></button>
      </header>
      {submission ? <DailyQuoteForm onDone={() => setSubmission(false)} /> : <>
        {error ? <div><p className="daily-quote-error" role="alert">{error}</p>
          <button type="button" className="daily-quote-primary" onClick={() => setAttempt((value) => value + 1)}>重新加载</button></div>
          : result ? result.quote
            ? <DailyQuoteCard key={result.quote.id} initialQuote={result.quote} onSubmit={() => setSubmission(true)} />
            : <p>今日一言已下架。</p>
          : <p role="status">正在打开今日一言…</p>}
        <nav className="daily-quote-dialog__links" aria-label="每日一言相关">
          <Link href="/favorite/quotes">一言集</Link><Link href="/checkin/submissions">我的投稿</Link>
          {result && !result.quote && <button type="button" className="daily-quote-icon" onClick={() => setSubmission(true)}>我也要投稿</button>}
        </nav>
      </>}
    </div>
  </dialog>, document.body);
}
