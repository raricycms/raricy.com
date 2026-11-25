/**
 * 正文语言的**派生标签**与请求值白名单。
 *
 * 【单一真相】库内只存源码与 `syntax_version`：非 NULL = 写入时识别出增强语法，
 * NULL = 纯 Markdown。`format` 是对外字段，读口一律由 `contentFormatFromSyntaxVersion`
 * 现算 —— 库里没有这一列，也不接受调用方「声明」格式来决定保存成什么
 * （写入口只校验请求里那个已废弃的值合不合法，实际存储永远看正文本身）。
 */

export const CONTENT_FORMATS = ['markdown', 'reactive'] as const;
export type ContentFormat = (typeof CONTENT_FORMATS)[number];

/** 正文行缺失时的显示档；正常行一律由 syntax_version 派生。 */
export const DEFAULT_CONTENT_FORMAT: ContentFormat = 'markdown';

export const CONTENT_FORMAT_LABELS: Record<ContentFormat, string> = {
  markdown: 'Markdown',
  reactive: 'ReactiveMD',
};

/** 缺失 / 未知的自描述值 → null（调用方保留字面量，不猜）。 */
export function parseContentFormat(value: unknown): ContentFormat | null {
  return value === 'markdown' || value === 'reactive' ? value : null;
}

/** 库内唯一真相 → 对外格式。空串 / 缺失都是纯 Markdown。 */
export function contentFormatFromSyntaxVersion(
  syntaxVersion: unknown,
): ContentFormat {
  return typeof syntaxVersion === 'string' && syntaxVersion.length > 0
    ? 'reactive'
    : 'markdown';
}

/** 写入闸门的**稳定错误码**（前端按码提示，不解析中文 message）。 */
export const CONTENT_WRITE_ERROR_CODES = {
  invalid_format: 'invalid_content_format',
  reactive_invalid: 'content_unrenderable',
} as const;

export type ContentWriteErrorCode =
  (typeof CONTENT_WRITE_ERROR_CODES)[keyof typeof CONTENT_WRITE_ERROR_CODES];
