/** Stored language and write gate. Rendering choices never change this value. */
export const CONTENT_FORMATS = ['markdown', 'reactive'] as const;
export type ContentFormat = (typeof CONTENT_FORMATS)[number];
export const DEFAULT_CONTENT_FORMAT: ContentFormat = 'markdown';

export const CONTENT_FORMAT_LABELS: Record<ContentFormat, string> = {
  markdown: 'Markdown',
  reactive: 'ReactiveMD',
};

/** Missing fields are resolved by the caller; unknown values are never guessed. */
export function parseContentFormat(value: unknown): ContentFormat | null {
  return value === 'markdown' || value === 'reactive' ? value : null;
}

export type ContentFormatWriteResult =
  | { ok: true; format: ContentFormat }
  | { ok: false; reason: 'invalid_format' };

/**
 * Omitted updates preserve the stored language.
 *
 * Reactive writes are accepted here; the **compile + snapshot** check is the service's
 * job (a request that cannot be compiled must not be stored at all).
 */
export function resolveContentWriteFormat(
  requested: unknown,
  current: ContentFormat = DEFAULT_CONTENT_FORMAT,
): ContentFormatWriteResult {
  const format = requested === undefined ? current : parseContentFormat(requested);
  if (format === null) return { ok: false, reason: 'invalid_format' };
  return { ok: true, format };
}
