// ─────────────────────────────────────────────────────────────────────────────
// dev-tools-time.test.ts —— 开发者工具「时间与链接」家族的纯逻辑单测
//
// 覆盖 src/lib/dev-tools/{datetime,cron,jwt,url-tools}.ts 与 uuid 的纯生成逻辑。
// 这一族最容易错的地方都不是「抛异常」，而是「算出了一个看起来合理的错值」：
//   · 时间戳单位判错（10 位秒 vs 13 位毫秒）；
//   · cron 偷偷按运行机器的本地时区算（本文件把站点时区 UTC+8 钉在断言里）；
//   · JWT 的 exp / nbf 用了运行时的「现在」而不是传入的 nowMs（单测因此可冻结时间）；
//   · URL 重复键被 URLSearchParams 合并、追踪参数没去干净、裸域名把 file.txt 当网址；
//   · UUID v7 的版本位 / 变体位 / 时间戳位错一位。
// 所以断言直接写具体数值 / 形状，而不是「结果非空」。
// ─────────────────────────────────────────────────────────────────────────────

import { describe, expect, it } from 'vitest';

import {
  COMMON_TIME_ZONES,
  describeTimestamp,
  formatDuration,
  formatInTimeZone,
  formatIsoUtc,
  formatSiteTime,
  localTimeZone,
  parseTimestamp,
  relativeTime,
  timeZoneOffsetLabel,
  timeZoneTable,
  toUnixMillis,
  toUnixSeconds,
  weekdayInTimeZone,
  weekdayUtc8,
} from '@/lib/dev-tools/datetime';
import { CRON_MACROS, nextRuns, parseCron } from '@/lib/dev-tools/cron';
import { buildClaimRows, decodeBase64UrlText, decodeJwt } from '@/lib/dev-tools/jwt';
import {
  EXTRACT_MAX_INPUT_CHARS,
  EXTRACT_MAX_RESULTS,
  UTM_PRESETS,
  buildUrl,
  buildUtmUrl,
  extractUrls,
  normalizeBaseUrl,
  parseUrlParts,
  stripTrackingParams,
  toDomainOnly,
} from '@/lib/dev-tools/url-tools';
import { formatUuid, uuidV4, uuidV7, uuidVersion } from '@/app/tool/dev/uuid/uuid';

// 2023-11-14T22:13:20.000Z —— 用来冻住「现在」的一组常量。
const NOW = 1_700_000_000_000;
const NOW_SEC = 1_700_000_000;

describe('datetime：时间戳单位判定', () => {
  it('同一时刻的秒 / 毫秒 / 微秒 / 纳秒写法都归一到同一个 epochMs', () => {
    const expected = 1_700_000_000_000;
    const inputs: [string, string][] = [
      ['1700000000', 'seconds'],
      ['1700000000000', 'milliseconds'],
      ['1700000000000000', 'microseconds'],
      ['1700000000000000000', 'nanoseconds'],
    ];
    for (const [input, kind] of inputs) {
      const parsed = parseTimestamp(input, NOW);
      expect(parsed.ok, input).toBe(true);
      if (!parsed.ok) throw new Error('unreachable');
      expect(parsed.epochMs, input).toBe(expected);
      expect(parsed.inputKind, input).toBe(kind);
    }
  });

  it('微秒 / 纳秒按截断处理（不四舍五入）', () => {
    const micro = parseTimestamp('1700000000000999', NOW);
    const nano = parseTimestamp('1700000000000999999', NOW);
    expect(micro.ok && micro.epochMs).toBe(1_700_000_000_000);
    expect(nano.ok && nano.epochMs).toBe(1_700_000_000_000);
  });

  it('负时间戳（1970 之前）按同一位数规则处理', () => {
    const parsed = parseTimestamp('-86400', NOW);
    expect(parsed.ok && parsed.epochMs).toBe(-86_400_000);
  });

  it('秒级带小数时取到毫秒', () => {
    const parsed = parseTimestamp('1700000000.5', NOW);
    expect(parsed.ok && parsed.epochMs).toBe(1_700_000_000_500);
  });

  it('超过 19 位直接报错，不猜单位', () => {
    const parsed = parseTimestamp('17000000000000000000', NOW);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) throw new Error('unreachable');
    expect(parsed.error).toContain('位数过多');
  });

  it('空输入 / 乱写的输入给出错误而不是 0', () => {
    for (const input of ['', '   ', 'hello', '2024-13-01']) {
      const parsed = parseTimestamp(input, NOW);
      expect(parsed.ok, input).toBe(false);
    }
  });
});

