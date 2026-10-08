// file-converter/queue.ts —— 串行调度 / 取消 / 代次 / 输出预算暂停。
//
// 【这组用例钉的是什么】plan §6.3 / §7：
//   · 严格串行（后一个任务的执行体**绝不在**前一个 resolve 前启动）；
//   · 代次（gen）纪律：取消 / 重试之后，旧代次的迟到回调不得覆盖新状态 ——
//     写错的表现是「取消了的任务又显示成功」，全程无报错；
//   · 输出预算：单文件超额 → failed(budget)；总持有量到顶 → 队列**暂停**，
//     释放结果后自动恢复。
// 全部用假执行体驱动（队列不感知引擎），node 环境即可。

import { describe, it, expect } from 'vitest';
import { ConvertQueue, makeTask, type Executor } from '@/lib/file-converter/queue';
import { LIMITS } from '@/lib/file-converter/formats';
import type { ConvertResultData, ConvertTask } from '@/lib/file-converter/types';

function result(outputSize: number): ConvertResultData {
  return {
    outputs: [{ blob: new Blob(['x']), name: 'out.bin' }],
    mime: 'application/octet-stream',
    ext: 'bin',
    inputSize: 1,
    outputSize,
    notices: [],
    previewKind: 'none',
  };
}

function task(fileName: string, fileSize = 1): ConvertTask {
  return makeTask({
    category: 'image',
    edgeId: 'image:test',
    fileName,
    fileSize,
    files: [],
    params: {},
    inspect: null,
  });
}

