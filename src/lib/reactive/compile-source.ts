import {
  compileLocal,
  type LocalCompileOptions,
  type LocalCompileResult,
  type LocalSourcePhase,
} from 'reactive-md';
import { createLocalCompileSession } from 'reactive-md/compiler/session';
import { maskMarkdownCode } from '../favorite-refs';
import { REACTIVE_COMPILE_OPTIONS } from './host-components';

type CompileRunner = (
  source: string,
  options?: LocalCompileOptions,
  sourcePhase?: LocalSourcePhase,
) => LocalCompileResult;

function runCompileLocal(
  source: string,
  options: LocalCompileOptions | undefined,
  sourcePhase: LocalSourcePhase | undefined,
): LocalCompileResult {
  if (sourcePhase === undefined) return compileLocal(source, options);

  const session = createLocalCompileSession();
  try {
    return session.compile(source, options, sourcePhase);
  } finally {
    session.dispose();
  }
}

export function compileSource(
  source: string,
  options = REACTIVE_COMPILE_OPTIONS,
  sourcePhase?: LocalSourcePhase,
  run: CompileRunner = runCompileLocal,
): LocalCompileResult {
  // Streaming snapshots can end inside an interpolation. Let the compiler render those regions
  // provisionally, and keep this guard for complete-source compilation where deeply nested,
  // unmatched openers can consume work before the normal parse budget is charged.
  if (sourcePhase !== 'streaming' && source.length > 4096 && source.includes('{{')) {
    let open = 0;
    for (const token of maskMarkdownCode(source).matchAll(/\{\{|\}\}/g)) {
      open = token[0] === '{{' ? open + 1 : 0;
      if (open <= 128) continue;
      const start = token.index;
      const lines = source.slice(0, start).split('\n');
      const failure: LocalCompileResult = { ok: false, diagnostics: [{
        code: 'local.budget', severity: 'error', message: '未闭合的插值过多，已停止编译。',
        range: { start, end: start + 2 }, line: lines.length, column: lines.at(-1)!.length + 1,
      }] };
      return sourcePhase === undefined ? failure : { ...failure, status: 'failed' };
    }
  }
  return run(source, options, sourcePhase);
}
