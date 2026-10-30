'use client';

import { useState } from 'react';
import { Heart, LoaderCircle, Star } from 'lucide-react';
import type { DailyQuoteResonanceResult, DailyQuoteView } from '@/lib/daily-quote';
import QuoteBlogRequired from './QuoteBlogRequired';

/**
 * 一条一言的展示与互动。
 *
 * 【受控组件】`quote` 由调用方持有，这里只通过 `onChange` 发回变更 —— 往期列表里
 * 同一句话可能有两个入选日期，两处卡片必须共享同一份状态；一言集的取消最后一条
 * 也要让页面自己决定刷新。旧版把 `initialQuote` 塞进 `useState` 只吃首次值，
 * 同页重复入选的句子会各亮各的。
 *
 * 【两种展示模式】
 * - `today`：签到弹窗里的阅读形态，正文一档字号 + 引文内容底色，保留完整费用说明。
 * - `list`：往期 / 一言集列表的紧凑条目，单层卡片底色，正文直接排在卡内；日期、
 *   类别与来源降为辅助层，费用贴着操作行给出，不常驻空反馈行。
 *
 * 【共鸣人数只认服务端】响应是 `DailyQuoteResonanceResult`：两个标签页都点过、
 * 或服务端因累计资格判定为幂等重放时，本地 `resonance_count + 1` 是错的。
 */
export default function DailyQuoteCard({
  quote,
  mode = 'today',
  dateLabel,
  dateHint,
  onRemoved,
  onChange,
}: {
  quote: DailyQuoteView;
  mode?: 'today' | 'list';
  /** 往期为选登日，一言集为收藏时间；首次选登日可放在 dateHint。 */
  dateLabel?: string;
  /** 日期的补充说明，需要时才给（例如「不是收藏时间」）。 */
  dateHint?: string;
  onRemoved?: () => void;
  onChange?: (quote: DailyQuoteView) => void;
}) {
  const [pending, setPending] = useState<'resonance' | 'favorite' | null>(null);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [blogRequired, setBlogRequired] = useState(false);

  const listMode = mode === 'list';

  async function action(kind: 'resonance' | 'favorite') {
    if (pending) return;
    setPending(kind);
    setError('');
    setMessage('');
    try {
      const removing = kind === 'favorite' && quote.favorited;
      const response = await fetch(`/api/daily-quotes/${encodeURIComponent(quote.id)}/${kind}`, {
        method: removing ? 'DELETE' : 'POST',
        ...(kind === 'resonance' ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ max_fish: quote.resonance_fish }) } : {}),
      });
      const data = await response.json();
      if (!response.ok) {
        if (data.reason === 'BLOG_REQUIRED') setBlogRequired(true);
        if (data.reason === 'FEE_CHANGED') onChange?.({ ...quote, resonance_fish: data.resonance_fish });
        throw new Error(data.message || '操作失败，请稍后重试');
      }
      if (kind === 'resonance') {
        const result = data as DailyQuoteResonanceResult;
        onChange?.({
          ...quote,
          resonated: result.resonated,
          can_resonate: result.can_resonate,
          resonance_count: result.resonance_count,
          resonance_unavailable: result.resonance_unavailable,
        });
        setMessage(
          result.already_resonated
            ? '已共鸣'
            : result.charged_fish
              ? '已共鸣，已向投稿人投喂 1 条鱼干'
              : '已共鸣'
        );
      } else {
        onChange?.({ ...quote, favorited: !removing });
        setMessage(removing ? '已取消收藏' : '已收藏');
        if (removing) onRemoved?.();
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '操作失败');
    } finally {
      setPending(null);
    }
  }

  const fee = quote.resonance_fish ? `投喂 ${quote.resonance_fish} 条鱼干` : '';
  const hint = !quote.resonated && !quote.can_resonate ? quote.resonance_unavailable : null;
  const note = error || message;

  const meta = (
    <div className="daily-quote-card__meta">
      {dateLabel && <span className="daily-quote-card__date numeric">{dateLabel}</span>}
      <span className="daily-quote-card__category">{quote.category}</span>
      <span>{quote.kind === 'builtin' ? '经典语录' : '站友投稿'}</span>
      {dateHint && <span className="daily-quote-card__date-hint">{dateHint}</span>}
    </div>
  );

  const byline = (
    <p className="daily-quote-card__byline">
      <span className="daily-quote-card__author">
        {quote.kind === 'community' ? `${quote.author} 投稿` : quote.author}
      </span>
      <span className="daily-quote-card__source">
        {quote.source_type === 'original' ? (
          '原创'
        ) : (
          <>
            引用自：
            {quote.source_url ? (
              <a href={quote.source_url} target="_blank" rel="noreferrer">
                {quote.source_name}
              </a>
            ) : (
              quote.source_name
            )}
          </>
        )}
      </span>
    </p>
  );

  const actions = (
    <div className="daily-quote-card__actions">
      <button
        type="button"
        className={`daily-quote-card__action${quote.resonated ? ' is-active' : ''}`}
        onClick={() => void action('resonance')}
        disabled={pending !== null || !quote.can_resonate}
        aria-busy={pending === 'resonance'}
        aria-pressed={quote.resonated}
        aria-label={quote.resonated ? '已共鸣' : fee ? `共鸣，${fee}` : '共鸣'}
      >
        {pending === 'resonance' ? (
          <LoaderCircle className="daily-quote-spin" size={18} aria-hidden="true" />
        ) : (
          <Heart className="daily-quote-card__icon" size={18} aria-hidden="true" />
        )}
        {quote.resonated ? '已共鸣' : '共鸣'}{' '}
        <span key={quote.resonance_count} className="daily-quote-card__count numeric">
          {quote.resonance_count}
        </span>
      </button>
      <button
        type="button"
        className={`daily-quote-card__action daily-quote-card__action--favorite${quote.favorited ? ' is-active' : ''}`}
        onClick={() => void action('favorite')}
        disabled={pending !== null || !quote.can_favorite}
        aria-busy={pending === 'favorite'}
        aria-pressed={quote.favorited}
        aria-label={quote.favorited ? '已收藏' : '收藏'}
      >
        {pending === 'favorite' ? (
          <LoaderCircle className="daily-quote-spin" size={18} aria-hidden="true" />
        ) : (
          <Star className="daily-quote-card__icon" size={18} aria-hidden="true" />
        )}
        {quote.favorited ? '已收藏' : '收藏'}
      </button>
      {!quote.resonated && fee && <span className="daily-quote-card__fee">{fee}</span>}
    </div>
  );

  const feedback = (
    <p
      className={`daily-quote-card__note${error ? ' daily-quote-card__note--error' : ''}`}
      role={error ? 'alert' : message ? 'status' : undefined}
    >
      {note && <span key={note}>{note}</span>}
    </p>
  );

  if (blogRequired) return <QuoteBlogRequired embedded />;
  if (listMode) {
    return (
      <article className="daily-quote-card daily-quote-card--list">
        {meta}
        <blockquote className="daily-quote-card__text">{quote.content}</blockquote>
        {byline}
        {actions}
        {note && feedback}
      </article>
    );
  }

  return (
    <article className="daily-quote-card">
      {meta}
      <div className="daily-quote-card__quote">
        <blockquote className="daily-quote-card__text">{quote.content}</blockquote>
        {byline}
      </div>
      {actions}
      {hint && <p className="daily-quote-card__hint">{hint}</p>}
      {note && feedback}
    </article>
  );
}
