import { compileLocal, type LocalCompileResult } from 'reactive-md';
import { maskMarkdownCode } from '../favorite-refs';
import { REACTIVE_COMPILE_OPTIONS } from './host-components';

export function compileSource(source: string, options = REACTIVE_COMPILE_OPTIONS, run = compileLocal): LocalCompileResult {
  // RMD 0.8 can repeatedly scan an unterminated interpolation before charging its parse budget.
  if (source.length > 4096 && source.includes('{{')) {
    let open = 0;
    for (const token of maskMarkdownCode(source).matchAll(/\{\{|\}\}/g)) {
      open = token[0] === '{{' ? open + 1 : 0;
      if (open <= 128) continue;
      const start = token.index;
      const lines = source.slice(0, start).split('\n');
      return { ok: false, diagnostics: [{
        code: 'local.budget', severity: 'error', message: '未闭合的插值过多，已停止编译。',
        range: { start, end: start + 2 }, line: lines.length, column: lines.at(-1)!.length + 1,
      }] };
    }
  }
  return run(source, options);
}
