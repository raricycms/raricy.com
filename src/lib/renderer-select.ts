import { parseContentFormat } from './content-format';
import type { ReactiveFlags } from './reactive/flags';

/**
 * 阅读渲染路径的唯一决策函数，由 `reactive/read-render.ts` 的 `resolveReadRender` 调用；
 * 这里只决定「走哪条管线」，实际编译与失败降级由调用方按本函数结果执行。
 *
 * 2026-11 统一后的规则只有三条：
 *   1. 认不出格式 → `unavailable`（绝不猜 markdown）；
 *   2. 显式事故回退 `REACTIVE_MD_MODE=off`：
 *      · Markdown → 旧渲染器（临时）；
 *      · Reactive → `reactive-static`：不交给旧解析器；
 *   3. 其余一律 `reactive`：Markdown 与 Reactive 都走统一引擎，正常阅读可交互。
 *
 * 任何分支只要内容编译失败都是 `unavailable`（见下面的优先级说明）。
 *
 * 百分比灰度与逐篇 override 不再参与决策；字段仍留在库里供旧消费者读取。
 */
export interface RendererChoice {
  renderer: 'legacy' | 'reactive' | 'reactive-static' | 'unavailable';
  reason: 'format' | 'flag' | 'fallback' | 'invalid-format';
}

/**
 * 决策只依赖这三项。逐篇 override、灰度百分比和版本号都不参与选择，
 * 因此不进这个入参 —— 放在这里会让人以为它们仍然有效。
 */
export interface RendererSelectionInput {
  format: unknown;
  flags: ReactiveFlags;
  compilationFailed?: boolean;
}

export function selectContentRenderer(input: RendererSelectionInput): RendererChoice {
  const format = parseContentFormat(input.format);
  if (!format) return { renderer: 'unavailable', reason: 'invalid-format' };

  // 编译失败优先于事故回退：失败的内容既不能交给旧解析器，也不能当静态输出展示。
  // Markdown + off 根本不编译，所以这条只在真正尝试过编译的调用里出现。
  if (input.compilationFailed) return { renderer: 'unavailable', reason: 'fallback' };

  if (input.flags.mode === 'off') {
    return format === 'markdown'
      ? { renderer: 'legacy', reason: 'flag' }
      : { renderer: 'reactive-static', reason: 'flag' };
  }

  return { renderer: 'reactive', reason: 'format' };
}
