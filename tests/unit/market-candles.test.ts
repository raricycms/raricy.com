// market-candles.ts —— K 线的词汇表（周期 / 根数 / 线上形状 / 缓存键）。
//
// 【这组用例钉的是什么】这份词汇服务端与客户端**共用**，而它有两类错误是静默的：
//   • 周期白名单被悄悄扩了（加一档周期 = 多一个币安 URL 参数，与 parseSymbol 同一条纪律）
//   • `INTERVAL_MS` / `INTERVAL_LABELS` 漏键或写错值 —— 前者让跨桶判定错位（图上的
//     最后一根不再跳），后者是**一颗没有文字的空按钮**。两个都不报错。
// 所以这里逐个键钉死，而不是「遍历一下 key 都存在」。

import { describe, it, expect } from 'vitest';
import {
  MARKET_INTERVALS,
  INTERVAL_MS,
  INTERVAL_LABELS,
  DEFAULT_INTERVAL,
  parseInterval,
  candleKey,
  sparkCloses,
  CANDLE_LIMIT,
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

  it('单次根数上限 = 币安的上限 1000（超了它直接报错）', () => {
    expect(CANDLE_LIMIT).toBe(1000);
  });
});

describe('INTERVAL_MS（一档多长）', () => {
  // 逐个写死而不是「按名字算一遍」：名字parse错的（'15m' 写成 15 秒）只有定值能抓到
  it('每个档的值都对，且没有漏键', () => {
    expect(INTERVAL_MS).toEqual({
      '1m': 60_000,
      '5m': 300_000,
      '15m': 900_000,
      '1h': 3_600_000,
      '4h': 14_400_000,
      '1d': 86_400_000,
    });
  });

  it('除 1d 外都是整分钟 —— 时间轴刻度按整点吸附，靠的就是这一点', () => {
    for (const iv of MARKET_INTERVALS) {
      if (iv === '1d') continue;
      expect(INTERVAL_MS[iv] % 60_000, iv).toBe(0);
    }
  });
});

describe('INTERVAL_LABELS（按钮上的字）', () => {
  it('每一档都有非空标签 —— 漏一个就是一颗点不出来的空按钮，不报错', () => {
    for (const iv of MARKET_INTERVALS) {
      expect(typeof INTERVAL_LABELS[iv], iv).toBe('string');
      expect(INTERVAL_LABELS[iv].length, iv).toBeGreaterThan(0);
    }
  });

  it('标签与周期名一致（按钮与接口参数长得一样，读起来不会错位）', () => {
    for (const iv of MARKET_INTERVALS) expect(INTERVAL_LABELS[iv], iv).toBe(iv);
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
