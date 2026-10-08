// ─────────────────────────────────────────────────────────────────────────────
// file-converter/queue.ts —— 共用任务调度器（零依赖、纯逻辑）
//
// 【它做什么】plan §6.3 / §7：图片与音频（以及所有能力区）共用一个**串行**执行
// 调度器；取消 / 重试走任务代次（gen）；输出预算不足时队列进入明确的暂停状态。
//
// 【为什么独立于引擎】调度策略（串行、代次、预算暂停）与「怎么转换」完全无关，
// 抽出来才能在 node 里用假执行体把串行 / 取消 / 重试 / 预算钉死。
//
// 【纪律】
//   · 不 import DOM / 引擎；File / Blob 只作类型出现。
//   · 每个异步回调校验 task id + gen（isCurrent），旧代次不得覆盖新状态。
//   · 执行体（executor）由调用方注入；队列不感知引擎差异。
// ─────────────────────────────────────────────────────────────────────────────

import { LIMITS } from './formats';
import type { ConvertError, ConvertResultData, ConvertTask, QueueSnapshot, TaskStatus } from './types';

export interface ExecutorApi {
  signal: AbortSignal;
  onProgress: (p: number | null, message?: string) => void;
  onPhase: (phase: TaskStatus) => void;
}

export type Executor = (task: ConvertTask, api: ExecutorApi) => Promise<ConvertResultData>;

export interface QueueHooks {
  /** 任何任务字段变化后调用（页面 setState）。传入快照。 */
  onChange: (snap: QueueSnapshot) => void;
}

let nextSeq = 1;

export function makeTask(
  partial: Omit<ConvertTask, 'id' | 'gen' | 'status' | 'progress' | 'heldOutputBytes'>
): ConvertTask {
  return {
    ...partial,
    id: `t${nextSeq++}-${partial.fileName.length}`,
    gen: 0,
    status: 'validating',
    progress: null,
    heldOutputBytes: 0,
  };
}

export class ConvertQueue {
  private tasks: ConvertTask[] = [];
  private controllers = new Map<string, AbortController>();
  private activeId: string | null = null;
  private budgetPaused = false;
  private pumping = false;

  constructor(
    private executor: Executor,
    private hooks: QueueHooks
  ) {}

  snapshot(): QueueSnapshot {
    return {
      tasks: this.tasks.map((t) => ({ ...t })),
      activeId: this.activeId,
      budgetPaused: this.budgetPaused,
      heldOutputTotal: this.heldOutputTotal(),
    };
  }

  private emit() {
    this.hooks.onChange(this.snapshot());
  }

  get(id: string): ConvertTask | undefined {
    return this.tasks.find((t) => t.id === id);
  }

  isCurrent(id: string, gen: number): boolean {
    const t = this.get(id);
    return !!t && t.gen === gen && t.status !== 'cancelled' && t.status !== 'failed';
  }

  private heldOutputTotal(): number {
    return this.tasks.reduce((s, t) => s + (t.status === 'succeeded' ? t.heldOutputBytes : 0), 0);
  }

  /** 任务总数与输入总额闸（plan §7.1）。返回 null 表示可入队。 */
  admitError(files: File[]): string | null {
    const alive = this.tasks.filter((t) => t.status !== 'failed' && t.status !== 'cancelled');
    if (alive.length >= LIMITS.queue.maxTasks) {
      return `同时最多处理 ${LIMITS.queue.maxTasks} 个任务，请先移除已完成或失败的任务`;
    }
    const held = alive.reduce((s, t) => s + t.fileSize, 0);
    const incoming = files.reduce((s, f) => s + f.size, 0);
    if (held + incoming > LIMITS.queue.maxHeldInputs) {
      return '持有输入总量超限，请先释放已有结果';
    }
    return null;
  }

  /** 加入队列（校验通过后 queued）。 */
  enqueue(task: ConvertTask) {
    task.status = 'queued';
    this.tasks.push(task);
    this.emit();
    void this.pump();
  }

  /**
   * 标记校验失败（validating → failed），不进执行队列。
   * 校验阶段发现的问题（超限 / 不支持）走这里。
   */
  failValidation(task: ConvertTask, error: ConvertError) {
    task.status = 'failed';
    task.error = error;
    this.tasks.push(task);
    this.emit();
  }