describe('datetime：日期字符串解析（无时区按站点 UTC+8 解释）', () => {
  it('ISO 8601 带 Z 按 UTC 解释', () => {
    const parsed = parseTimestamp('2024-01-15T12:00:00Z', NOW);
    expect(parsed.ok && parsed.epochMs).toBe(Date.UTC(2024, 0, 15, 12, 0, 0));
  });

  it('ISO 8601 带 +08:00 偏移', () => {
    const parsed = parseTimestamp('2024-01-15T12:00:00+08:00', NOW);
    expect(parsed.ok && parsed.epochMs).toBe(Date.UTC(2024, 0, 15, 4, 0, 0));
  });

  it('无时区的 YYYY-MM-DD HH:mm:ss 按站点时区 UTC+8', () => {
    const parsed = parseTimestamp('2024-01-15 12:00:00', NOW);
    expect(parsed.ok && parsed.epochMs).toBe(Date.UTC(2024, 0, 15, 4, 0, 0));
  });

  it('只有日期时取站点时区的当天零点', () => {
    const parsed = parseTimestamp('2024-01-15', NOW);
    expect(parsed.ok && parsed.epochMs).toBe(Date.UTC(2024, 0, 14, 16, 0, 0));
  });

  it('不存在的日期（2 月 30 日）报错，而不是静默滚到 3 月', () => {
    const parsed = parseTimestamp('2024-02-30', NOW);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) throw new Error('unreachable');
    expect(parsed.error).toContain('不存在');
  });

  it('空格分隔 + 毫秒小数也接受', () => {
    const parsed = parseTimestamp('2024-01-15 12:00:00.250', NOW);
    expect(parsed.ok && parsed.epochMs).toBe(Date.UTC(2024, 0, 15, 4, 0, 0, 250));
  });
});

