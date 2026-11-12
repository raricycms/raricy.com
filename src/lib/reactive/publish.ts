// 发布前的语法 / 格式检查。编译结果用完即弃，不产生持久快照。
// compile-content 延迟加载，避开引用服务与内容 service 的模块环。
import { LOCAL_SYNTAX_VERSION } from 'reactive-md';
import type { ContentFormat, ContentWriteErrorCode } from '../content-format';
import { shouldRejectReactive } from './diagnostics';
import { compiledEvidence, detectReactiveSyntax } from './detect-format';
import { findLeadingVersionDirective } from './version-directive';
import { SourceCompatibilityError } from './source-migration';

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

/** 使用 external 引用范围检查发布内容，不访问读者会话数据，不写数据库。 */
export async function validateContentForPublish(
  input: ValidateContentInput,
): Promise<ValidateContentResult> {
  // R3-101 复核后**不拒绝**旧版前导声明：旧版 RMD 原文必须可保存、可编辑（云剪贴板
  // 的既有契约，e2e reactive-render 与 reactive-source-render 都钉住「原文不变、
  // syntax_version 保持旧标记、阅读时按声明迁移」）。收紧写入会让存量旧内容一编辑
  // 就 400，属破坏兼容；旧标记的迁移由读路径（source-migration）负责。
  //
  // 延迟加载：避开 service ↔ compile 的模块环，见文件头。
  const { compileContent } = await import('./compile-content');

  let compiled: Awaited<ReturnType<typeof compileContent>>;
  try {
    compiled = await compileContent({ source: input.content, format: input.format, mode: 'external', viewer: null });
  } catch (error) {
    if (!(error instanceof SourceCompatibilityError)) throw error;
    return { ok: false, reason: 'compile', codes: ['site.source.compatibility'] };
  }

  const { outcome } = compiled;
  if (!outcome.result.ok) {
    return {
      ok: false,
      reason: 'compile',
      codes: outcome.result.diagnostics.map((diagnostic) => diagnostic.code),
    };
  }
  // literalize 只用于**阅读**容错。写入时如果它救活了一篇本来编不过的
  // Markdown，而原文在解析器里其实已有增强身份（invalid-enhanced），必须拒绝，
  // 不能把字面化后的文档当成「普通 Markdown」落库。
  if (compiled.literalized) {
    const detected = detectReactiveSyntax(input.content);
    if (detected.format === 'reactive') {
      return {
        ok: false,
        reason: 'format_mismatch',
        codes: detected.codes.length > 0 ? detected.codes : ['site.enhanced.invalid'],
      };
    }
  }
  if (shouldRejectReactive(outcome.result)) {
    return {
      ok: false,
      reason: 'fallback',
      codes: outcome.result.diagnostics.map((diagnostic) => diagnostic.code),
    };
  }

  const detectedFormat: ContentFormat =
    compiledEvidence(outcome.adaptedSource, outcome.result).length > 0 ? 'reactive' : 'markdown';
  // 旧版前导声明按原文写回（R3-101 复核后的取舍）：存量旧内容必须保持「原文 +
  // 旧 syntax_version」，阅读路径据此迁移；写入当前版本会改变已发布内容的版本语义。
  const syntaxVersion = input.format === 'reactive'
    ? findLeadingVersionDirective(input.content)?.version ?? LOCAL_SYNTAX_VERSION
    : null;
  return {
    ok: true,
    syntaxVersion,
    detectedFormat,
  };
}
