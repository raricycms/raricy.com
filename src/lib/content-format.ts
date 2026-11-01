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
 * Reactive writes are accepted here; the syntax / format validation is the service's
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

/** 写入闸门的**稳定错误码**（前端按码提示，不解析中文 message）。 */
export const CONTENT_WRITE_ERROR_CODES = {
  invalid_format: 'invalid_content_format',
  format_mismatch: 'content_format_mismatch',
  reactive_invalid: 'content_unrenderable',
} as const;

export type ContentWriteErrorCode =
  (typeof CONTENT_WRITE_ERROR_CODES)[keyof typeof CONTENT_WRITE_ERROR_CODES];
