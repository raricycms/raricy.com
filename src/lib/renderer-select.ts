import { parseContentFormat } from './content-format';
import type { ReactiveFlags } from './reactive/flags';

export interface RendererChoice {
  renderer: 'legacy' | 'reactive' | 'reactive-static' | 'unavailable';
  reason: 'format' | 'override' | 'flag' | 'percent' | 'fallback' | 'snapshot-missing' | 'invalid-format' | 'invalid-override';
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

/** FNV-1a over stable identity, so editing source cannot move a document between cohorts. */
function cohort(kind: string, id: string): number {
  let hash = 2166136261;
  for (const character of `${kind}:${id}`) hash = Math.imul(hash ^ character.codePointAt(0)!, 16777619);
  return (hash >>> 0) % 100;
}

export function selectContentRenderer(input: RendererSelectionInput): RendererChoice {
  const format = parseContentFormat(input.format);
  if (!format) return { renderer: 'unavailable', reason: 'invalid-format' };
  const snapshot = (reason: RendererChoice['reason']): RendererChoice => {
    if (!input.contentVersion || input.snapshotVersion !== input.contentVersion) {
      return { renderer: 'unavailable', reason: 'snapshot-missing' };
    }
    return { renderer: 'reactive-static', reason };
  };
  if (input.flags.mode !== 'on') {
    return format === 'markdown' ? { renderer: 'legacy', reason: 'flag' } : snapshot('flag');
  }
  const override = input.override;
  if (override != null && override !== 'legacy' && override !== 'reactive') {
    return format === 'markdown' ? { renderer: 'legacy', reason: 'invalid-override' } : snapshot('invalid-override');
  }
  if (format === 'reactive' && override === 'legacy') return snapshot('invalid-override');
  if (format === 'markdown' && override === 'legacy') return { renderer: 'legacy', reason: 'override' };
  if (input.compilationFailed || (format === 'markdown' && input.markdownCompatible !== true)) {
    return format === 'markdown' ? { renderer: 'legacy', reason: 'fallback' } : snapshot('fallback');
  }
  if (override === 'reactive') return { renderer: 'reactive', reason: 'override' };
  if (cohort(input.kind, input.id) >= input.flags.percent) {
    return format === 'markdown' ? { renderer: 'legacy', reason: 'percent' } : snapshot('percent');
  }
  return { renderer: 'reactive', reason: 'format' };
}
