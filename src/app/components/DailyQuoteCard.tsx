'use client';

import { useState } from 'react';
import { Heart, LoaderCircle, Star } from 'lucide-react';
import { type DailyQuoteView } from '@/lib/daily-quote';

export default function DailyQuoteCard({ initialQuote, onRemoved, onChange }: {
  initialQuote: DailyQuoteView;
  onRemoved?: () => void;
  onChange?: (quote: DailyQuoteView) => void;
}) {
  const [quote, setQuote] = useState(initialQuote);
  const [pending, setPending] = useState<'resonance' | 'favorite' | null>(null);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  function update(next: DailyQuoteView) {
    setQuote(next);
    onChange?.(next);
  }

  async function action(kind: 'resonance' | 'favorite') {
    if (pending) return;
    setPending(kind); setError(''); setMessage('');
    try {
      const removing = kind === 'favorite' && quote.favorited;
      const response = await fetch(`/api/daily-quotes/${encodeURIComponent(quote.id)}/${kind}`, {
        method: removing ? 'DELETE' : 'POST',
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || '操作失败，请稍后重试');
      if (kind === 'resonance') {
        update({ ...quote, resonated: true, can_resonate: false,
          resonance_count: quote.resonance_count + (data.already_resonated ? 0 : 1) });
        setMessage(data.already_resonated ? '今天已经共鸣过这句一言' : quote.resonance_fish ? '已共鸣，向投稿人投喂1条鱼干' : '已共鸣');
      } else {
        update({ ...quote, favorited: !removing });
        setMessage(removing ? '已移出一言集' : '已收藏到一言集');
        if (removing) onRemoved?.();
      }
    } catch (cause) { setError(cause instanceof Error ? cause.message : '操作失败'); }
    finally { setPending(null); }
  }

  const hint = quote.resonance_unavailable ?? (quote.resonance_fish
    ? '共鸣将从你的余额扣除1条鱼干，全额投喂给投稿人；同一句每天限一次。'
    : '经典语录共鸣免费；同一句每天限一次。');
  const note = error || message;

  return (
    <article className="daily-quote-card">
      <div className="daily-quote-card__meta">
        <span className="daily-quote-card__category">{quote.category}</span>
        <span>{quote.kind === 'builtin' ? '经典语录' : '站友投稿'}</span>
      </div>
      <div className="daily-quote-card__quote">
        <blockquote className="daily-quote-card__text">{quote.content}</blockquote>
        <p className="daily-quote-card__byline">
          <span className="daily-quote-card__author">{quote.kind === 'community' ? `${quote.author} 投稿` : quote.author}</span>
          <span className="daily-quote-card__source">
            {quote.source_type === 'original' ? '原创' : <>
              引用自：{quote.source_url
                ? <a href={quote.source_url} target="_blank" rel="noreferrer">{quote.source_name}</a>
                : quote.source_name}
            </>}
          </span>
        </p>
      </div>
      <div className="daily-quote-card__actions">
        <button type="button" className={`daily-quote-card__action${quote.resonated ? ' is-active' : ''}`}
          onClick={() => void action('resonance')} disabled={pending !== null || !quote.can_resonate}
          aria-busy={pending === 'resonance'}
          aria-pressed={quote.resonated}
          aria-label={quote.resonated ? '今日已共鸣' : quote.resonance_fish ? '共鸣，投喂1条鱼干' : '共鸣，免费'}>
          {pending === 'resonance' ? <LoaderCircle className="daily-quote-spin" size={18} aria-hidden="true" />
            : <Heart className="daily-quote-card__icon" size={18} aria-hidden="true" />}
          {quote.resonated ? '已共鸣' : '共鸣'} <span key={quote.resonance_count} className="daily-quote-card__count numeric">{quote.resonance_count}</span>
        </button>
        <button type="button" className={`daily-quote-card__action daily-quote-card__action--favorite${quote.favorited ? ' is-active' : ''}`}
          onClick={() => void action('favorite')} disabled={pending !== null} aria-busy={pending === 'favorite'}
          aria-pressed={quote.favorited}>
          {pending === 'favorite' ? <LoaderCircle className="daily-quote-spin" size={18} aria-hidden="true" />
            : <Star className="daily-quote-card__icon" size={18} aria-hidden="true" />}
          {quote.favorited ? '已收藏' : '收藏'}
        </button>
      </div>
      <p className="daily-quote-card__hint">{hint}</p>
      <p className={`daily-quote-card__note${error ? ' daily-quote-card__note--error' : ''}`}
        role={error ? 'alert' : message ? 'status' : undefined}>
        {note && <span key={note}>{note}</span>}
      </p>
    </article>
  );
}
