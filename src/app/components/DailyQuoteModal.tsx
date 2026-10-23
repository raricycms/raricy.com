'use client';

import { useEffect, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import Link from 'next/link';
import { ArrowLeft, LoaderCircle, PenLine, X } from 'lucide-react';
import type { DailyQuoteView } from '@/lib/daily-quote';
import DailyQuoteCard from './DailyQuoteCard';
import DailyQuoteForm from './DailyQuoteForm';

// 与 abstracts/_variables.scss 的 $motion-collapse-duration 同值：关闭时内容先退（150ms），
// 外壳与遮罩随后收（220ms），收完才真正 close()。
const CLOSE_MS = 220;

export default function DailyQuoteModal({ onClose, returnFocus }: { onClose: () => void; returnFocus?: RefObject<HTMLButtonElement | null> }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [opened, setOpened] = useState(false);
  const [closing, setClosing] = useState(false);
  const closingRef = useRef(false);
  const closeTimer = useRef<number | null>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const previousOverflow = useRef('');
  const [submission, setSubmission] = useState(false);
  const [result, setResult] = useState<{ day: string; quote: DailyQuoteView | null } | null>(null);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const element = dialog.current;
    previousFocus.current = document.activeElement as HTMLElement | null;
    previousOverflow.current = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    element?.showModal();
    // 第一帧保持透明的初始态，下一帧再加 is-open —— 否则浏览器会把两帧合并成一次跳变。
    const frame = requestAnimationFrame(() => setOpened(true));
    return () => {
      cancelAnimationFrame(frame);
      if (closeTimer.current !== null) { window.clearTimeout(closeTimer.current); closeTimer.current = null; }
      if (element?.open) element.close();
      document.body.style.overflow = previousOverflow.current;
      const target = returnFocus?.current ?? previousFocus.current;
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

  function finishClose() {
    if (closeTimer.current !== null) { window.clearTimeout(closeTimer.current); closeTimer.current = null; }
    const element = dialog.current;
    if (element?.open) element.close();
    document.body.style.overflow = previousOverflow.current;
    const target = returnFocus?.current ?? previousFocus.current;
    if (target?.isConnected) target.focus();
    onCloseRef.current();
  }

  function requestClose() {
    if (closingRef.current) return;
    closingRef.current = true;
    // 减少动态效果时直接到位；功能与焦点恢复都不依赖动画结束事件。
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      finishClose();
      return;
    }
    setClosing(true);
    closeTimer.current = window.setTimeout(finishClose, CLOSE_MS);
  }

  const stageKey = submission ? 'form'
    : error ? `error-${attempt}`
      : result ? (result.quote ? `quote-${result.quote.id}` : 'empty')
        : 'loading';

  return createPortal(<dialog ref={dialog} className={`daily-quote-dialog${opened ? ' is-open' : ''}${closing ? ' is-closing' : ''}`}
    aria-labelledby="daily-quote-title"
    onCancel={(event) => { event.preventDefault(); requestClose(); }}
    onClick={(event) => { if (event.target === event.currentTarget) requestClose(); }}>
    <div className="daily-quote-dialog__body" inert={closing}>
      <header className="daily-quote-dialog__header">
        <div className="daily-quote-dialog__heading">
          <h2 key={submission ? 'form' : 'quote'} id="daily-quote-title">{submission ? '我也要投稿' : '每日一言'}</h2>
          {/* 日期槽常驻：占位 → 正片只换文字，标题区高度不跟着跳。 */}
          <p className="daily-quote-dialog__day numeric">
            {!submission && result && <span key={result.day}>{result.day}</span>}
          </p>
        </div>
        <button type="button" className="daily-quote-icon" onClick={requestClose} aria-label="关闭每日一言" autoFocus><X size={22} aria-hidden="true" /></button>
      </header>

      <div className="daily-quote-dialog__stage" key={stageKey}>
        {submission ? <DailyQuoteForm /> : error ? (
          <div className="daily-quote-state">
            <p className="daily-quote-error" role="alert">{error}</p>
            <button type="button" className="daily-quote-secondary" onClick={() => setAttempt((value) => value + 1)}>重新加载</button>
          </div>
        ) : result ? result.quote ? (
          <DailyQuoteCard key={result.quote.id} initialQuote={result.quote}
            onChange={(quote) => setResult((current) => (current ? { ...current, quote } : current))} />
        ) : (
          <div className="daily-quote-state"><p>今日一言已下架。</p></div>
        ) : (
          <div className="daily-quote-state daily-quote-state--loading" role="status">
            <LoaderCircle className="daily-quote-spin" size={22} aria-hidden="true" />
            <p>正在打开今日一言…</p>
          </div>
        )}
      </div>

      <footer className="daily-quote-dialog__footer">
        <nav className="daily-quote-dialog__links" aria-label="每日一言相关">
          <Link href="/favorite/quotes">一言集</Link><Link href="/checkin/submissions">我的投稿</Link>
        </nav>
        {/* 投稿模式与阅读模式共用这一颗按钮：文案与图标换，位置、焦点与外壳不变。 */}
        <button type="button" className="daily-quote-dialog__mode" onClick={() => setSubmission((value) => !value)}>
          {submission ? <><ArrowLeft size={18} aria-hidden="true" />返回每日一言</>
            : <><PenLine size={18} aria-hidden="true" />我也要投稿</>}
        </button>
      </footer>
    </div>
  </dialog>, document.body);
}
