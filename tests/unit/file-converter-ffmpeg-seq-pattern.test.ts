// ─────────────────────────────────────────────────────────────────────────────
// file-converter-ffmpeg-seq-pattern.test.ts —— 串输出模式的展开（纯函数部分）
//
// 【为什么单独钉它】抽帧类边（video:to-frames / image:anim-to-frames）传的是
// **模式**（frame-%04d.png），而 ffmpeg 写出的是真实文件名。展开这一层错了，
// 症状是「退出码 0，但结果里一个文件都没有」—— 转换看起来成功、结果区空着，
// 没有任何报错指向这里。所以它必须由单测钉住，而不是只靠 e2e 兜。
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, vi } from 'vitest';
import { expandOutputNames, expandSeqPattern } from '@/lib/file-converter/engines/ffmpeg';

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

describe('expandOutputNames —— 对 MEMFS 列目录的包装', () => {
  it('★ 字面名原样返回，且**一次目录都不列** ★', async () => {
    // 这条钉的是一个真实事故：早先对每个名字都先 listDir(dir)，字面名的 dir 是
    // **空串**，MEMFS 的 readdir('') 抛错 → 那个名字被 `continue` 丢掉 →
    // exec 回读到空 Map → 所有不带 % 的转换都报「未产生有效输出」。
    // listDir 直接抛异常来模拟那个「空串」场景：字面名绝不能被它影响。
    const listDir = vi.fn(async () => {
      throw new Error("ENOENT: no such file or directory, readdir ''");
    });
    await expect(expandOutputNames({ listDir }, ['out.flac'])).resolves.toEqual(['out.flac']);
    expect(listDir).not.toHaveBeenCalled();
  });

  it('模式串才列目录，并按帧序展开（含子目录前缀还原）', async () => {
    const listDir = vi.fn(async (dir: string) =>
      dir === 'frames'
        ? [
            { name: 'frame-0002.png', isDir: false },
            { name: 'frame-0001.png', isDir: false },
            { name: 'somedir', isDir: true },
          ]
        : []
    );
    await expect(
      expandOutputNames({ listDir }, ['frames/frame-%04d.png'])
    ).resolves.toEqual(['frames/frame-0001.png', 'frames/frame-0002.png']);
  });

  it('字面名与模式串混排时各自安好', async () => {
    const listDir = vi.fn(async () => [{ name: 'f-001.png', isDir: false }]);
    await expect(expandOutputNames({ listDir }, ['log.txt', 'f-%03d.png'])).resolves.toEqual([
      'log.txt',
      'f-001.png',
    ]);
  });
});
