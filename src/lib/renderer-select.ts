import { parseContentFormat } from './content-format';
import type { ReactiveFlags } from './reactive/flags';

/**
 * 阅读渲染路径的唯一决策函数。
 *
 * 2026-11 统一后的规则只有三条：
 *   1. 认不出格式 → `unavailable`（绝不猜 markdown）；
 *   2. 显式事故回退 `REACTIVE_MD_MODE=off`：
 *      · Markdown → 旧渲染器（临时）；
 *      · Reactive → 同版本静态快照（永不交给旧解析器）；
 *   3. 其余一律 `reactive`：Markdown 与 Reactive 都走统一引擎，正常阅读可交互。
 *
 * 百分比灰度与逐篇 override 不再参与决策；字段仍留在库里供旧消费者读取。
 */
export interface RendererChoice {
  renderer: 'legacy' | 'reactive' | 'reactive-static' | 'unavailable';
  reason: 'format' | 'flag' | 'fallback' | 'invalid-format';
}

export interface RendererSelectionInput {
  kind: 'blog' | 'clipboard';
  id: string;
  format: unknown;
  override?: unknown;
  flags: ReactiveFlags;
  markdownCompatible?: boolean;
  compilationFailed?: boolean;
  contentVersion?: string;
  snapshotVersion?: string;
}

export function selectContentRenderer(input: RendererSelectionInput): RendererChoice {
  const format = parseContentFormat(input.format);
  if (!format) return { renderer: 'unavailable', reason: 'invalid-format' };

  if (input.flags.mode === 'off') {
    return format === 'markdown'
      ? { renderer: 'legacy', reason: 'flag' }
      : { renderer: 'reactive-static', reason: 'flag' };
  }

  if (input.compilationFailed) return { renderer: 'unavailable', reason: 'fallback' };
  return { renderer: 'reactive', reason: 'format' };
}
