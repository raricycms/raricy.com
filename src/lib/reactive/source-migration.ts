// ─────────────────────────────────────────────────────────────────────────────
// source-migration.ts — 旧语法版本迁移的**站点适配层**（服务端 / 离线命令）
//
// 上游 `reactive-md@0.7.0` 的 `migrateLocalSource()` 会在内部用**默认**节点预算
// （10,000）复编一遍正文，而本站的编译配置是 `REACTIVE_MAX_SYNTAX_NODES`
// （当前 15,000，P2 重新标定后还会更高）。两者不一致时的症状是：
//
//   · 同一份正文用站点配置编译成功、阅读页也正常；
//   · 迁移器却报 `local.budget`，整批迁移被阻塞；
//   · 而错误文案只说「节点超限」，看不出它用的是另一套预算。
//
// 上游迁移 API 目前**没有**接收编译选项的参数（`LocalUpgradeOptions` 只有
// `fromVersion` / `allowSemanticChanges`）。本站不能改 `node_modules`，也不能
// 往调用点塞一个会被忽略的字段，更不能把 `local.budget` 一律吞掉继续迁移 ——
// 那会把「迁移器真的发现了节点超限」一起放行。
//
// 这里的适配**只处理一种失败**：上游报告的全部错误都是 `local.budget`。
// 上游在编译之前已经跑完了 draft-1 / draft-2 的正文级检查（新增标签、保留绑定、
// 表达式、文本控件长度；见 `source-migration.ts` 的 D() 实现），所以此时没有
// 其它阻塞项。随后我们：
//
//   1. 用一份独立、可审查的扫描找出前导版本指令（大文档上 `inspectLocalSourceVersion`
//      会因预算诊断返回 `declaration: null`，不能拿它当唯一依据）；
//   2. 对 draft-2 再跑一次「新激活的 `<external>`」检查 —— 这是 0.7.0 唯一新增的
//      激活标签。检查走公开的 `analyzeLocalSource`，不另写一套解析器；
//   3. 用**站点编译选项**校验迁移后的源码，仍然超预算就如实返回失败；
//   4. 只做上游同款的元数据注释替换 / 插入（保留 BOM、CRLF 与正文原始字节）。
//
// 任何一步拿不准都返回上游原始结果（即阻塞），绝不「先迁移再说」。
// ─────────────────────────────────────────────────────────────────────────────

import {
  analyzeLocalSource,
  compileLocal,
  LOCAL_SYNTAX_VERSION,
  migrateLocalSource,
  type Diagnostic,
  type LocalCompileOptions,
  type LocalMigrationResult,
  type SourceRange,
} from 'reactive-md';
import { reactiveCompileOptions } from './host-components';

/** 当前版本指令的精确文本 —— 与上游 `T` 常量同形，从 `LOCAL_SYNTAX_VERSION` 派生。 */
const CURRENT_DECLARATION = `<!-- reactive-md: ${LOCAL_SYNTAX_VERSION} -->`;

/** 前导区里允许出现的版本指令（整行匹配）。 */
const DECLARATION_LINE = /^\s*<!--\s*reactive-md:\s*([A-Za-z0-9.-]+)\s*-->\s*$/;

/** 普通 HTML 注释（可排在版本指令之前）。 */
const LEADING_COMMENT_LINE = /^\s*<!--[\s\S]*?-->\s*$/;

export interface LeadingDeclaration {
  version: string;
  range: SourceRange;
}

/**
 * 找出正文前导区的版本指令。
 *
 * 规则与上游一致：BOM、空行、普通 Markdown 注释可以排在指令之前；遇到第一条
 * 其它内容就停止。返回 `null` = 没有声明（隐式当前版本 / 旧版本）。
 *
 * 为什么不用 `inspectLocalSourceVersion`：大文档超节点预算时它会把
 * `declaration` 置空（实测 6,000 段正文即可复现），而迁移恰恰要处理这类文档。
 */
export function findLeadingVersionDirective(source: string): LeadingDeclaration | null {
  const start = source.charCodeAt(0) === 0xfeff ? 1 : 0;
  let cursor = start;
  while (cursor <= source.length) {
    let lineEnd = source.indexOf('\n', cursor);
    if (lineEnd === -1) lineEnd = source.length;
    // 去掉行尾的 \r（CRLF）。
    const contentEnd = lineEnd > cursor && source[lineEnd - 1] === '\r' ? lineEnd - 1 : lineEnd;
    const line = source.slice(cursor, contentEnd);
    if (line.trim() === '') {
      if (lineEnd === source.length) return null;
      cursor = lineEnd + 1;
      continue;
    }
    const declaration = DECLARATION_LINE.exec(line);
    if (declaration) {
      return { version: declaration[1], range: { start: cursor, end: contentEnd } };
    }
    if (LEADING_COMMENT_LINE.test(line)) {
      if (lineEnd === source.length) return null;
      cursor = lineEnd + 1;
      continue;
    }
    return null;
  }
  return null;
}