describe('datetime：展示格式（不依赖运行机器时区）', () => {
  it('ISO / 站点时间 / 指定时区三者的数值自洽', () => {
    expect(formatIsoUtc(NOW)).toBe('2023-11-14T22:13:20.000Z');
    expect(formatSiteTime(NOW)).toBe('2023-11-15 06:13:20');
    expect(formatInTimeZone(NOW, 'UTC')).toBe('2023-11-14 22:13:20');
    expect(formatInTimeZone(NOW, 'Asia/Shanghai')).toBe('2023-11-15 06:13:20');
    expect(formatInTimeZone(NOW, 'Asia/Tokyo')).toBe('2023-11-15 07:13:20');
  });

  it('常用时区表覆盖五个时区，且 UTC 与 UTC+8 相差 8 小时', () => {
    const table = timeZoneTable(NOW);
    expect(table.map((r) => r.zone)).toEqual(COMMON_TIME_ZONES.map((z) => z.zone));
    expect(table).toHaveLength(5);
    const utc = table.find((r) => r.zone === 'UTC');
    const shanghai = table.find((r) => r.zone === 'Asia/Shanghai');
    expect(utc?.time).toBe('2023-11-14 22:13:20');
    expect(shanghai?.time).toBe('2023-11-15 06:13:20');
    expect(utc?.offset).toBe('GMT');
    expect(shanghai?.offset).toBe('GMT+8');
  });

  it('偏移标签交给 Intl，不在代码里写死', () => {
    expect(timeZoneOffsetLabel(NOW, 'Asia/Shanghai')).toBe('GMT+8');
    expect(timeZoneOffsetLabel(NOW, 'UTC')).toBe('GMT');
  });

  it('星期按 UTC+8 给出中文', () => {
    expect(weekdayInTimeZone(NOW, 'UTC')).toBe('周二');
    expect(weekdayUtc8(NOW)).toBe('周三');
  });

  it('Unix 秒 / 毫秒换算', () => {
    expect(toUnixSeconds(NOW)).toBe(NOW_SEC);
    expect(toUnixMillis(NOW + 0.9)).toBe(NOW);
    expect(toUnixSeconds(-1)).toBe(-1);
  });

  it('describeTimestamp 一次给全所有展示项', () => {
    const display = describeTimestamp(NOW, NOW);
    expect(display.unixSeconds).toBe(String(NOW_SEC));
    expect(display.unixMillis).toBe(String(NOW));
    expect(display.isoUtc).toBe('2023-11-14T22:13:20.000Z');
    expect(display.siteTime).toBe('2023-11-15 06:13:20');
    expect(display.relative).toBe('刚刚');
    expect(display.localZone).toBe(localTimeZone());
    expect(display.localTime).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  it('相对时间按传入的 nowMs 计算（不取运行时的现在）', () => {
    expect(relativeTime(NOW, NOW)).toBe('刚刚');
    expect(relativeTime(NOW + 3 * 86_400_000, NOW)).toBe('3 天后');
    expect(relativeTime(NOW - 2 * 3_600_000, NOW)).toBe('2 小时前');
    expect(relativeTime(NOW + 45_000, NOW)).toBe('45 秒后');
    expect(relativeTime(NOW - 60 * 86_400_000, NOW)).toContain('个月前');
    expect(relativeTime(NOW + 800 * 86_400_000, NOW)).toContain('年后');
  });

  it('时长拆分', () => {
    expect(formatDuration(0)).toBe('0 秒');
    expect(formatDuration(5_000)).toBe('5 秒');
    expect(formatDuration(120_000)).toBe('2 分钟');
    expect(formatDuration(3_600_000)).toBe('1 小时 0 分钟');
    expect(formatDuration(90_061_000)).toBe('1 天 1 小时');
    expect(formatDuration(-90_061_000)).toBe('1 天 1 小时');
  });
});

describe('cron：解析与解释', () => {
  it('宏展开成 5 字段表达式', () => {
    const parsed = parseCron('@daily');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error('unreachable');
    expect(parsed.expanded).toBe('0 0 * * *');
    expect(parsed.macro).toBe('@daily');
    expect(parsed.fields).toHaveLength(5);
    expect(parsed.fields[0].description).toBe('第 0 分钟');
    expect(parsed.fields[1].description).toBe('0 点');
    expect(parsed.fields[2].description).toBe('每天');
    expect(parsed.fields[3].description).toBe('每月');
    expect(parsed.fields[4].description).toBe('每周的每一天');
  });

  it('所有登记过的宏都能解析', () => {
    for (const macro of Object.keys(CRON_MACROS)) {
      expect(parseCron(macro).ok, macro).toBe(true);
    }
  });

  it('* / a-b / a,b / */n / a-b/n / 名称 / ? 都支持', () => {
    const samples = [
      '* * * * *',
      '0-30 * * * *',
      '0,15,30,45 * * * *',
      '*/15 * * * *',
      '10-50/10 * * * *',
      '0 0 * JAN-MAR *',
      '0 0 * * MON-FRI',
      '0 0 ? * MON',
      '0 12 1,15 * *',
    ];
    for (const sample of samples) {
      expect(parseCron(sample).ok, sample).toBe(true);
    }
  });

  it('逐字段中文解释（步长 / 区间 / 列表）', () => {
    const parsed = parseCron('*/15 9-18 * * MON-FRI');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error('unreachable');
    expect(parsed.fields[0].description).toBe('每 15 分钟');
    expect(parsed.fields[0].step).toBe(15);
    expect(parsed.fields[1].description).toContain('9、10');
    expect(parsed.fields[4].description).toContain('周一');
    expect(parsed.fields[4].description).toContain('周五');
  });

  it('字段级错误：越界 / 段数不对 / 未知宏 / 空分段', () => {
    const outOfRange = parseCron('61 * * * *');
    expect(outOfRange.ok).toBe(false);
    if (outOfRange.ok) throw new Error('unreachable');
    expect(outOfRange.errors[0]).toContain('[分钟]');
    expect(outOfRange.errors[0]).toContain('61');

    const wrongCount = parseCron('0 0 * *');
    expect(wrongCount.ok).toBe(false);
    if (wrongCount.ok) throw new Error('unreachable');
    expect(wrongCount.errors[0]).toContain('5 字段');

    const unknownMacro = parseCron('@every_minute');
    expect(unknownMacro.ok).toBe(false);
    if (unknownMacro.ok) throw new Error('unreachable');
    expect(unknownMacro.errors[0]).toContain('宏');

    const emptyPart = parseCron('0,,5 * * * *');
    expect(emptyPart.ok).toBe(false);
  });

  it('星期 7 与 0 同义（都指向周日）', () => {
    const sunday = parseCron('0 0 * * 7');
    expect(sunday.ok).toBe(true);
    if (!sunday.ok) throw new Error('unreachable');
    expect(sunday.fields[4].values).toEqual([0]);
  });
});

describe('cron：下次执行时间一律按站点时区 UTC+8', () => {
  it('每天 0 点 = 前一天 16:00 UTC', () => {
    const from = Date.UTC(2024, 0, 1, 0, 0, 0); // 2024-01-01 08:00 UTC+8
    const result = nextRuns('0 0 * * *', from, 1);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.runs[0]).toBe(Date.UTC(2024, 0, 1, 16, 0, 0));
    expect(formatSiteTime(result.runs[0])).toBe('2024-01-02 00:00:00');
    expect(formatInTimeZone(result.runs[0], 'UTC')).toBe('2024-01-01 16:00:00');
  });

  it('每 5 分钟：贴着起点算，且严格晚于 fromMs', () => {
    const from = Date.UTC(2024, 0, 1, 0, 0, 0);
    const result = nextRuns('*/5 * * * *', from, 8);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.runs).toHaveLength(8);
    expect(result.runs[0]).toBe(from + 5 * 60_000);
    expect(result.runs[7]).toBe(from + 8 * 5 * 60_000);

    const exactly = nextRuns('0 9 * * *', Date.UTC(2024, 0, 1, 1, 0, 0), 1);
    expect(exactly.ok && exactly.runs[0]).toBe(Date.UTC(2024, 0, 2, 1, 0, 0));
  });

  it('工作日 9 点：跳过周末', () => {
    // 2024-01-05T00:00Z = 周五 08:00（UTC+8）；下一次是当天 09:00，再下一次是下周一 09:00。
    const from = Date.UTC(2024, 0, 5, 0, 0, 0);
    const result = nextRuns('0 9 * * 1-5', from, 2);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.runs[0]).toBe(Date.UTC(2024, 0, 5, 1, 0, 0));
    expect(result.runs[1]).toBe(Date.UTC(2024, 0, 8, 1, 0, 0));
    expect(formatSiteTime(result.runs[1])).toBe('2024-01-08 09:00:00');
  });

  it('日与星期都被限定时取「或」（Vixie cron 语义）', () => {
    const from = Date.UTC(2024, 0, 1, 0, 0, 0);
    // 13 号或周五：1 月里先到的是 1 月 5 日（周五），再是 1 月 12 日（周五）。
    const either = nextRuns('0 0 13 * 5', from, 2);
    expect(either.ok).toBe(true);
    if (!either.ok) throw new Error('unreachable');
    expect(either.runs[0]).toBe(Date.UTC(2024, 0, 4, 16, 0, 0));
    expect(either.runs[1]).toBe(Date.UTC(2024, 0, 11, 16, 0, 0));

    // 只有日被限定 → 就是 13 号，不受星期影响。
    const domOnly = nextRuns('0 0 13 * *', from, 1);
    expect(domOnly.ok && domOnly.runs[0]).toBe(Date.UTC(2024, 0, 12, 16, 0, 0));

    // 只有星期被限定 → 就是周五。
    const dowOnly = nextRuns('0 0 * * 5', from, 1);
    expect(dowOnly.ok && dowOnly.runs[0]).toBe(Date.UTC(2024, 0, 4, 16, 0, 0));
  });

  it('永远不会执行的表达式在搜索上限内返回空并标记 exhausted', () => {
    const result = nextRuns('0 0 30 2 *', Date.UTC(2024, 0, 1, 0, 0, 0), 3);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.runs).toEqual([]);
    expect(result.exhausted).toBe(true);
  });

  it('解析失败时 nextRuns 原样返回字段级错误', () => {
    const result = nextRuns('99 * * * *', NOW, 3);
    expect(result.ok).toBe(false);
  });
});

