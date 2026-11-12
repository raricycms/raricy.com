import { LOCAL_SYNTAX_VERSION } from 'reactive-md';
import type { ContentFormat, ContentWriteErrorCode } from '../content-format';
import { detectReactiveSyntax } from './detect-format';

export interface ValidateContentInput {
  content: string;
  /** 正文语言；检查不改变原文和存储格式。 */
  format: ContentFormat;
}

/** 发布被拒的**类型化**错误：route 用它折 400，不靠比对错误文案。 */
export class ReactivePublishError extends Error {
  readonly code: ContentWriteErrorCode;

  constructor(message: string, code: ContentWriteErrorCode = 'content_unrenderable') {
    super(message);
    this.name = 'ReactivePublishError';
    this.code = code;
  }
}

export type ValidateContentResult =
  | {
      ok: true;
      /** 写回正文行 `syntax_version` 的值：Markdown 恒为 null。 */
      syntaxVersion: string | null;
      /** 解析器实际认出的格式（用于写入格式不匹配闸门）。 */
      detectedFormat: ContentFormat;
    }
  | {
      ok: false;
      reason: 'compile' | 'fallback' | 'format_mismatch';
      codes: string[];
    };

export async function validateContentForPublish(input: ValidateContentInput): Promise<ValidateContentResult> {
  const detected = detectReactiveSyntax(input.content);
  if (detected.codes.includes('local.budget')) return { ok: false, reason: 'compile', codes: detected.codes };
  if (input.format === 'markdown' && detected.reactive) {
    return { ok: false, reason: 'format_mismatch', codes: detected.codes };
  }
  if (!detected.valid) return { ok: false, reason: 'compile', codes: detected.codes };
  return {
    ok: true,
    syntaxVersion: input.format === 'reactive' ? LOCAL_SYNTAX_VERSION : null,
    detectedFormat: detected.format,
  };
}