/** 上游结果是否**只**因节点预算失败（其余阻塞项一律不放行）。 */
function budgetOnly(result: LocalMigrationResult): boolean {
  return (
    !result.ok &&
    result.diagnostics.length > 0 &&
    result.diagnostics.every((diagnostic) => diagnostic.code === 'local.budget')
  );
}

/** 构造一条与上游同形的诊断（迁移 CLI 只读 code，但保持字段完整便于审查）。 */
function upgradeDiagnostic(
  code: string,
  source: string,
  range: SourceRange,
  message: string
): Diagnostic {
  const before = source.slice(0, range.start);
  const lineStart = before.lastIndexOf('\n');
  return {
    code,
    severity: 'error',
    range,
    message,
    line: before.split('\n').length,
    column: range.start - lineStart,
    messageKey: code,
  };
}

/**
 * draft-2 → draft-3 的新激活标签检查。
 *
 * 只认 `external`（0.7.0 发布说明明写：draft-2 迁移会阻止新激活的 `<external>`；
 * 其余标签在 draft-2 已是组件）。扫描走 `analyzeLocalSource`，它使用与编译器同一份
 * 解析事实，并跳过代码 / 数学 / 已转义区域。
 *
 * 分析用的编译选项把节点预算放到与正文长度同量级 —— 这是**离线迁移**的一次性校验，
 * 不是阅读路径；若分析本身报预算或解析失败，调用方按阻塞处理（不猜）。
 */
function findActivatedExternal(
  source: string,
  declarationRange: SourceRange | null,
  options: LocalCompileOptions
): LocalMigrationResult['diagnostics'] {
  // 把旧版本指令替换成等长空格：否则 analyze 会因版本不受支持而提前退出。
  const blanked = declarationRange
    ? source.slice(0, declarationRange.start) +
      source.slice(declarationRange.start, declarationRange.end).replace(/[^\r\n]/g, ' ') +
      source.slice(declarationRange.end)
    : source;

  // 离线校验：给足解析预算（节点数量级不会超过源码长度）。
  const analysis = analyzeLocalSource(blanked, {
    ...options,
    limits: { ...options.limits, maxSyntaxNodes: Math.max(100_000, source.length) },
  });
  const diagnostics: Diagnostic[] = [];
  for (const token of analysis.tokens) {
    if (token.kind !== 'tag') continue;
    const name = source.slice(token.range.start, token.range.end).toLowerCase();
    if (name === 'external') {
      diagnostics.push(
        upgradeDiagnostic(
          'local.upgrade.tag',
          source,
          token.range,
          'active <external> tag is new in local-draft-3'
        )
      );
      // 上游对每个出现都报告；这里保留完整清单，便于作者一次改完。
    }
  }
  // analyze 自身的错误（预算 / 解析失败 / 版本）同样视为阻塞 —— 不能在没有
  // 完整语法事实的情况下放行。
  for (const diagnostic of analysis.diagnostics) {
    if (diagnostic.severity === 'error') diagnostics.push(diagnostic);
  }
  return diagnostics;
}

/**
 * 用站点预算迁移一份旧版本源码。
 *
 * 与上游 `migrateLocalSource` 同签名、同返回形状；唯一的差别是「上游只因默认预算
 * 失败、站点预算足够」时继续完成迁移。其余所有失败原样返回给调用方。
 */
export function migrateLocalSourceWithSiteBudget(
  source: string,
  fromVersion: string
): LocalMigrationResult {
  const upstream = migrateLocalSource(source, { fromVersion });
  if (upstream.ok || !budgetOnly(upstream)) return upstream;

  // 只对本站实际存在的 draft-2 旧行做适配；其它旧版本没有本站适配依据。
  if (fromVersion !== 'local-draft-2') return upstream;

  const declaration = findLeadingVersionDirective(source);
  // 版本指令存在但不是 draft-2：上游已按 fromVersion 校验过；这里保守阻塞。
  if (declaration && declaration.version !== 'local-draft-2') return upstream;

  const options = reactiveCompileOptions('reactive');
  const activationErrors = findActivatedExternal(source, declaration?.range ?? null, options);
  if (activationErrors.length > 0) {
    return { ...upstream, diagnostics: [...activationErrors, ...upstream.diagnostics] };
  }

  const bom = source.charCodeAt(0) === 0xfeff ? 1 : 0;
  const range = declaration?.range ?? { start: bom, end: bom };
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const replacement = declaration
    ? CURRENT_DECLARATION
    : `${CURRENT_DECLARATION}${newline}${newline}`;
  const migrated = source.slice(0, range.start) + replacement + source.slice(range.end);

  // 用站点配置复核迁移后的正文。失败就阻塞，并带上真实的编译诊断。
  const compiled = compileLocal(migrated, options);
  if (!compiled.ok) {
    return { ...upstream, diagnostics: [...compiled.diagnostics, ...upstream.diagnostics] };
  }

  return {
    ...upstream,
    ok: true,
    source: migrated,
    changed: migrated !== source,
    edits: [{ range: { ...range }, text: replacement }],
    diagnostics: [],
  };
}
