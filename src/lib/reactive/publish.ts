import { LOCAL_SYNTAX_VERSION } from 'reactive-md';
import type { ContentFormat, ContentWriteErrorCode } from '../content-format';
import { detectReactiveSyntax } from './detect-format';

export interface ValidateContentInput {
  content: string;
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
      /** 写回正文行 `syntax_version` 的值：含增强语法 = 当前版本，纯 Markdown = null。 */
      syntaxVersion: string | null;
      /** 解析器实际认出的格式（日志 / 测试用，不落库）。 */
      detectedFormat: ContentFormat;
    }
  | {
      ok: false;
      reason: 'compile' | 'fallback';
      codes: string[];
    };

/**
 * 写入闸门：**只看正文本身**能不能编译。调用方不再「声明格式」，所以也没有
 * 「Markdown 里写了增强语法」这一种拒绝 —— 识别出增强语法就按增强语法保存。
 * 半截增强语法（`invalid-enhanced`）仍是编译失败，整篇拒绝。
 */
export async function validateContentForPublish(input: ValidateContentInput): Promise<ValidateContentResult> {
  const detected = detectReactiveSyntax(input.content);
  if (detected.codes.includes('local.budget')) return { ok: false, reason: 'compile', codes: detected.codes };
  if (!detected.valid) return { ok: false, reason: 'compile', codes: detected.codes };
  return {
    ok: true,
    syntaxVersion: detected.format === 'reactive' ? LOCAL_SYNTAX_VERSION : null,
    detectedFormat: detected.format,
  };
}
