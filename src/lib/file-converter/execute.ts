// ─────────────────────────────────────────────────────────────────────────────
// file-converter/execute.ts —— 页面侧执行体：解析边 → 预算预检 → 跑 runner →
// 输出复核（非空 + 字节与声明格式一致）。ConverterApp 把它注入 ConvertQueue。
//
// 【纪律】成功判据 = 退出正常 + 输出非空 + 字节复核通过（plan §6.4）。
// 复核不过 = 失败，不交付半成品。
// ─────────────────────────────────────────────────────────────────────────────

import { LIMITS } from './formats';
import { verifyOutputBytes } from './inspect-client';
import { makeTask, type Executor, type ExecutorApi } from './queue';
import { edgeById } from './registry';
import type { CapabilityReport, CategoryDef, ConvertResultData, ConvertTask, EdgeDef, InspectInfo } from './types';
import { classifyError, convertedName } from './utils';

export function makeExecutor(
  categories: CategoryDef[],
  getCapabilities: () => CapabilityReport
): Executor {
  return async (task: ConvertTask, api: ExecutorApi): Promise<ConvertResultData> => {
    const edge = edgeById(categories, task.edgeId);
    if (!edge) throw { kind: 'unsupported', message: `找不到转换目标 ${task.edgeId}` } as const;
    if (edge.status === 'planned' || typeof edge.run !== 'function') {
      throw { kind: 'capability', message: '该方向尚未开放' } as const;
    }

    // 输出预算预检（估得出且必超的提前拒绝）
    if (edge.estimateOutput && task.inspect) {
      const est = edge.estimateOutput(task.inspect, task.params);
      if (est !== null && est > LIMITS.queue.maxOutputEach) {
        throw {
          kind: 'budget',
          message: `预计输出约 ${Math.round(est / 1024 / 1024)} MiB，超过单文件上限`,
        } as const;
      }
    }

    try {
      const result = await edge.run({
        file: task.files[0],
        files: task.files,
        inspect: task.inspect,
        params: task.params,
        signal: api.signal,
        onProgress: api.onProgress,
        onPhase: api.onPhase,
        capabilities: getCapabilities(),
      });

      // 输出复核：非空 + 字节与声明一致
      if (!result.outputs.length) throw { kind: 'unknown', message: '没有产生输出' } as const;
      for (const out of result.outputs) {
        if (out.blob.size === 0) throw { kind: 'unknown', message: '输出为空' } as const;
        const ok = await verifyOutputBytes(out.blob, result.ext);
        if (!ok) {
          throw {
            kind: 'unknown',
            message: '输出内容与声明格式不一致，未交付',
            detail: `声明 .${result.ext}，实际嗅探不符`,
          } as const;
        }
      }
      return result;
    } catch (e) {
      throw classifyError(e, `${edge.label} 失败`);
    }
  };
}

/** 为一批准文件建任务（单文件边一文件一任务；多文件边整批一个任务）。 */
export function tasksForBatch(
  edge: EdgeDef,
  category: CategoryDef,
  files: { file: File; inspect: InspectInfo }[],
  params: Record<string, unknown>
): ConvertTask[] {
  if (category.maxFilesPerTask > 1 && files.length > 1) {
    return [
      makeTask({
        category: category.key,
        edgeId: edge.id,
        fileName: `${files[0].file.name} 等 ${files.length} 个文件`,
        fileSize: files.reduce((s, f) => s + f.file.size, 0),
        files: files.map((f) => f.file),
        params: { ...params },
        inspect: files[0].inspect,
      }),
    ];
  }
  return files.map((f) =>
    makeTask({
      category: category.key,
      edgeId: edge.id,
      fileName: f.file.name,
      fileSize: f.file.size,
      files: [f.file],
      params: { ...params },
      inspect: f.inspect,
    })
  );
}

export { convertedName };
