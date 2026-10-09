// ─────────────────────────────────────────────────────────────────────────────
// file-converter-ffmpeg-seq-pattern.test.ts —— 串输出模式的展开（纯函数部分）
//
// 【为什么单独钉它】抽帧类边（video:to-frames / image:anim-to-frames）传的是
// **模式**（frame-%04d.png），而 ffmpeg 写出的是真实文件名。展开这一层错了，
// 症状是「退出码 0，但结果里一个文件都没有」—— 转换看起来成功、结果区空着，
// 没有任何报错指向这里。所以它必须由单测钉住，而不是只靠 e2e 兜。
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from 'vitest';
import { expandSeqPattern } from '@/lib/file-converter/engines/ffmpeg';

describe('expandSeqPattern —— 串输出模式展开', () => {
  it('没有占位符 → null（调用方按字面名处理）', () => {
    expect(expandSeqPattern('out.mp4', ['out.mp4'])).toBeNull();
    expect(expandSeqPattern('plain.png', ['plain.png'])).toBeNull();
  });

  it('%04d 只认四位数，且按帧序（数值）排序', () => {
    const got = expandSeqPattern('frame-%04d.png', [
      'frame-0010.png',
      'frame-0002.png',
      'frame-0001.png',
    ]);
    expect(got).toEqual(['frame-0001.png', 'frame-0002.png', 'frame-0010.png']);
  });

  it('不匹配的名字被排除（其它任务的残留 / 扩展名不符）', () => {
    const got = expandSeqPattern('frame-%04d.png', [
      'frame-0001.png',
      'frame-0001.jpg',
      'other-0002.png',
      'frame-x.png',
    ]);
    expect(got).toEqual(['frame-0001.png']);
  });

  it('宽度是硬判据：位数不足或溢出都不匹配', () => {
    // 三位数（ffmpeg 不会在 %04d 下产出）→ 不匹配
    expect(expandSeqPattern('f-%04d.png', ['f-001.png'])).toEqual([]);
    // 五位数（帧数溢出后 ffmpeg 会改用更宽的名字）→ 不匹配，宁可报「没产出」
    // 也不去错配一个可能属于别的任务的文件
    expect(expandSeqPattern('f-%04d.png', ['f-00001.png'])).toEqual([]);
  });

  it('无宽度 %d 认任意位数', () => {
    expect(expandSeqPattern('f-%d.png', ['f-1.png', 'f-42.png', 'f-1000.png'])).toEqual([
      'f-1.png',
      'f-42.png',
      'f-1000.png',
    ]);
  });

  it('只替换一个占位符，其余部分按字面匹配（含正则元字符）', () => {
    const got = expandSeqPattern('a+b.%03d.png', ['a+b.001.png', 'axb.001.png']);
    expect(got).toEqual(['a+b.001.png']);
  });

  it('一个都没匹配上 → 空数组（不是 null）', () => {
    expect(expandSeqPattern('frame-%04d.png', ['nope.txt'])).toEqual([]);
  });
});
