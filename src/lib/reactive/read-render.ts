// 阅读页只按当前请求编译源码；编译结果由有界内存缓存复用，不读写数据库快照。
import { parseContentFormat } from '../content-format';
import type { RendererChoice } from '../renderer-select';
import { parseReactiveFlags } from './flags';
import { compileContent } from './compile-content';
import type { ReactiveCompileOutcome } from './compile';

export interface ReadRenderInput {
  kind: 'blog' | 'clipboard';
  id: string;
  source: string;
  format: unknown;
  override?: unknown;
  viewer: { id: string; role?: string; archivedAt?: Date | null } | null;
  mode: 'expand' | 'external';
  clientIp?: string;
  /** 正文行里存着的语法版本（仅 reactive 有意义）；缺省按当前编译器版本。 */
  syntaxVersion?: string | null;
}

export interface ReadRenderResult {
  choice: RendererChoice;
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
  const flags = parseReactiveFlags(process.env);
  const format = parseContentFormat(input.format);
  let bundle: ReactiveCompileOutcome | undefined;
  let choice: RendererChoice;
  let failure: ReadRenderResult['failure'];
  if (!format) {
    choice = { renderer: 'unavailable', reason: 'invalid-format' };
    failure = 'invalid-format';
  } else if (flags.mode === 'off' && format === 'markdown') {
    choice = { renderer: 'legacy', reason: 'flag' };
  } else {
    try {
      bundle = (await compileContent({
        source: input.source, format, mode: input.mode,
        viewer: input.viewer, clientIp: input.clientIp, syntaxVersion: input.syntaxVersion,
      })).outcome;
    } catch {
      // 只影响这篇正文；不把增强源码交给旧 Markdown 解析器。
    }
    if (bundle?.result.ok) {
      choice = { renderer: flags.mode === 'off' ? 'reactive-static' : 'reactive', reason: 'format' };
    } else {
      choice = { renderer: 'unavailable', reason: 'fallback' };
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
