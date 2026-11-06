// dev-tools-response-read.test.ts —— R3-473 抽共享读取件后的「一个解析口径」断言
//
// 7 个 dev-tools 与 3 个联网工具此前各抄一份 errorText / asRecord / readString /
// readNumber；同一份第三方 JSON 的防御多份副本时，改一处口径不会让另一处红。
// 收成 src/lib/dev-tools/response-read.ts 之后，这里钉住它的四条语义（含「不编值」）。
import { describe, expect, it } from 'vitest';
import { asRecord, errorText, readNumber, readString } from '@/lib/dev-tools/response-read';

describe('dev-tools 响应读取件（单一口径）', () => {
  it('errorText：Error.message 优先，否则用调用方的兜底（三条兜底文案由调用方给）', () => {
    expect(errorText(new Error('网络错误'))).toBe('网络错误');
    expect(errorText(new Error(''))).toBe('未知错误');
    expect(errorText('boom')).toBe('未知错误');
    expect(errorText(null)).toBe('未知错误');
    expect(errorText(null, '非法输入')).toBe('非法输入');
    expect(errorText(new Error(''), '操作失败，请检查密钥、IV 与密文格式')).toBe(
      '操作失败，请检查密钥、IV 与密文格式'
    );
  });

  it('asRecord：只认非数组对象，其余一律 null', () => {
    const obj = { a: 1 };
    expect(asRecord(obj)).toBe(obj);
    for (const bad of [null, undefined, 'x', 1, true, [], [1], [{}]]) {
      expect(asRecord(bad)).toBeNull();
    }
  });

  it('readString / readNumber：类型不符或非有限数都给空值，不编 0', () => {
    const src: Record<string, unknown> = {
      s: 'x',
      n: 2,
      nan: Number.NaN,
      inf: Number.POSITIVE_INFINITY,
      numStr: '7',
      missing: undefined,
    };
    expect(readString(src, 's')).toBe('x');
    expect(readString(src, 'n')).toBe('');
    expect(readString(src, 'missing')).toBe('');
    expect(readNumber(src, 'n')).toBe(2);
    expect(readNumber(src, 'nan')).toBeNull();
    expect(readNumber(src, 'inf')).toBeNull();
    expect(readNumber(src, 'numStr')).toBeNull();
    expect(readNumber(src, 'missing')).toBeNull();
  });
});
