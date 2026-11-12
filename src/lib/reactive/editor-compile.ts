import { compileLocal, type LocalCompileOptions, type LocalCompileResult } from 'reactive-md';
import { REACTIVE_COMPILE_OPTIONS } from './host-components';
import { applyLegacyHtmlCompat } from './legacy-compat';
import { checkSyntaxBudget } from './syntax-budget';

/** Main-thread fallback for the editor's compile worker. */
export function compileEditorSource(
  source: string,
  options: LocalCompileOptions = REACTIVE_COMPILE_OPTIONS
): LocalCompileResult {
  const budget = checkSyntaxBudget(source);
  if (budget) return { ok: false, diagnostics: [budget.diagnostic] };
  return compileLocal(applyLegacyHtmlCompat(source).source, options);
}