describe('jwt：base64url 解码', () => {
  it('自动补 padding，缺省 padding 也能解', () => {
    const text = '{"a":1}';
    const base64 = Buffer.from(text, 'utf8').toString('base64url');
    expect(decodeBase64UrlText(base64)).toEqual({ ok: true, text });
    expect(decodeBase64UrlText(`${base64}==`)).toEqual({ ok: true, text });
  });

  it('非法字符 / 非法长度报错', () => {
    expect(decodeBase64UrlText('***').ok).toBe(false);
    expect(decodeBase64UrlText('a').ok).toBe(false);
    expect(decodeBase64UrlText('').ok).toBe(false);
  });
});

describe('jwt：解码与声明检查（只解码，不验签）', () => {
  const b64urlJson = (value: unknown) => Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
  const makeToken = (header: unknown, payload: unknown, signature = 'sig') =>
    `${b64urlJson(header)}.${b64urlJson(payload)}.${signature}`;

  it('解出头部 / 载荷并给出声明表', () => {
    const token = makeToken(
      { alg: 'HS256', typ: 'JWT' },
      {
        iss: 'raricy',
        sub: 'user-1',
        aud: ['a', 'b'],
        iat: NOW_SEC - 60,
        nbf: NOW_SEC - 60,
        exp: NOW_SEC + 3600,
        jti: 'abc',
      }
    );
    const result = decodeJwt(token, NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');

    expect(result.decoded.alg).toBe('HS256');
    expect(result.decoded.signaturePresent).toBe(true);
    expect(result.decoded.exp.state).toBe('valid');
    expect(result.decoded.exp.text).toContain('未过期');
    expect(result.decoded.nbf.state).toBe('valid');
    expect(result.decoded.warnings).toEqual([]);

    const rows = buildClaimRows(result.decoded.payload, NOW);
    expect(rows[0].key).toBe('iss');
    expect(rows[0].label).toContain('签发者');
    const aud = rows.find((r) => r.key === 'aud');
    expect(aud?.value).toBe('a, b');
    const exp = rows.find((r) => r.key === 'exp');
    expect(exp?.value).toContain(`Unix 秒 ${NOW_SEC + 3600}`);
    expect(exp?.value).toContain('UTC+8');
  });

  it('过期 / 尚未生效的状态基于传入的 nowMs', () => {
    const expired = decodeJwt(makeToken({ alg: 'HS256' }, { exp: NOW_SEC - 100 }), NOW);
    expect(expired.ok && expired.decoded.exp.state).toBe('expired');
    if (!expired.ok) throw new Error('unreachable');
    expect(expired.decoded.exp.text).toContain('已过期');

    const notYet = decodeJwt(makeToken({ alg: 'HS256' }, { nbf: NOW_SEC + 600 }), NOW);
    expect(notYet.ok && notYet.decoded.nbf.state).toBe('future');
    if (!notYet.ok) throw new Error('unreachable');
    expect(notYet.decoded.nbf.text).toContain('尚未生效');
  });

  it('alg: none 显式警告', () => {
    const token = `${b64urlJson({ alg: 'none', typ: 'JWT' })}.${b64urlJson({ sub: 'x' })}.`;
    const result = decodeJwt(token, NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.decoded.alg).toBe('none');
    expect(result.decoded.warnings.join('\n')).toContain('alg: none');
    expect(result.decoded.signaturePresent).toBe(false);
  });

  it('2 段（无签名）被接受但给出警告；缺 exp/nbf 也警告', () => {
    const token = `${b64urlJson({ alg: 'HS256' })}.${b64urlJson({ sub: 'x' })}`;
    const result = decodeJwt(token, NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.decoded.signaturePresent).toBe(false);
    expect(result.decoded.exp.state).toBe('missing');
    expect(result.decoded.nbf.state).toBe('missing');
    expect(result.decoded.warnings.join('\n')).toContain('没有 exp 也没有 nbf');
    expect(result.decoded.warnings.join('\n')).toContain('没有签名段');
  });

  it('非法输入给错误而不是半套结果', () => {
    expect(decodeJwt('', NOW).ok).toBe(false);
    expect(decodeJwt('only-one-part', NOW).ok).toBe(false);
    expect(decodeJwt(`a.b.c.d`, NOW).ok).toBe(false);
    expect(decodeJwt(`${b64urlJson({ alg: 'HS256' })}.${b64urlJson([1, 2])}`, NOW).ok).toBe(false);
    const notJson = `${Buffer.from('not json').toString('base64url')}.${b64urlJson({})}`;
    expect(decodeJwt(notJson, NOW).ok).toBe(false);
  });

  it('支持带 Bearer 前缀的粘贴', () => {
    const token = makeToken({ alg: 'HS256' }, { exp: NOW_SEC + 10 });
    expect(decodeJwt(`Bearer ${token}`, NOW).ok).toBe(true);
  });
});

describe('url-tools：URL 参数解析与重建', () => {
  it('解析协议 / 主机 / 路径 / 参数 / 锚点，重复键保留', () => {
    const result = parseUrlParts('https://example.com/a/b?x=1&x=2&y=%E4%B8%AD#sec');
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    const { parts } = result;
    expect(parts.protocol).toBe('https');
    expect(parts.host).toBe('example.com');
    expect(parts.pathname).toBe('/a/b');
    expect(parts.hash).toBe('#sec');
    expect(parts.assumedProtocol).toBe(false);
    expect(parts.params).toEqual([
      { key: 'x', value: '1' },
      { key: 'x', value: '2' },
      { key: 'y', value: '中' },
    ]);
  });

  it('没写协议时按 https 解析并标记 assumedProtocol', () => {
    const result = parseUrlParts('example.com/p?q=1');
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.parts.protocol).toBe('https');
    expect(result.parts.assumedProtocol).toBe(true);
    expect(result.parts.params).toEqual([{ key: 'q', value: '1' }]);
  });

  it('空 / 非法 / 非 http 协议报错', () => {
    expect(parseUrlParts('').ok).toBe(false);
    expect(parseUrlParts('mailto:a@b.com').ok).toBe(false);
    expect(parseUrlParts('https://').ok).toBe(false);
  });

  it('重建时保留顺序与重复键，并按每行的开关决定是否编码', () => {
    const built = buildUrl({
      protocol: 'https',
      host: 'example.com',
      pathname: '/p',
      hash: 'frag',
      params: [
        { key: 'a', value: '1 2', encode: true },
        { key: 'a', value: 'x/y', encode: false },
      ],
    });
    expect(built.ok).toBe(true);
    if (!built.ok) throw new Error('unreachable');
    expect(built.url).toBe('https://example.com/p?a=1%202&a=x/y#frag');
  });

  it('空行不参与拼接；重复键不被合并', () => {
    const built = buildUrl({
      protocol: 'https',
      host: 'example.com',
      pathname: '/',
      hash: '',
      params: [
        { key: '', value: '', encode: true },
        { key: 'k', value: '1', encode: true },
        { key: 'k', value: '2', encode: true },
      ],
    });
    expect(built.ok && built.url).toBe('https://example.com/?k=1&k=2');
  });

  it('重建校验协议与主机', () => {
    expect(buildUrl({ protocol: 'ftp', host: 'example.com', pathname: '/', hash: '', params: [] }).ok).toBe(false);
    expect(buildUrl({ protocol: 'https', host: '', pathname: '/', hash: '', params: [] }).ok).toBe(false);
  });
});

