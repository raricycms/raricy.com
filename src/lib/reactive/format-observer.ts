'use client';

// ─────────────────────────────────────────────────────────────────────────────
// format-observer.ts — 编辑器**逐键格式推导**的异步 / worker 公共契约
//
// 同步 `detectReactiveSyntax` 会完整编译一次；20 万字符高结构正文冷编译可达
// 数秒，绝不能放在 UI 线程的每次按键上。这里复用上游 `LocalCompileScheduler`：
//   · 编译（含 authoring analysis）在调用方提供的 worker 里跑；
//   · 历史 HTML 兼容扫描也在 worker 内（见 compile.worker.ts）；主线程只调度；
//   · 结果带调用方给的 revision，乱序到达时由调用方按 revision 丢弃；
//   · 新源码开始时，尚未完成的旧观察以 `effective: 'superseded'` 结束。
//
// 保存 / 自动保存应等待「当前源码 revision」的 `analyze()` 结果再提交 format；
// 不要拿旧 revision 的结果给新正文贴标签。
// ─────────────────────────────────────────────────────────────────────────────

import {
  LocalCompileScheduler,
  compileLocal,
  formatLocalDiagnostic,
  type LocalCompileWorker,
} from 'reactive-md';
import { reactiveCompileOptions } from './host-components';
import {
  classifyReactiveSyntax,
  finalizeReactiveDetection,
  type ReactiveSyntaxDetection,
} from './detect-format';

export type FormatEffective = 'reactive' | 'markdown' | 'invalid-enhanced' | 'superseded';

export interface FormattedDiagnostic {
  code: string;
  severity: 'error' | 'warning';
  /** 已本地化（zh）的可直接渲染文案。 */
  message: string;
  line: number;
  column: number;
  range: { start: number; end: number };
}

export interface FormatAnalysis {
  /** 调用方发起分析时给的修订号，原样带回。 */
  revision: number;
  /** `superseded` = 更新源码已开始分析，调用方应直接丢弃这条结果。 */
  effective: FormatEffective;
  valid: boolean;
  publishable: boolean;
  evidence: string[];
  /** 可点名给用户看的候选（组件 / 插值 / 声明等）。 */
  candidates: string[];
  codes: string[];
  diagnostics: FormattedDiagnostic[];
  declaredVersion: string | null;
  syntaxVersion: string | null;
}

export interface ReactiveFormatAnalyzerOptions {
  /** 调用方按自己的打包路径创建 `src/lib/reactive/compile.worker.ts`。 */
  createWorker(): LocalCompileWorker;
  /** 合并窗口；默认交给上游 150ms。 */
  delayMs?: number;
}

interface Pending {
  source: string;
  revision: number;
  resolve: (result: FormatAnalysis) => void;
}

function candidatesOf(detection: ReactiveSyntaxDetection): string[] {
  return detection.evidence.filter((item) => item !== 'bindings');
}

function toAnalysis(
  revision: number,
  detection: ReactiveSyntaxDetection
): FormatAnalysis {
  const effective: FormatEffective =
    detection.format === 'reactive'
      ? detection.valid
        ? 'reactive'
        : 'invalid-enhanced'
      : 'markdown';
  return {
    revision,
    effective,
    valid: detection.valid,
    publishable: detection.publishable,
    evidence: detection.evidence,
    candidates: candidatesOf(detection),
    codes: detection.codes,
    diagnostics: detection.diagnostics.map((diagnostic) => ({
      code: diagnostic.code,
      severity: diagnostic.severity,
      message: formatLocalDiagnostic(diagnostic, 'zh'),
      line: diagnostic.line,
      column: diagnostic.column,
      range: { start: diagnostic.range.start, end: diagnostic.range.end },
    })),
    declaredVersion: detection.declaredVersion,
    syntaxVersion: detection.syntaxVersion,
  };
}

/**
 * 可复用的格式分析器：一个编辑器实例一份；`dispose()` 终止 worker。
 */
export class ReactiveFormatAnalyzer {
  private readonly scheduler: LocalCompileScheduler;
  private readonly pending = new Map<string, Pending>();
  private disposed = false;
  private revisionFallback = 0;

  constructor(options: ReactiveFormatAnalyzerOptions) {
    this.scheduler = new LocalCompileScheduler({
      includeAuthorAnalysis: true,
      delay: options.delayMs,
      createWorker: options.createWorker,
      // worker 不可用时上游会回调这里；仍是异步调度，不在按键同步路径上。
      fallbackCompile: (source, compileOptions) =>
        compileLocal(source, compileOptions ?? reactiveCompileOptions('markdown')),
      onResult: (outcome) => {
        const entry = this.pending.get(outcome.source);
        if (!entry) return; // 已被更新源码取代
        this.pending.delete(outcome.source);
        entry.resolve(
          toAnalysis(
            entry.revision,
            finalizeReactiveDetection(
              classifyReactiveSyntax(entry.source, outcome.result, outcome.analysis)
            )
          )
        );
      },
    });
  }

  /** 观察一份原文。`revision` 缺省时由内部单调计数补上。 */
  analyze(source: string, revision?: number): Promise<FormatAnalysis> {
    const id = revision ?? (this.revisionFallback += 1);
    if (this.disposed) {
      return Promise.resolve({
        revision: id,
        effective: 'superseded',
        valid: false,
        publishable: false,
        evidence: [],
        candidates: [],
        codes: [],
        diagnostics: [],
        declaredVersion: null,
        syntaxVersion: null,
      });
    }
    // 旧观察作废：它们对应更早的正文。调用方仍可按 revision 丢弃。
    for (const [key, entry] of this.pending) {
      this.pending.delete(key);
      entry.resolve({
        revision: entry.revision,
        effective: 'superseded',
        valid: false,
        publishable: false,
        evidence: [],
        candidates: [],
        codes: [],
        diagnostics: [],
        declaredVersion: null,
        syntaxVersion: null,
      });
    }
    return new Promise<FormatAnalysis>((resolve) => {
      this.pending.set(source, { source, revision: id, resolve });
      this.scheduler.schedule(source, reactiveCompileOptions('markdown'));
    });
  }

  dispose(): void {
    this.disposed = true;
    for (const entry of this.pending.values()) {
      entry.resolve({
        revision: entry.revision,
        effective: 'superseded',
        valid: false,
        publishable: false,
        evidence: [],
        candidates: [],
        codes: [],
        diagnostics: [],
        declaredVersion: null,
        syntaxVersion: null,
      });
    }
    this.pending.clear();
    this.scheduler.dispose();
  }
}

/** 工厂形状，便于调用方按依赖注入替换。 */
export function createFormatAnalyzer(
  options: ReactiveFormatAnalyzerOptions
): ReactiveFormatAnalyzer {
  return new ReactiveFormatAnalyzer(options);
}
