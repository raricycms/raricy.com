'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { candleKey, type CandleTuple, type MarketInterval } from '@/lib/market-candles';

// 客户端那份 K 线缓存。
//
// 【缓存键与服务端同一个形状】`${symbol}:${interval}`（market-candles.ts 的 candleKey）——
// 两边说的「同一份数据」必须是同一件事。
//
// 【取数时机只有三处，没有任何定时轮询】
//   ① 切标的 / 切周期后目标那格不在手上（或上一次取失败了）
//   ② 用户点了「重新加载」
//   ③ **跨桶**：展示价越过了末根的桶边界（见 market-chart.ts 的 mergeLivePrice），
//      说明本地这批已经落后于行情，静默补取一次
// 行情本身（价格）由 TradePanel 那条 1 秒轮询负责，K 线不该再开一条循环。
//
// 【切回来是瞬时的】取过的格子留在手上，来回切标的不会重新发请求 ——
// 服务端那份缓存也只有 60 秒，两边都省。

export type CandleStatus = 'ready' | 'loading' | 'error';

export interface CandleEntry {
  candles: CandleTuple[];
  status: CandleStatus;
}

export interface UseCandles {
  /** 取某一格（没有就是 undefined）。 */
  get(symbol: string, interval: MarketInterval): CandleEntry | undefined;
  /** 让某一格可用（已在手上就不动）。切标的/切周期时调。 */
  ensure(symbol: string, interval: MarketInterval): void;
  /** 强制重取（跨桶补数据、错误后重试）。 */
  refresh(symbol: string, interval: MarketInterval): void;
}

/**
 * @param initial 服务端首屏给的那几格（键是 `candleKey`）。首屏因此不用等一次客户端往返。
 */
export function useCandles(initial: Record<string, CandleTuple[]>): UseCandles {
  const [entries, setEntries] = useState<Record<string, CandleEntry>>(() =>
    Object.fromEntries(
      Object.entries(initial).map(([k, v]) => [
        k,
        { candles: v, status: v.length > 0 ? 'ready' : 'error' } as CandleEntry,
      ])
    )
  );

  // 「手上有没有这一格」要在回调里同步读到 —— state 在闭包里是旧的，
  // 所以另外留一份 ref（在 effect 里同步，不在渲染期写 ref）。
  const entriesRef = useRef(entries);
  useEffect(() => {
    entriesRef.current = entries;
  }, [entries]);

  /** 同一格并发只发一次请求（切换很快时不该连打好几次）。 */
  const inflight = useRef<Set<string>>(new Set());

  const load = useCallback(async (symbol: string, interval: MarketInterval, force: boolean) => {
    const key = candleKey(symbol, interval);
    if (inflight.current.has(key)) return;

    const held = entriesRef.current[key];
    const hasData = !!held && held.candles.length > 0;
    // 非强制时：手上有数据就不动。强制时（跨桶补数据）**保留旧数据继续画**，
    // 不切成 loading —— 那会让整张图闪一下白。
    if (!force && held?.status === 'ready' && hasData) return;

    inflight.current.add(key);
    if (!hasData) {
      setEntries((prev) => ({ ...prev, [key]: { candles: [], status: 'loading' } }));
    }

    let next: CandleEntry;
    try {
      const res = await fetch(
        `/api/fish/trade/candles?symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(interval)}`,
        { credentials: 'same-origin' }
      );
      const data = await res.json().catch(() => null);
      const list: CandleTuple[] = Array.isArray(data?.candles) ? data.candles : [];
      if (res.ok && data?.code === 200 && list.length > 0) {
        next = { candles: list, status: 'ready' };
      } else {
        // 拉不到就留着旧的那份（哪怕它旧）—— 与 srv 的 getCandles 同一条口径：
        // 图是装饰，但已经在屏幕上的数据不该因为我们取不到新的就消失
        next = { candles: held?.candles ?? [], status: 'error' };
      }
    } catch {
      next = { candles: held?.candles ?? [], status: 'error' };
    } finally {
      inflight.current.delete(key);
    }

    entriesRef.current = { ...entriesRef.current, [key]: next };
    setEntries(entriesRef.current);
  }, []);

  const ensure = useCallback(
    (symbol: string, interval: MarketInterval) => {
      void load(symbol, interval, false);
    },
    [load]
  );

  const refresh = useCallback(
    (symbol: string, interval: MarketInterval) => {
      void load(symbol, interval, true);
    },
    [load]
  );

  const get = useCallback((symbol: string, interval: MarketInterval) => entries[candleKey(symbol, interval)], [entries]);

  return { get, ensure, refresh };
}