  private nextQueued(): ConvertTask | undefined {
    return this.tasks.find((t) => t.status === 'queued');
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      for (;;) {
        const task = this.nextQueued();
        if (!task) return;

        // 输出预算闸：估得出且必超的，提前拒；总额紧张的，暂停等用户释放
        if (this.heldOutputTotal() >= LIMITS.queue.maxOutputTotal) {
          this.budgetPaused = true;
          this.emit();
          return;
        }
        this.budgetPaused = false;

        this.activeId = task.id;
        const gen = task.gen;
        const controller = new AbortController();
        this.controllers.set(task.id, controller);

        const api: ExecutorApi = {
          signal: controller.signal,
          onProgress: (p, message) => {
            if (!this.isCurrent(task.id, gen)) return;
            task.progress = p;
            if (message !== undefined) task.message = message;
            this.emit();
          },
          onPhase: (phase) => {
            if (!this.isCurrent(task.id, gen)) return;
            task.status = phase;
            task.progress = null;
            this.emit();
          },
        };

        try {
          const result = await this.executor(task, api);
          if (!this.isCurrent(task.id, gen)) continue; // 已取消 / 已被重试取代
          // 输出预算复核（plan §7.1：实际超额则丢弃结果，不长期持有）
          if (result.outputSize > LIMITS.queue.maxOutputEach) {
            task.status = 'failed';
            task.error = {
              kind: 'budget',
              message: `输出 ${Math.round(result.outputSize / 1024 / 1024)} MiB 超过单文件上限，结果未保留`,
            };
            this.emit();
            continue;
          }
          task.result = result;
          task.heldOutputBytes = result.outputSize;
          task.status = 'succeeded';
          task.progress = 1;
          this.emit();
        } catch (e) {
          if (!this.isCurrent(task.id, gen)) continue;
          const err = e as { kind?: ConvertError['kind']; message?: string; detail?: string };
          task.status = 'failed';
          task.error = {
            kind: err.kind ?? 'unknown',
            message: err.message ?? '转换失败',
            detail: err.detail,
          };
          this.emit();
        } finally {
          this.controllers.delete(task.id);
          if (this.activeId === task.id) this.activeId = null;
        }
      }
    } finally {
      this.pumping = false;
      this.emit();
    }
  }

  /** 取消：终止执行中的任务，或把排队中的任务标为已取消。 */
  cancel(id: string) {
    const t = this.get(id);
    if (!t) return;
    // ⚠️ 先判 active 再判 queued：执行体还没调 onPhase 时任务 status 仍是 'queued'，
    // 但它其实已经在跑（activeId 指着它）。顺序反了 = 不 abort，ffmpeg 之类会
    // 在后台把整个转码跑完，界面却显示「已取消」。
    if (this.activeId === id) {
      this.controllers.get(id)?.abort();
      // 状态由执行体的取消回调落地（它会 reject），这里直接标记，防止旧结果覆盖
      t.status = 'cancelled';
      t.gen++;
      this.emit();
      return;
    }
    if (t.status === 'queued') {
      t.status = 'cancelled';
      this.emit();
      return;
    }
  }

  /** 重试：新代次重新入队。失败 / 取消 / 成功（换参数重转）都走这里。 */
  retry(id: string, params?: Record<string, unknown>) {
    const old = this.get(id);
    if (!old) return;
    this.releaseResult(id);
    old.gen++;
    old.status = 'queued';
    old.progress = null;
    old.error = undefined;
    old.result = undefined;
    old.message = undefined;
    if (params) old.params = { ...params };
    this.emit();
    void this.pump();
  }

  /**
   * 释放结果（plan §7.2：用户主动移除或离开页面时释放）。
   * ⚠️ 这里只清引用与预算 —— 预览 / 下载用的 Blob URL 由页面层的 URL 登记表
   * 跟踪并 revoke（队列不感知 URL，别在这里 revoke）。
   */
  releaseResult(id: string) {
    const t = this.get(id);
    if (!t?.result) return;
    t.result = undefined;
    t.heldOutputBytes = 0;
    if (this.budgetPaused) {
      this.budgetPaused = false;
      void this.pump();
    }
    this.emit();
  }

  /** 移除任务（含释放结果）。执行中的先取消。 */
  remove(id: string) {
    const t = this.get(id);
    if (!t) return;
    if (this.activeId === id || t.status === 'queued') this.cancel(id);
    this.releaseResult(id);
    this.tasks = this.tasks.filter((x) => x.id !== id);
    this.emit();
    void this.pump();
  }

  /** 取消整批（plan §5.2：转换期间可取消当前任务或整批）。 */
  cancelAll() {
    for (const t of this.tasks) {
      if (t.status === 'queued') t.status = 'cancelled';
    }
    if (this.activeId) this.cancel(this.activeId);
    this.emit();
  }

  /** 预算暂停解除后继续（页面在释放结果后调用）。 */
  resume() {
    if (this.budgetPaused) {
      this.budgetPaused = false;
      void this.pump();
    }
  }
}
