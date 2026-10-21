'use client';

import { useState } from 'react';
import { Heart, Star, PenLine } from 'lucide-react';
import { type DailyQuoteView } from '@/lib/daily-quote';

export default function DailyQuoteCard({ initialQuote, onSubmit, onRemoved }: {
  initialQuote: DailyQuoteView;
  onSubmit?: () => void;
  onRemoved?: () => void;
}) {
  const [quote, setQuote] = useState(initialQuote);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  async function action(kind: 'resonance' | 'favorite') {
    if (busy) return;
    setBusy(true); setError(''); setMessage('');
    try {
      const removing = kind === 'favorite' && quote.favorited;
      const response = await fetch(`/api/daily-quotes/${encodeURIComponent(quote.id)}/${kind}`, {
        method: removing ? 'DELETE' : 'POST',
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || '操作失败，请稍后重试');
      if (kind === 'resonance') {
        setQuote((current) => ({ ...current, resonated: true, can_resonate: false,
          resonance_count: current.resonance_count + (data.already_resonated ? 0 : 1) }));
        setMessage(data.already_resonated ? '今天已经共鸣过这句一言' : quote.resonance_fish ? '已共鸣，向投稿人投喂1条鱼干' : '已共鸣');
      } else {
        setQuote((current) => ({ ...current, favorited: !removing }));
        setMessage(removing ? '已移出一言集' : '已收藏到一言集');
        if (removing) onRemoved?.();
      }
    } catch (cause) { setError(cause instanceof Error ? cause.message : '操作失败'); }
    finally { setBusy(false); }
  }

  return (
    <article className="daily-quote-card">
      <div className="daily-quote-card__meta">
        <span>{quote.category}</span><span>{quote.kind === 'builtin' ? '经典语录' : '站友投稿'}</span>
      </div>
      <blockquote className="daily-quote-card__text">{quote.content}</blockquote>
      <p className="daily-quote-card__author">{quote.kind === 'community' ? `${quote.author} 投稿` : quote.author}</p>
      <p className="daily-quote-card__source">
        {quote.source_type === 'original' ? '原创' : <>
          引用自：{quote.source_url
            ? <a href={quote.source_url} target="_blank" rel="noreferrer">{quote.source_name}</a>
            : quote.source_name}
        </>}
      </p>
      <div className="daily-quote-card__actions">
        <button type="button" className={`daily-quote-card__action${quote.resonated ? ' is-active' : ''}`}
          onClick={() => void action('resonance')} disabled={busy || !quote.can_resonate}
          aria-pressed={quote.resonated}
          aria-label={quote.resonated ? '今日已共鸣' : quote.resonance_fish ? '共鸣，投喂1条鱼干' : '共鸣，免费'}>
          <Heart size={18} aria-hidden="true" />{quote.resonated ? '已共鸣' : '共鸣'} <span className="numeric">{quote.resonance_count}</span>
        </button>
        <button type="button" className={`daily-quote-card__action daily-quote-card__action--favorite${quote.favorited ? ' is-active' : ''}`}
          onClick={() => void action('favorite')} disabled={busy} aria-pressed={quote.favorited}>
          <Star size={18} aria-hidden="true" />{quote.favorited ? '已收藏' : '收藏'}
        </button>
        {onSubmit && <button type="button" className="daily-quote-card__action" onClick={onSubmit} disabled={busy}>
          <PenLine size={18} aria-hidden="true" />我也要投稿
        </button>}
      </div>
      <p className="daily-quote-card__hint">{quote.resonance_unavailable ?? (quote.resonance_fish
        ? '共鸣将从你的余额扣除1条鱼干，全额投喂给投稿人；同一句每天限一次。'
        : '经典语录共鸣免费；同一句每天限一次。')}</p>
      {message && <p className="daily-quote-card__feedback" role="status">{message}</p>}
      {error && <p className="daily-quote-error" role="alert">{error}</p>}
    </article>
  );
}
