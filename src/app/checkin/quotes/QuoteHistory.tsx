'use client';

import { useState } from 'react';
import type { DailyQuoteHistoryEntry, DailyQuoteView } from '@/lib/daily-quote';
import DailyQuoteCard from '@/app/components/DailyQuoteCard';

/**
 * 往期列表：按日期倒序，一条一期。
 *
 * 【状态按 quoteId 存】同一句话可能在 90 天后再次入选，于是同一页里有两个日期、
 * 两张卡指向同一条一言。互动状态必须按 quoteId 共享 —— 操作其中一条后，另一条
 * 也要立刻变成「已共鸣 / 已收藏」，否则界面会同时呈现两种互相矛盾的状态。
 * 日期不是状态键：它只决定顺序与卡片标题。
 *
 * 【下架 / 归档】`quote: null` 是「那期确实存在、但内容已不可展示」。日期必须留着
 * （那是「那天有过一言」的唯一痕迹），只给占位，不显示原文、出处或身份。
 */
export default function QuoteHistory({ entries }: { entries: DailyQuoteHistoryEntry[] }) {
  const [states, setStates] = useState<Record<string, DailyQuoteView>>({});

  return (
    <div className="daily-quote-list">
      {entries.map((entry) =>
        entry.quote ? (
          <DailyQuoteCard
            key={`${entry.day}-${entry.quote.id}`}
            mode="list"
            quote={states[entry.quote.id] ?? entry.quote}
            dateLabel={entry.day}
            onChange={(next) => {
              const id = next.id;
              setStates((current) => ({ ...current, [id]: next }));
            }}
          />
        ) : (
          <article key={entry.day} className="daily-quote-card daily-quote-card--list daily-quote-card--unavailable">
            <div className="daily-quote-card__meta">
              <span className="daily-quote-card__date numeric">{entry.day}</span>
            </div>
            <p className="daily-quote-card__unavailable">该日内容已不可用</p>
          </article>
        )
      )}
    </div>
  );
}
