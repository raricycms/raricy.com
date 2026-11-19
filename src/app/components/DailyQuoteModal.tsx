'use client';

import { useEffect, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import Link from 'next/link';
import { ArrowLeft, LoaderCircle, PenLine, X } from 'lucide-react';
import type { DailyQuoteView, TodayQuoteState } from '@/lib/daily-quote';
import DailyQuoteCard from './DailyQuoteCard';
import DailyQuoteForm from './DailyQuoteForm';
import { MOTION_MS } from '@/lib/motion';
import { lockPageScroll } from '@/lib/scroll-lock';

// 关闭时卡片滑回视口下方，走形变档 720ms（与 $motion-duration 同值），滑完才真正 close()。
const CLOSE_MS = MOTION_MS;

export default function DailyQuoteModal({ onClose, returnFocus }: { onClose: () => void; returnFocus?: RefObject<HTMLButtonElement | null> }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [opened, setOpened] = useState(false);
  const [closing, setClosing] = useState(false);
  const closingRef = useRef(false);
  const closeTimer = useRef<number | null>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const releaseScroll = useRef<(() => void) | null>(null);
  const [submission, setSubmission] = useState(false);
  const [result, setResult] = useState<{ day: string; state: TodayQuoteState; quote: DailyQuoteView | null; can_submit: boolean } | null>(null);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const element = dialog.current;
    previousFocus.current = document.activeElement as HTMLElement | null;
    // 锁滚动要连滚动条宽度一起补（见 lib/scroll-lock）：只写 overflow: hidden 的话，
    // 桌面上滚动条一消失，整页会右移半个滚动条，打开弹窗那一下就是「页面抖几像素」。
    releaseScroll.current = lockPageScroll();
    element?.showModal();
    // 第一帧保持透明的初始态，下一帧再加 is-open —— 否则浏览器会把两帧合并成一次跳变。
    const frame = requestAnimationFrame(() => setOpened(true));
    return () => {
      cancelAnimationFrame(frame);
      if (closeTimer.current !== null) { window.clearTimeout(closeTimer.current); closeTimer.current = null; }
      if (element?.open) element.close();
      releaseScroll.current?.();
      releaseScroll.current = null;
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
        if (!response.ok) {
          throw new Error(data.message || '一言加载失败');
        }
        setResult({ day: data.day, state: data.state, quote: data.quote, can_submit: data.can_submit });
      }).catch((cause) => {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : '一言加载失败');
      });
    return () => controller.abort();
  }, [attempt]);

  function finishClose() {
    if (closeTimer.current !== null) { window.clearTimeout(closeTimer.current); closeTimer.current = null; }
    const element = dialog.current;
    if (element?.open) element.close();
    releaseScroll.current?.();
    releaseScroll.current = null;
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
    // 立刻退出原生模态：只要还挂着 showModal，整页都是 inert，点击与滚动全部由弹窗
    // 接管 —— 退场那 720ms 会变成「点了关闭却动不了网站」。关掉之后卡片继续按
    // .is-closing 播完退场（那条规则自己把 display 与定位补回来），页面当场可用。
    // 顺序要紧：先把 .is-closing 挂上（此时 display 仍是 open 的那一份），再 close()。
    // 反过来做会先掉进 display: none，元素重新出现时没有过渡的起点，位移会直接跳到终点。
    const element = dialog.current;
    if (element) {
      element.classList.add('is-closing');
      if (element.open) element.close();
    }
    // 先 close() 再还原滚动锁：两件事在同一帧发生，滚动条与内距一起回来，宽度不变。
    releaseScroll.current?.();
    releaseScroll.current = null;
    setClosing(true);
    closeTimer.current = window.setTimeout(finishClose, CLOSE_MS);
  }

  const stageKey = submission ? 'form'
    : error ? `error-${attempt}`
      : result ? (result.quote ? `quote-${result.quote.id}` : `empty-${result.state}`)
        : 'loading';
  // P03：空态按发行状态区分（尚未发行 / 发行失败 / 内容下架），不能再一律说「已下架」。
  const emptyText = result?.state === 'failed'
    ? '今日一言发行失败，请稍后重试。'
    : result?.state === 'unavailable'
      ? '今日一言已下架。'
      : '今日一言尚未发行，请稍后刷新。';

  return createPortal(<>
    {/* 遮罩自己画：`<dialog>` 关掉之后 ::backdrop 就没了，而卡片还要播完退场。
        这一层同时承担开场的淡入与退场的淡出，指针事件始终不接（点击一律由对话框接住）。 */}
    <div
      className={`daily-quote-scrim${opened ? ' is-open' : ''}${closing ? ' is-closing' : ''}`}
      aria-hidden="true"
    />
    <dialog ref={dialog} className={`daily-quote-dialog${opened ? ' is-open' : ''}${closing ? ' is-closing' : ''}`}
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
          <DailyQuoteCard key={result.quote.id} quote={result.quote}
            onChange={(quote) => setResult((current) => (current ? { ...current, quote } : current))} />
        ) : (
          <div className="daily-quote-state"><p>{emptyText}</p></div>
        ) : (
          <div className="daily-quote-state daily-quote-state--loading" role="status">
            <LoaderCircle className="daily-quote-spin" size={22} aria-hidden="true" />
            <p>正在打开今日一言…</p>
          </div>
        )}
      </div>

      <footer className="daily-quote-dialog__footer">
        {/* 「我的投稿」不再放这里：投稿成功态（DailyQuoteForm 的完成区）已经有入口，
            三个相关页面也由 DailyQuoteNav 统一交代 —— 弹窗底栏只留「去别处看」的两项。 */}
        <nav className="daily-quote-dialog__links" aria-label="每日一言相关">
          <Link href="/quotes">每日一言</Link><Link href="/quotes/history">往期一言</Link>
        </nav>
        {/* 投稿模式与阅读模式共用这一颗按钮：文案与图标换，位置、焦点与外壳不变。 */}
        <button type="button" className="daily-quote-dialog__mode" disabled={result?.can_submit === false} onClick={() => setSubmission((value) => !value)}>
          {submission ? <><ArrowLeft size={18} aria-hidden="true" />返回每日一言</>
            : <><PenLine size={18} aria-hidden="true" />我也要投稿</>}
        </button>
      </footer>
    </div>
  </dialog></>, document.body);
}
