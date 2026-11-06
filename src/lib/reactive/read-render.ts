// 阅读页只按当前请求编译源码；编译结果由有界内存缓存复用，不读写数据库快照。
//
// ★ 唯一正文渲染路径 ★
// 2026-11 起 legacy Markdown 渲染面（`REACTIVE_MD_MODE=off` 事故回退、旧
// `MarkdownRenderer` / `blog-renderer` / `content-ref-*` 管线）整条退役：Markdown
// 与 Reactive 源文都由**同一套编译器**按当前查看者权限编译，reactive 是唯一正文
// 渲染器。认不出格式或编译失败的正文只返回 `unavailable`（页面给一句可读提示），
// **不存在第二条渲染管线**，也不再有环境变量能改变这条决策。
import { parseContentFormat } from '../content-format';
import { compileContent } from './compile-content';
import type { ReactiveCompileOutcome } from './compile';

/** 正文渲染器只有两种结果：可编译出来，或明确不可用。 */
export type ReadRenderer = 'reactive' | 'unavailable';

/** 选择结果 + 理由（`reason` 只进日志与测试，不参与页面分支）。 */
export type ReadRendererChoice = {
  renderer: ReadRenderer;
  reason: 'format' | 'invalid-format' | 'compile';
};

export interface ReadRenderInput {
  source: string;
  format: unknown;
  viewer: { id: string; role?: string; archivedAt?: Date | null } | null;
  mode: 'expand' | 'external';
  clientIp?: string;
  /** 正文行里存着的语法版本（仅 reactive 有意义）；缺省按当前编译器版本。 */
  syntaxVersion?: string | null;
}

export interface ReadRenderResult {
  choice: ReadRendererChoice;
  /** 日志字段（只含结构化信息）。 */
  log: {
    renderer: string;
    reason: string;
    format: string | null;
    codes: string[];
    compileMs: number;
    cacheHit: boolean;
  };
  /** 本次请求的编译产物（可命中内存缓存）。 */
  bundle?: ReactiveCompileOutcome;
  failure?: 'invalid-format' | 'compile';
}

export async function resolveReadRender(input: ReadRenderInput): Promise<ReadRenderResult> {
  const format = parseContentFormat(input.format);

  let bundle: ReactiveCompileOutcome | undefined;
  let choice: ReadRendererChoice;
  let failure: ReadRenderResult['failure'];

  if (!format) {
    // 认不出格式 → 绝不猜 markdown（历史脏数据 / 未知 format 一律明确不可用）。
    choice = { renderer: 'unavailable', reason: 'invalid-format' };
    failure = 'invalid-format';
  } else {
    // 失败只影响这一篇正文：编译抛错与编译失败走同一条降级，不给第二套解析器兜底。
    try {
      bundle = (await compileContent({
        source: input.source, format, mode: input.mode,
        viewer: input.viewer, clientIp: input.clientIp, syntaxVersion: input.syntaxVersion,
      })).outcome;
    } catch {
      /* 编译抛错按失败处理 */
    }
    if (bundle?.result.ok) {
      choice = { renderer: 'reactive', reason: 'format' };
    } else {
      choice = { renderer: 'unavailable', reason: 'compile' };
      failure = 'compile';
    }
  }

  const log = {
    renderer: choice.renderer, reason: choice.reason, format,
    codes: bundle?.result.diagnostics.map(d => d.code) ?? [],
    compileMs: bundle?.compileMs ?? 0, cacheHit: bundle?.cacheHit ?? false,
  };
  console.info('[reactive-read]', JSON.stringify(log));
  return { choice, log, ...(bundle ? { bundle } : {}), ...(failure ? { failure } : {}) };
}
