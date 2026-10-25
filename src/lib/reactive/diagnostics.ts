// ─────────────────────────────────────────────────────────────────────────────
// diagnostics.ts — 「这篇文档能不能交给新渲染器」的**回退判据**
//
// 【为什么不能只看 `ok`】ReactiveMD 对一批「内容解释不了」的情况仍然返回
// `ok: true`，只给 warning。两类最危险：
//   · `local.html`          —— HTML 标签/属性降级成源码文本（class/style/on*）；
//   · `local.component.unknown` —— 未知标签（audio/video/input/button…）被当成未知组件；
// 它们会**静默改变可见内容**。数学显示降级（`local.math.display`）同理：公式按
// 字面量显示，编译却成功。计划 D4 因此把 warning 白名单也作为回退条件。
//
// 【码 vs messageKey】上游的 `diagnostic.code` 是粗分类（`local.math.display`），
// 具体降级种类在 `diagnostic.messageKey`（`local.math.display.unsupported-command`
// 等）。两处都查，升级上游时不会因为只改其中一处而静默漏判。
//
// 本模块零运行时依赖（只 import 类型），服务端与客户端都能用。
// ─────────────────────────────────────────────────────────────────────────────

import type { LocalCompileResult } from 'reactive-md';

/**
 * 命中任一码即整篇回退。
 *
 * 契约要求至少包含 `local.html`、`local.component.unknown`、
 * `local.options.invalid`、`local.budget` 与全部数学显示降级码。粗分类
 * `local.math.display` 与细分 messageKey 都列上（见文件头）。
 */
export const REACTIVE_FALLBACK_CODES: readonly string[] = Object.freeze([
  'local.html',
  'local.component.unknown',
  'local.options.invalid',
  'local.budget',
  'local.math.display',
  'local.math.display.unsupported-command',
  'local.math.display.unsupported-environment',
  'local.math.display.budget',
  'local.math.display.stray-end',
  'local.math.display.environment-unclosed',
  'local.math.display.environment-missing-name',
  'local.math.display.syntax',
]);

const FALLBACK_CODE_SET: ReadonlySet<string> = new Set(REACTIVE_FALLBACK_CODES);

/** 诊断里的粗分类码，按出现顺序（日志 / 观测用，不含正文）。 */
export function reactiveDiagnosticCodes(result: LocalCompileResult): string[] {
  return result.diagnostics.map((diagnostic) => diagnostic.code);
}

/** 命中的回退码去重后按出现顺序返回；空数组 = 不需要回退。 */
export function reactiveFallbackReasons(result: LocalCompileResult): string[] {
  const reasons = new Set<string>();
  for (const diagnostic of result.diagnostics) {
    if (FALLBACK_CODE_SET.has(diagnostic.code)) reasons.add(diagnostic.code);
    if (diagnostic.messageKey && FALLBACK_CODE_SET.has(diagnostic.messageKey)) {
      reasons.add(diagnostic.messageKey);
    }
  }
  return [...reasons];
}

/**
 * 整篇回退判据：编译失败，或任一诊断命中白名单。
 *
 * 单个引用取数失败**不**走这里（适配器保留字面量，组件自己显示失败态）——
 * 回退只用于「内容解释不了」，见计划 §6。
 */
export function shouldFallbackToLegacy(result: LocalCompileResult): boolean {
  if (!result.ok) return true;
  for (const diagnostic of result.diagnostics) {
    if (FALLBACK_CODE_SET.has(diagnostic.code)) return true;
    if (diagnostic.messageKey && FALLBACK_CODE_SET.has(diagnostic.messageKey)) return true;
  }
  return false;
}
