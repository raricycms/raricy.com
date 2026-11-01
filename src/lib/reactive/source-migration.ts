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
import { currentDeclaration, findLeadingVersionDirective, findVersionDirectives, type LeadingDeclaration } from './version-directive';



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


/** draft-3 新增的动态约束属性（按组件）。见 0.7.0 发布说明。 */
const DYNAMIC_CONSTRAINTS: Readonly<Record<string, ReadonlySet<string>>> = {
  number: new Set(['min', 'max']),
  slider: new Set(['min', 'max']),
  date: new Set(['min', 'max', 'required']),
  input: new Set(['required']),
  textarea: new Set(['required']),
  plot: new Set(['min', 'max']),
};

/**
 * 从属性名结束位置（`attrEnd`）找出**属性值区间**（引号内，或无引号值）。
 *
 * 这是「这一处 `{{ … }}` 到底在不在属性值里」的唯一判据。不能只靠 token 顺序：
 * `analyzeLocalSource` 在开标签结束之后仍会为正文里的插值发 `expression` token，
 * 而 `currentAttr` 会一直停在上一个属性上 —— 那会把普通正文误判成动态约束。
 */
function attributeValueRange(source: string, attrEnd: number): SourceRange | null {
  let i = attrEnd;
  while (i < source.length && /\s/.test(source[i])) i += 1;
  if (source[i] !== '=') return null;
  i += 1;
  while (i < source.length && /\s/.test(source[i])) i += 1;

  const quote = source[i];
  if (quote === '"' || quote === "'") {
    const start = i + 1;
    const end = source.indexOf(quote, start);
    return end === -1 ? null : { start, end };
  }
  // 无引号值：到空白或标签结束为止。仍返回精确区间，调用方按 token 边界比较。
  const start = i;
  while (i < source.length && !/[\s>]/.test(source[i])) i += 1;
  return i > start ? { start, end: i } : null;
}

/**
 * 开标签结束的位置（`>` 之后）。跳过引号内的 `>`，未闭合返回 -1。
 *
 * 属性 token 只覆盖属性名，不覆盖标签结束；没有这一格，「`<slider …>` 之后的
 * 正文插值」会继续套用最后一个属性。
 */
function tagContentEnd(source: string, from: number): number {
  let quote: string | null = null;
  for (let i = from; i < source.length; i += 1) {
    const ch = source[i];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '>') return i + 1;
  }
  return -1;
}

/**
 * draft-2 → draft-3 的**动态约束激活**检查。
 *
 * 上游迁移器只检查新激活 `<external>`；发布说明同时把「动态 min/max/required」
 * 列为可能改变原字面语义的变化。这里用上游 `analyzeLocalSource` 的 token /
 * expression 事实判断：同一标签上的动态属性出现表达式 `{{ … }}` 即阻塞。
 *
 * 判据必须同时满足：表达式在**该开标签内**（`tagContentEnd` 之前），且落在
 * 约束属性的**值区间**里（`attributeValueRange`）。只看「最近一个 attribute」
 * 会把开标签之后的普通插值误判成 `min/max`，整批合法文档被卡住。
 *
 * 在所有 draft-2 行上都要跑（不只在预算失败分支），短文档也一样。
 */
export function findDynamicConstraintActivations(source: string): Diagnostic[] {
  const declaration = findLeadingVersionDirective(source);
  const blanked = declaration
    ? source.slice(0, declaration.range.start) +
      source.slice(declaration.range.start, declaration.range.end).replace(/[^\r\n]/g, ' ') +
      source.slice(declaration.range.end)
    : source;

  const baseOptions = reactiveCompileOptions('reactive');
  const analysis = analyzeLocalSource(blanked, {
    ...baseOptions,
    limits: {
      ...baseOptions.limits,
      maxSyntaxNodes: Math.max(200_000, source.length),
    },
  });

  const diagnostics: Diagnostic[] = [];
  let currentTag: string | null = null;
  let currentAttr: { name: string; value: SourceRange | null } | null = null;
  let tagEnd = -1;
  for (const token of analysis.tokens) {
    if (token.kind === 'tag') {
      currentTag = source.slice(token.range.start, token.range.end).toLowerCase();
      currentAttr = null;
      tagEnd = tagContentEnd(source, token.range.end);
      continue;
    }
    if (token.kind === 'attribute') {
      currentAttr =
        tagEnd >= 0 && token.range.start >= tagEnd
          ? null
          : {
              name: source.slice(token.range.start, token.range.end).toLowerCase(),
              value: attributeValueRange(source, token.range.end),
            };
      continue;
    }
    if (token.kind !== 'expression' || !currentTag || !currentAttr) continue;
    // 开标签之后的普通正文插值不是属性值。未闭合标签（tagEnd = -1）继续按
    // 属性值区间判 —— 那是一个解析错误，不在本函数里掩盖。
    if (tagEnd >= 0 && token.range.start >= tagEnd) continue;
    if (!DYNAMIC_CONSTRAINTS[currentTag]?.has(currentAttr.name)) continue;
    const value = currentAttr.value;
    if (!value || token.range.start < value.start || token.range.end > value.end) continue;
    diagnostics.push(
      upgradeDiagnostic(
        'site.migration.dynamic-constraint',
        source,
        token.range,
        `${currentTag}.${currentAttr.name} becomes a dynamic constraint in local-draft-3`
      )
    );
  }
  return diagnostics;
}

/** 列已是当前版本、正文却仍声明旧版本：一次性标记不能掩盖它（含正文深处的声明）。 */
export function findStaleVersionDeclaration(source: string): Diagnostic[] {
  const stale = findVersionDirectives(source).filter(
    (declaration) => declaration.version !== LOCAL_SYNTAX_VERSION
  );
  return stale.map((declaration) =>
    upgradeDiagnostic(
      'site.migration.stale-declaration',
      source,
      declaration.range,
      `content declares ${declaration.version} while the row says ${LOCAL_SYNTAX_VERSION}`
    )
  );
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
    ? currentDeclaration(LOCAL_SYNTAX_VERSION)
    : `${currentDeclaration(LOCAL_SYNTAX_VERSION)}${newline}${newline}`;
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
    // 保留站点复核产生的 warning（例如上游的 version-missing / 诊断提醒），
    // 不要因为迁移成功就把它们丢掉。
    diagnostics: compiled.diagnostics,
  };
}
