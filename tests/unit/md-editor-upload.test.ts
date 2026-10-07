// @vitest-environment jsdom
// ─────────────────────────────────────────────────────────────────────────────
// md-editor-upload.test.ts —— 一批文件怎么排队、怎么筛、超限怎么拒
//
// 【这些判据为什么值得钉】它们全都决定「用户看到什么」，且都不发请求：
//   · 体积闸门必须在**任何网络动作之前**拦下。放过去的话，超限的 body 到服务端
//     只会变成看不懂的「无效的上传请求」（Next 中间件静默截断）或 413 HTML
//     —— 用户看到的是一句和自己做的事毫无关系的报错；
//   · 闸门只算「确实会发出去的那些」：把远超单张上限的、非图片的一起算进总和，
//     会让一整批本来合法的图被误伤拒掉；
//   · 拖拽进来的文字/链接 item 取不到 File（getAsFile() 返回 null），
//     漏挡就是一次 TypeError，表现是「拖进去什么都没发生」。
// ─────────────────────────────────────────────────────────────────────────────

import { describe, expect, it, vi } from 'vitest';
import {
  MAX_CONCURRENT_UPLOADS,
  gateUploadBatch,
  imageMarkdown,
  isAcceptableImage,
  normalizeDroppedFiles,
  precheckFile,
  runLimited,
} from '@/lib/md-editor/upload';

const MB = 1024 * 1024;

/** 造一个指定大小的 File（内容无所谓，size 才是指纹）。 */
function file(name: string, type: string, size: number): File {
  const f = new File(['x'], name, { type });
  Object.defineProperty(f, 'size', { value: size });
  return f;
}

describe('单文件判据', () => {
  it('白名单里的四种位图收，SVG 不收', () => {
    expect(isAcceptableImage(file('a.png', 'image/png', 100))).toBe(true);
    expect(isAcceptableImage(file('a.jpg', 'image/jpeg', 100))).toBe(true);
    expect(isAcceptableImage(file('a.webp', 'image/webp', 100))).toBe(true);
    expect(isAcceptableImage(file('a.svg', 'image/svg+xml', 100))).toBe(false);
  });

  it('零字节的"文件"不算（浏览器有时会给一个空壳）', () => {
    expect(isAcceptableImage(file('a.png', 'image/png', 0))).toBe(false);
  });

  it('逐文件前置校验的文案与单文件上限一致', () => {
    expect(precheckFile(file('big.png', 'image/png', 10 * MB + 1))).toBe('图片不能超过 10MB');
    expect(precheckFile(file('a.svg', 'image/svg+xml', 100))).toBe('仅支持 PNG / JPEG / GIF / WebP');
    expect(precheckFile(file('a.png', 'image/png', 100))).toBeNull();
  });
});

describe('拖拽 / 粘贴给的列表', () => {
  it('文字与链接 item 取不到 File —— 单独计数，不塞进 files', () => {
    const real = file('a.png', 'image/png', 10);
    const items = [
      real,
      { getAsFile: () => null }, // 拖进来的一段纯文本
      { getAsFile: () => null }, // 一个链接
      { getAsFile: () => file('b.png', 'image/png', 10) },
    ];
    const { files, nonFileCount } = normalizeDroppedFiles(items);
    expect(files.map((f) => f.name)).toEqual(['a.png', 'b.png']);
    expect(nonFileCount).toBe(2);
  });

  it('空列表不炸', () => {
    expect(normalizeDroppedFiles([])).toEqual({ files: [], nonFileCount: 0 });
  });
});

describe('总体积闸门', () => {
  it('超过 11MB 时拒掉，并给一句能照着做的提示', () => {
    const gate = gateUploadBatch([
      file('big1.png', 'image/png', 6 * MB),
      file('big2.png', 'image/png', 6 * MB),
    ]);
    expect(gate.ok).toBe(false);
    if (!gate.ok) {
      // 数字要与常量对得上（改 MAX_UPLOAD_REQUEST_BYTES 时这条会跟着红）
      expect(gate.message).toContain('一次最多上传 11MB');
      expect(gate.message).toContain('约 12MB');
      expect(gate.message).toContain('分批');
    }
  });

  it('恰好 11MB 放行（判据是「大于」）', () => {
    const gate = gateUploadBatch([file('a.png', 'image/png', 11 * MB)]);
    expect(gate.ok).toBe(true);
  });

  it('远超单张上限的、非图片的**不计入**总和 —— 不误伤同批合法的图', () => {
    const gate = gateUploadBatch([
      file('a.png', 'image/png', 5 * MB),
      file('huge.png', 'image/png', 50 * MB), // 单张就超，本来就会被拒
      file('note.txt', 'text/plain', 40 * MB), // 非图片，本来就会被拒
    ]);
    expect(gate.ok).toBe(true);
    if (gate.ok) {
      // 但仍然要原样交给下游：调用方会为这两个各留一个失败槽位，
      // 让用户看到「第 2 张太大了」而不是「选了 3 张只进来 1 张」
      expect(gate.files).toHaveLength(3);
    }
  });

  it('一个文件都没有时是「空批」而不是错', () => {
    expect(gateUploadBatch([])).toEqual({ ok: true, files: [] });
  });
});

describe('有限并发的任务泵', () => {
  it('同时在飞的不超过上限：完成一个才放行下一个', async () => {
    let running = 0;
    let peak = 0;
    const started: number[] = [];
    /** 每个任务的手动闸门 —— 不让它自己完成，才能观察"谁在飞"。 */
    const pending = new Map<number, () => void>();

    const worker = (item: number) =>
      new Promise<void>((resolve) => {
        running += 1;
        peak = Math.max(peak, running);
        started.push(item);
        pending.set(item, () => {
          running -= 1;
          pending.delete(item);
          resolve();
        });
      });

    const settle = () => new Promise<void>((r) => setTimeout(r, 0));
    const finish = async (item: number) => {
      pending.get(item)!();
      await settle();
    };

    const done = runLimited([0, 1, 2, 3, 4], 2, worker);
    // 头一批只该起来 2 个（第 3 个要等有人让位）
    expect(started).toEqual([0, 1]);

    await finish(0);
    expect(started).toEqual([0, 1, 2]);
    await finish(1);
    expect(started).toEqual([0, 1, 2, 3]);
    await finish(2);
    expect(started).toEqual([0, 1, 2, 3, 4]);

    await finish(3);
    await finish(4);
    await done;
    expect(peak).toBe(2);
  });

  it('空列表立刻完成', async () => {
    await expect(runLimited([], 2, async () => {})).resolves.toBeUndefined();
  });

  it('并发上限是 2（改大只会让"谁先传完"更随机）', () => {
    expect(MAX_CONCURRENT_UPLOADS).toBe(2);
  });
});

describe('插入用的 Markdown', () => {
  it('形状与旧实现逐字一致：图片语法 + 一个换行（单张也有）', () => {
    expect(imageMarkdown('shot.png', '/api/images/abcdefghij/raw')).toBe(
      '![shot.png](/api/images/abcdefghij/raw)\n'
    );
  });
});
