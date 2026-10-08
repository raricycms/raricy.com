// file-converter/utils.ts —— 命名 / 错误归类 / 页码范围解析。
//
// 【这组用例钉的是什么】
//   · 输出名的消毒与去重（下载名是用户可见面，错一格就是乱码或撞名覆盖）；
//   · classifyError 的归类 —— 引擎 stderr 文案杂乱，归错类 = 用户看到错误的建议；
//   · parsePageRange 的边界 —— PDF 选页是「1-3,5,8-」语法，语法错必须返回 null
//     （让调用方提示），而不是静默忽略。

import { describe, it, expect } from 'vitest';
import {
  sanitizeBase,
  uniqueOutputName,
  convertedName,
  classifyError,
  clamp,
  parsePositiveInt,
  parsePageRange,
  withTimeout,
} from '@/lib/file-converter/utils';

describe('sanitizeBase', () => {
  it('去掉路径前缀（两种分隔符）', () => {
    expect(sanitizeBase('a/b/c.png')).toBe('c');
    expect(sanitizeBase('C:\\Users\\x\\y.jpg')).toBe('y');
  });

  it('去扩展名、控制字符与引号', () => {
    expect(sanitizeBase('我的"文件".jpg')).toBe('我的文件');
    expect(sanitizeBase('ab\x00\x1f\x7fc.png')).toBe('abc');
  });

  it('空名给占位，超长截断', () => {
    expect(sanitizeBase('')).toBe('file');
    expect(sanitizeBase('...')).toBe('file');
    expect(sanitizeBase('x'.repeat(120) + '.png')).toHaveLength(80);
  });

  it('保留 Unicode 与点前的空格', () => {
    expect(sanitizeBase('年度报告 2026.pdf')).toBe('年度报告 2026');
  });
});

describe('uniqueOutputName / convertedName', () => {
  it('重复名自动加序号', () => {
    const taken = new Set<string>();
    expect(uniqueOutputName('a', 'jpg', taken)).toBe('a.jpg');
    expect(uniqueOutputName('a', 'jpg', taken)).toBe('a-2.jpg');
    expect(uniqueOutputName('a', 'jpg', taken)).toBe('a-3.jpg');
  });

  it('convertedName 是 <原名>-converted.<ext> 且参与去重', () => {
    const taken = new Set<string>();
    expect(convertedName('录音.wav', 'mp3', taken)).toBe('录音-converted.mp3');
    expect(convertedName('录音.wav', 'mp3', taken)).toBe('录音-converted-2.mp3');
  });
});

describe('classifyError', () => {
  it('已是 ConvertError 的原样透传', () => {
    const e = { kind: 'corrupt' as const, message: '坏文件', detail: 'x' };
    expect(classifyError(e, '兜底')).toEqual(e);
  });

  it('abort / timeout / memory / corrupt 各归各类', () => {
    expect(classifyError(new Error('Aborted'), 'x').kind).toBe('cancelled');
    expect(classifyError(Object.assign(new Error('killed'), { name: 'AbortError' }), 'x').kind).toBe('cancelled');
    expect(classifyError(new Error('timeout of 15s'), 'x').kind).toBe('timeout');
    expect(classifyError(new Error('out of memory'), 'x').kind).toBe('budget');
    expect(classifyError(new Error('moov atom not found'), 'x').kind).toBe('corrupt');
    expect(classifyError(new Error('???'), 'x').kind).toBe('unknown');
  });

  it('归类失败时用兜底文案、原文进 detail（截断 500 字）', () => {
    const long = 'z'.repeat(1000);
    const r = classifyError(new Error(long), '转换失败');
    expect(r.message).toBe('转换失败');
    expect(r.detail).toHaveLength(500);
  });
});

describe('clamp / parsePositiveInt', () => {
  it('clamp 两端收敛', () => {
    expect(clamp(5, 1, 10)).toBe(5);
    expect(clamp(-1, 1, 10)).toBe(1);
    expect(clamp(11, 1, 10)).toBe(10);
  });

  it('parsePositiveInt 拒绝零、负、非数', () => {
    expect(parsePositiveInt('3')).toBe(3);
    expect(parsePositiveInt(4.9)).toBe(4);
    expect(parsePositiveInt('0')).toBeNull();
    expect(parsePositiveInt(-2)).toBeNull();
    expect(parsePositiveInt('abc')).toBeNull();
  });
});

describe('parsePageRange', () => {
  it('空串 = 全部页', () => {
    expect(parsePageRange('', 4)).toEqual([1, 2, 3, 4]);
    expect(parsePageRange('   ', 2)).toEqual([1, 2]);
  });

  it('区间 / 单页 / 开口区间组合，去重且排序', () => {
    expect(parsePageRange('1-3,5,8-', 10)).toEqual([1, 2, 3, 5, 8, 9, 10]);
    expect(parsePageRange('3,1-3,2', 10)).toEqual([1, 2, 3]);
  });

  it('语法错 / 越界 / 倒序区间返回 null', () => {
    expect(parsePageRange('abc', 10)).toBeNull();
    expect(parsePageRange('0', 10)).toBeNull();
    expect(parsePageRange('11', 10)).toBeNull();
    expect(parsePageRange('5-2', 10)).toBeNull();
    expect(parsePageRange('1-99', 10)).toBeNull();
  });
});

describe('withTimeout', () => {
  it('按时完成返回值；超时 reject kind=timeout', async () => {
    await expect(withTimeout(Promise.resolve(1), 50, 'x')).resolves.toBe(1);
    const slow = new Promise((r) => setTimeout(r, 5000));
    await expect(withTimeout(slow, 10, '太慢')).rejects.toMatchObject({
      kind: 'timeout',
      message: '太慢',
    });
  });
});