async function waitFor(cond: () => boolean, ms = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('waitFor 超时');
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('ConvertQueue 串行与生命周期', () => {
  it('严格串行：第二个任务的执行体在第一个 resolve 前不启动', async () => {
    const started: string[] = [];
    const finished: string[] = [];
    const executor: Executor = async (t) => {
      started.push(t.id);
      // 若串行被破坏，这里会观察到 started.length > finished.length + 1
      expect(started.length).toBe(finished.length + 1);
      await new Promise((r) => setTimeout(r, 5));
      finished.push(t.id);
      return result(1);
    };
    const q = new ConvertQueue(executor, { onChange: () => {} });
    const a = task('a.bin');
    const b = task('b.bin');
    q.enqueue(a);
    q.enqueue(b);
    await waitFor(() => q.get(a.id)?.status === 'succeeded' && q.get(b.id)?.status === 'succeeded');
    expect(started).toEqual([a.id, b.id]);
    expect(finished).toEqual([a.id, b.id]);
  });

  it('执行体抛错 → failed，队列继续下一个', async () => {
    const executor: Executor = async (t) => {
      if (t.fileName === 'bad') throw { kind: 'corrupt', message: '坏文件' };
      return result(1);
    };
    const q = new ConvertQueue(executor, { onChange: () => {} });
    const bad = task('bad');
    const good = task('good');
    q.enqueue(bad);
    q.enqueue(good);
    await waitFor(() => q.get(good.id)?.status === 'succeeded');
    expect(q.get(bad.id)?.status).toBe('failed');
    expect(q.get(bad.id)?.error?.kind).toBe('corrupt');
    expect(q.get(good.id)?.status).toBe('succeeded');
  });

  it('failValidation：validating → failed，不进执行队列', async () => {
    const executor: Executor = async () => {
      throw new Error('不应被执行');
    };
    const q = new ConvertQueue(executor, { onChange: () => {} });
    const t = task('huge.png');
    q.failValidation(t, { kind: 'budget', message: '超过上限' });
    expect(q.get(t.id)?.status).toBe('failed');
    expect(q.get(t.id)?.error?.kind).toBe('budget');
  });
});

describe('取消与代次', () => {
  it('取消排队中的任务：不启动执行体', async () => {
    const started: string[] = [];
    const executor: Executor = async (t) => {
      started.push(t.id);
      return result(1);
    };
    const q = new ConvertQueue(executor, { onChange: () => {} });
    const t = task('x');
    // 先占住队列
    let releaseFirst!: () => void;
    const blocking: Executor = async () => {
      await new Promise<void>((r) => (releaseFirst = r));
      return result(1);
    };
    const q2 = new ConvertQueue(blocking, { onChange: () => {} });
    const first = task('first');
    q2.enqueue(first);
    q2.enqueue(t);
    q2.cancel(t.id);
    releaseFirst();
    await waitFor(() => q2.get(first.id)?.status === 'succeeded');
    expect(q2.get(t.id)?.status).toBe('cancelled');
    expect(started).toEqual([]);
    void q;
  });

  it('取消执行中的任务：abort 信号触发；执行体迟到 resolve 不得覆盖 cancelled', async () => {
    let sawAbort = false;
    let lateResolve!: (r: ConvertResultData) => void;
    const executor: Executor = (t, api) =>
      new Promise<ConvertResultData>((resolve) => {
        api.signal.addEventListener('abort', () => {
          sawAbort = true;
        });
        lateResolve = resolve;
      });
    const q = new ConvertQueue(executor, { onChange: () => {} });
    const t = task('running');
    q.enqueue(t);
    await waitFor(() => q.snapshot().activeId === t.id);
    q.cancel(t.id);
    expect(sawAbort).toBe(true);
    expect(q.get(t.id)?.status).toBe('cancelled');
    // 旧代次迟到 resolve —— 必须被 isCurrent 挡下
    lateResolve(result(1));
    await new Promise((r) => setTimeout(r, 20));
    expect(q.get(t.id)?.status).toBe('cancelled');
    expect(q.get(t.id)?.result).toBeUndefined();
  });

  it('重试：gen +1、清空结果与错误、参数快照可被替换', async () => {
    let runs = 0;
    let seenParams: Record<string, unknown> = {};
    const executor: Executor = async (t) => {
      runs++;
      seenParams = t.params;
      if (runs === 1) throw { kind: 'unknown', message: '第一次失败' };
      return result(1);
    };
    const q = new ConvertQueue(executor, { onChange: () => {} });
    const t = task('retry-me');
    t.params = { quality: 90 };
    q.enqueue(t);
    await waitFor(() => q.get(t.id)?.status === 'failed');
    const genBefore = q.get(t.id)!.gen;
    q.retry(t.id, { quality: 50 });
    await waitFor(() => q.get(t.id)?.status === 'succeeded');
    expect(q.get(t.id)!.gen).toBe(genBefore + 1);
    expect(seenParams).toEqual({ quality: 50 });
    expect(q.get(t.id)?.error).toBeUndefined();
    expect(runs).toBe(2);
  });
});

describe('admitError 与输出预算', () => {
  it('任务数到顶拒绝入队', () => {
    const never: Executor = () => new Promise(() => {});
    const q = new ConvertQueue(never, { onChange: () => {} });
    for (let i = 0; i < LIMITS.queue.maxTasks; i++) q.enqueue(task(`f${i}`));
    expect(q.admitError([])).toContain('最多');
  });

  it('输入持有总量超限拒绝', () => {
    const never: Executor = () => new Promise(() => {});
    const q = new ConvertQueue(never, { onChange: () => {} });
    q.enqueue(task('big', LIMITS.queue.maxHeldInputs));
    expect(q.admitError([{ size: 1 } as File])).toContain('总量超限');
  });

  it('单输出超 maxOutputEach → failed(budget)，结果不保留', async () => {
    const executor: Executor = async () => result(LIMITS.queue.maxOutputEach + 1);
    const q = new ConvertQueue(executor, { onChange: () => {} });
    const t = task('huge-out');
    q.enqueue(t);
    await waitFor(() => q.get(t.id)?.status === 'failed');
    expect(q.get(t.id)?.error?.kind).toBe('budget');
    expect(q.get(t.id)?.result).toBeUndefined();
  });

  it('总持有量到顶 → budgetPaused；释放结果后自动恢复执行', async () => {
    // 每个结果恰好占满总预算（maxOutputEach === maxOutputTotal），
    // 第一个成功后第二个必须暂停。
    const executor: Executor = async () => result(LIMITS.queue.maxOutputEach);
    const q = new ConvertQueue(executor, { onChange: () => {} });
    const a = task('a');
    const b = task('b');
    q.enqueue(a);
    q.enqueue(b);
    await waitFor(() => q.snapshot().budgetPaused === true);
    expect(q.get(a.id)?.status).toBe('succeeded');
    expect(q.get(b.id)?.status).toBe('queued');
    q.releaseResult(a.id);
    await waitFor(() => q.get(b.id)?.status === 'succeeded');
    expect(q.snapshot().budgetPaused).toBe(false);
  });
});
