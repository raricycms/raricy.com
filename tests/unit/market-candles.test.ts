// market-candles.ts —— K 线的词汇表（周期 / 根数 / 线上形状 / 缓存键）。
//
// 【这组用例钉的是什么】这份词汇服务端与客户端**共用**，而它的错误是静默的：
//   • 周期白名单被悄悄扩了（加一档周期 = 多一个币安 URL 参数，与 parseSymbol 同一条纪律）
//   • 缓存键漏了周期，1h 与 4h 会互相串档
// INTERVAL_MS / INTERVAL_LABELS 的逐键与标签文本属常量复述，按精简口径已删除。

import { describe, it, expect } from 'vitest';
import {
  MARKET_INTERVALS,
  DEFAULT_INTERVAL,
  parseInterval,
  candleKey,
  sparkCloses,
  SPARK_CANDLES,
  type CandleTuple,
} from '@/lib/market-candles';

describe('周期白名单', () => {
  it('恰好这六档（加周期要同步页面文案与 docs，别悄悄扩）', () => {
    expect([...MARKET_INTERVALS]).toEqual(['1m', '5m', '15m', '1h', '4h', '1d']);
  });

  it('默认周期在白名单里 —— 拼不出 URL 的默认值等于首页白屏', () => {
    expect(MARKET_INTERVALS).toContain(DEFAULT_INTERVAL);
  });
});

describe('parseInterval（周期进 URL 前的唯一一道门）', () => {
  it('白名单里的都放行', () => {
    for (const iv of MARKET_INTERVALS) expect(parseInterval(iv)).toBe(iv);
  });

  it('两侧空白去掉', () => {
    expect(parseInterval('  4h ')).toBe('4h');
  });

  it('★ 大小写**不折叠**：1M 是月线、1m 是分钟线，折了就是把月线画成分钟线', () => {
    expect(parseInterval('1m')).toBe('1m');
    expect(parseInterval('1M'), '币安的 1M 是月线，白名单里没有它').toBeNull();
    expect(parseInterval('4H')).toBeNull();
  });

  it('白名单外的、非字符串的一律 null（由调用方回 400，不静默退回默认档）', () => {
    for (const bad of ['1w', '3m', '2h', '1', 'd', '', '  ', null, undefined, 42, {}, ['1h']]) {
      expect(parseInterval(bad), JSON.stringify(bad) ?? 'undefined').toBeNull();
    }
  });
});

describe('candleKey / sparkCloses', () => {
  it('键的形状是 标的:周期 —— 服务端与客户端共用同一个', () => {
    expect(candleKey('BTCUSDT', '1h')).toBe('BTCUSDT:1h');
    expect(candleKey('ETHUSDT', '4h')).toBe('ETHUSDT:4h');
  });

  it('★ 周期必须在键里：少了它就是 1h 与 4h 互相串档（且不报错）', () => {
    expect(candleKey('BTCUSDT', '1h')).not.toBe(candleKey('BTCUSDT', '4h'));
  });

  it('自选列表的走势线取末尾 SPARK_CANDLES 根的收盘价', () => {
    const mk = (t: number): CandleTuple => [t, 1, 2, 0, t, 0];
    const many = Array.from({ length: SPARK_CANDLES + 30 }, (_, i) => mk(i));
    const closes = sparkCloses(many);
    expect(closes).toHaveLength(SPARK_CANDLES);
    expect(closes[0], '切的是末尾那一批，不是开头那一批').toBe(30);
    expect(closes[closes.length - 1]).toBe(SPARK_CANDLES + 29);
  });

  it('比 SPARK_CANDLES 短的序列原样取出，空序列给空数组（首屏行情没回来时走这条）', () => {
    const few: CandleTuple[] = [[0, 1, 2, 0, 80000, 0]];
    expect(sparkCloses(few)).toEqual([80000]);
    expect(sparkCloses([])).toEqual([]);
  });
});