describe('url-tools：UTM 生成', () => {
  it('补全协议、只拼非空字段', () => {
    const result = buildUtmUrl('example.com/landing', {
      source: 'google',
      medium: 'cpc',
      campaign: '',
      term: '',
      content: '',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.url).toBe('https://example.com/landing?utm_source=google&utm_medium=cpc');
    expect(result.base).toBe('https://example.com/landing');
    expect(result.params).toEqual([
      { key: 'utm_source', value: 'google' },
      { key: 'utm_medium', value: 'cpc' },
    ]);
  });

  it('覆盖基础链接里已有的同名 utm_*，其它参数保留', () => {
    const result = buildUtmUrl('https://example.com/?utm_source=old&foo=1', {
      source: 'new',
      medium: '',
      campaign: '',
      term: '',
      content: '',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.url).toContain('foo=1');
    expect(result.url).toContain('utm_source=new');
    expect(result.url).not.toContain('old');
    expect(result.url.match(/utm_source=/g)).toHaveLength(1);
  });

  it('一个都没填时报错；基础链接非法报错', () => {
    const empty = buildUtmUrl('https://example.com/', {
      source: '',
      medium: '',
      campaign: '',
      term: '',
      content: '',
    });
    expect(empty.ok).toBe(false);
    if (empty.ok) throw new Error('unreachable');
    expect(empty.error).toContain('至少填写一个');

    expect(buildUtmUrl('', { source: 'a', medium: '', campaign: '', term: '', content: '' }).ok).toBe(false);
    expect(buildUtmUrl('ftp://example.com', { source: 'a', medium: '', campaign: '', term: '', content: '' }).ok).toBe(
      false
    );
  });

  it('normalizeBaseUrl 补 https 并校验', () => {
    const ok = normalizeBaseUrl('example.com');
    expect(ok.ok && ok.url.toString()).toBe('https://example.com/');
    expect(normalizeBaseUrl('').ok).toBe(false);
  });

  it('预设按钮的数据存在且常用组合在列', () => {
    expect(UTM_PRESETS.length).toBeGreaterThanOrEqual(3);
    expect(UTM_PRESETS.some((p) => p.source === 'google' && p.medium === 'cpc')).toBe(true);
    expect(UTM_PRESETS.some((p) => p.source === 'wechat' && p.medium === 'social')).toBe(true);
  });
});

describe('url-tools：网址批量提取', () => {
  const allOff = {
    dedupe: false,
    ignoreCase: false,
    stripTracking: false,
    sort: false,
    domainsOnly: false,
  };

  it('提取 http(s) 链接与裸域名，跳过文件名 / 版本号 / 邮箱', () => {
    const text =
      '见 https://a.com/x?utm_source=news&id=1, 以及 b.example.org/path。' +
      '还有 file.txt、readme.md、v1.2 和邮箱 user@example.com';
    const result = extractUrls(text, allOff);
    expect(result.urls).toEqual(['https://a.com/x?utm_source=news&id=1', 'b.example.org/path']);
    expect(result.totalFound).toBe(2);
  });

  it('去掉追踪参数（utm_* / fbclid 等）', () => {
    expect(stripTrackingParams('https://a.com/x?utm_source=news&fbclid=zzz&id=1')).toBe(
      'https://a.com/x?id=1'
    );
    expect(stripTrackingParams('a.com/x?gclid=1&keep=2')).toBe('a.com/x?keep=2');
    expect(stripTrackingParams('a.com/x?keep=2')).toBe('a.com/x?keep=2');
  });

  it('去重（可忽略大小写）与排序', () => {
    const text = 'HTTPS://A.COM/x https://a.com/x https://b.com';
    const exact = extractUrls(text, allOff);
    expect(exact.urls).toHaveLength(3);

    // 精确去重只合并完全相同的串：大小写不同的两条仍算两条。
    const exactDeduped = extractUrls(text, { ...allOff, dedupe: true });
    expect(exactDeduped.urls).toHaveLength(3);
    expect(extractUrls('https://a.com/x https://a.com/x', { ...allOff, dedupe: true }).urls).toEqual([
      'https://a.com/x',
    ]);
    expect(exactDeduped.totalFound).toBe(3);

    const caseInsensitive = extractUrls(text, { ...allOff, dedupe: true, ignoreCase: true });
    expect(caseInsensitive.urls).toEqual(['HTTPS://A.COM/x', 'https://b.com']);

    const sorted = extractUrls('https://b.com https://a.com', { ...allOff, sort: true });
    expect(sorted.urls).toEqual(['https://a.com', 'https://b.com']);
  });

  it('只保留域名', () => {
    const result = extractUrls('https://a.com/x?q=1 b.example.org/path', {
      ...allOff,
      domainsOnly: true,
    });
    expect(result.urls).toEqual(['a.com', 'b.example.org']);
    expect(toDomainOnly('https://a.com/x')).toBe('a.com');
  });

  it('先去掉追踪参数再去重（否则同一页面会留下两条）', () => {
    const text = 'https://a.com/p?utm_source=a https://a.com/p?utm_source=b';
    const result = extractUrls(text, { ...allOff, dedupe: true, stripTracking: true });
    expect(result.urls).toEqual(['https://a.com/p']);
  });

  it('结尾标点 / 不成对括号被剥掉，成对括号保留', () => {
    expect(extractUrls('（见 https://a.com/p）。', allOff).urls).toEqual(['https://a.com/p']);
    expect(extractUrls('https://a.com/p).', allOff).urls).toEqual(['https://a.com/p']);
    expect(extractUrls('https://example.com/a_(b)', allOff).urls).toEqual([
      'https://example.com/a_(b)',
    ]);
  });

  it('超长输入标记 truncated；结果超过上限标记 limited', () => {
    const long = 'x'.repeat(EXTRACT_MAX_INPUT_CHARS + 10);
    expect(extractUrls(long, allOff).truncated).toBe(true);
    expect(extractUrls('https://a.com', allOff).truncated).toBe(false);

    const many = Array.from({ length: EXTRACT_MAX_RESULTS + 1 }, (_, i) => `https://e${i}.com`).join(' ');
    const limited = extractUrls(many, allOff);
    expect(limited.limited).toBe(true);
    expect(limited.urls).toHaveLength(EXTRACT_MAX_RESULTS);
  });
});

describe('uuid：v4 / v7 的位布局与格式化', () => {
  const uuidShape = /^[0-9a-f]{8}-[0-9a-f]{4}-([0-9a-f])[0-9a-f]{3}-([89ab])[0-9a-f]{3}-[0-9a-f]{12}$/;
  const fixedRandom = (n: number) => new Uint8Array(Array.from({ length: n }, (_, i) => i));

  it('v4 的版本位是 4、变体位是 8/9/a/b', () => {
    const uuid = uuidV4(() => new Uint8Array(16).fill(0xff), {
      uppercase: false,
      noHyphens: false,
    });
    const match = uuidShape.exec(uuid);
    expect(match).not.toBeNull();
    expect(match?.[1]).toBe('4');
    expect(match?.[2]).toBe('b');
    expect(uuidVersion(uuid)).toBe(4);
  });

  it('v7 的时间戳位 = 传入的毫秒，版本位 7、变体位合法', () => {
    const epochMs = 1_700_000_000_000;
    const uuid = uuidV7(epochMs, fixedRandom, { uppercase: false, noHyphens: false });
    const compact = uuid.replace(/-/g, '');
    expect(compact).toHaveLength(32);
    expect(Number.parseInt(compact.slice(0, 12), 16)).toBe(epochMs);
    expect(compact[12]).toBe('7');
    expect('89ab').toContain(compact[16]);
    expect(uuidVersion(uuid)).toBe(7);
  });

  it('同一毫秒的 v7 按随机位递增（先随机字节小的更小）', () => {
    const epochMs = 1_700_000_000_000;
    const first = uuidV7(epochMs, () => new Uint8Array(10).fill(0), {
      uppercase: false,
      noHyphens: false,
    });
    const second = uuidV7(epochMs, () => new Uint8Array(10).fill(1), {
      uppercase: false,
      noHyphens: false,
    });
    expect(first < second).toBe(true);
  });

  it('格式化：大写 / 去连字符', () => {
    const hex = '00112233445566778899aabbccddeeff';
    expect(formatUuid(hex, { uppercase: false, noHyphens: false })).toBe(
      '00112233-4455-6677-8899-aabbccddeeff'
    );
    expect(formatUuid(hex, { uppercase: true, noHyphens: false })).toBe(
      '00112233-4455-6677-8899-AABBCCDDEEFF'
    );
    expect(formatUuid(hex, { uppercase: false, noHyphens: true })).toBe(hex);
    expect(uuidVersion('not-a-uuid')).toBeNull();
  });
});
