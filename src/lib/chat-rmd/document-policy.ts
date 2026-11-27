// ─────────────────────────────────────────────────────────────────────────────
// chat-rmd/document-policy.ts — 聊天文档的能力收缩（纯函数、可序列化）
//
// reactive-md 0.9.3 起，聊天编译用 `embedding: { expressions: 'literal',
// onUnsupported: 'fallback' }` 在编译期完成**局部降级**：表达式留字面文本，坏组件
// 就地变成编译器自己的 `fallback` 节点。策略只做**最终能力收缩与字段清洗**。
//
// 静态 `LocalStaticDocumentView` 不承担权限隔离：作者源码里能解析出的 style /
// script / 组件 / 原生图片，如果留在 AST 里就可能获得运行时能力。聊天把编译文档
// 收紧到「现有 Markdown 结构 + 公式」白名单（`fallback` 按源码显示，不带能力），
// 再由引用适配器生成受控宿主组件。
//
// 输出保留 `componentConfigKey`（静态视图要与 minimal reactConfig 对账）与存活组件
// 的 `componentDefinitions`（静态视图据此判定 `component` 节点不需要 runtime），
// 其余运行期元数据一律清空；`requiresRuntime` 固定为 false。
//
// 输出只含 plain object / array / 原始值，可直接 structuredClone 回主线程。
// 无法从源码取回字面量的未批准节点整体失败（`policy.unsupported`），视图显示源码。
//
// 版本号参与 final 缓存键；调整允许列表或清洗规则时必须同步递增。
// ─────────────────────────────────────────────────────────────────────────────

import type { LocalDocument, LocalHtmlPolicy, LocalNode } from 'reactive-md';
import { chatReactiveUrlPolicy } from './options';

/**
 * 文档策略身份；final 缓存键的一部分。
 * v4：编译前把插值按字面文本掩码，缓存结果与旧版不同。
 * v5：final 编译失败时改用 streaming 恢复，未支持组件降级为局部 fallback。
 * v6：reactive-md 0.9.3；literal + fallback 在编译期完成局部降级，策略只做
 *     最终能力收缩与 URL / 字段清洗，并输出静态视图所需的配置身份。
 */
export const CHAT_RMD_POLICY_VERSION = 'chat-rmd-policy/6';

/** 策略拒绝码：视图应显示完整源码。 */
export const CHAT_RMD_POLICY_UNSUPPORTED = 'policy.unsupported';

/**
 * v1 允许列表 = 现有 Markdown 结构 + 公式。字符串以 reactive-md 0.9.3 实际产出为准：
 * `emphasis`/`delete`/`thematicBreak` 分别对应 em/del/hr；`fallback` 是编译器自己的
 * 「按源码显示」节点（0.9.3 的 embedding 降级也产出它），保留它不会获得任何能力。
 *
 * 刻意排除：image / imageReference（原生图片）、hostComponent（作者伪造宿主节点）、
 * interpolation（表达式求值）、html / extendedHtml / div / span / htmlTable*
 * （HTML 通道）、linkReference / footnote*（引用解析）、comment / definition
 * （不渲染的元数据，保留字面量无害但无展示价值，统一转文本）。
 *
 * 组件只放行 minimal preset 里的**静态展示组件**（见 `CHAT_RMD_ALLOWED_COMPONENTS`），
 * 另放行 P0 HTML 的 `div` 静态 `align`（见 `CHAT_RMD_ALLOWED_DIV_ALIGN`）。
 * 输入 / 条件 / 绑定类组件仍按源码文本显示：它们的运行状态与表达式求值不在聊天的
 * 静态策略内。
 */
const CHAT_RMD_ALLOWED_NODE_TYPES: ReadonlySet<string> = new Set([
  'root',
  'paragraph',
  'heading',
  'text',
  'strong',
  'emphasis',
  'delete',
  'code',
  'inlineCode',
  'link',
  'blockquote',
  'list',
  'listItem',
  'thematicBreak',
  'break',
  'table',
  'tableBody',
  'tableRow',
  'tableCell',
  'math',
  'inlineMath',
  'fallback',
]);

/**
 * 允许的静态展示组件及其静态属性。只收 minimal preset 里不产生交互状态、不读取
 * 绑定、不触发动作的容器 / 文本组件；输入控件、`if`、`jump` 等仍按源码显示。
 * 属性值出现 `{{` 一律拒绝：动态属性意味着表达式求值，不进入聊天静态文档。
 */
const CHAT_RMD_ALLOWED_COMPONENTS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  alert: ['tone', 'title'],
  badge: ['tone', 'color'],
  panel: ['title', 'reset'],
  card: ['title'],
  section: ['color'],
  grid: ['columns'],
  text: ['color'],
});

/** `div` 只放行 P0 HTML 的静态 align；class/style 等属性在编译期已拒绝。 */
const CHAT_RMD_ALLOWED_DIV_ALIGN: ReadonlySet<string> = new Set([
  'left',
  'center',
  'right',
  'justify',
]);

function isAllowedChatDiv(node: LocalNode): boolean {
  if (node.type !== 'div') return false;
  const attrs = node.attrs ?? {};
  const keys = Object.keys(attrs);
  if (keys.length !== 1 || keys[0] !== 'align') return false;
  const value = attrs.align;
  return typeof value === 'string' && CHAT_RMD_ALLOWED_DIV_ALIGN.has(value.toLowerCase());
}

function isAllowedChatComponent(node: LocalNode): boolean {
  if (node.type !== 'component' || typeof node.name !== 'string') return false;
  const allowedAttrs = CHAT_RMD_ALLOWED_COMPONENTS[node.name];
  if (!allowedAttrs) return false;
  const attrs = node.attrs ?? {};
  for (const [key, value] of Object.entries(attrs)) {
    if (!allowedAttrs.includes(key)) return false;
    if (typeof value !== 'string' || value.includes('{{')) return false;
  }
  return true;
}

const CHAT_RMD_DISABLED_HTML_POLICY: LocalHtmlPolicy = Object.freeze({
  enableCss: false,
  enableJavaScript: false,
  enableExtendedHtml: false,
});

export type ChatDocumentPolicyResult =
  | { ok: true; document: LocalDocument }
  | { ok: false; code: string };

function sanitizeCapabilities(): NonNullable<LocalDocument['capabilities']> {
  return {
    policy: CHAT_RMD_DISABLED_HTML_POLICY,
    styles: [],
    scripts: [],
    componentStyles: {},
    actionTargets: {},
  };
}

function readRange(node: LocalNode, sourceLength: number): { start: number; end: number } | null {
  const range = node.range;
  if (
    range &&
    Number.isInteger(range.start) &&
    Number.isInteger(range.end) &&
    range.start >= 0 &&
    range.end >= range.start &&
    range.end <= sourceLength
  ) {
    return { start: range.start, end: range.end };
  }
  return null;
}

function normalizeRange(node: LocalNode, sourceLength: number): { start: number; end: number } {
  return readRange(node, sourceLength) ?? { start: 0, end: 0 };
}

function readRawSource(node: LocalNode, source: string): string | null {
  const range = readRange(node, source.length);
  if (range && range.end > range.start) return source.slice(range.start, range.end);
  if (typeof node.value === 'string' && node.value.length > 0) return node.value;
  return null;
}

function literalTextNode(node: LocalNode, source: string): LocalNode | null {
  const raw = readRawSource(node, source);
  if (raw === null) return null;
  return {
    type: 'text',
    id: typeof node.id === 'string' ? node.id : '',
    range: normalizeRange(node, source.length),
    value: raw,
  };
}

function readAlign(value: LocalNode['align']): LocalNode['align'] | undefined {
  if (!Array.isArray(value)) return undefined;
  const align = value.filter(
    (entry): entry is 'left' | 'center' | 'right' | null =>
      entry === 'left' || entry === 'center' || entry === 'right' || entry === null
  );
  return align.length === value.length ? align : undefined;
}

/** 只重建白名单字段：作者的 attrs 一律丢弃，避免 data-* / aria-* / 锚点等旁路。 */
function rebuildAllowedNode(
  node: LocalNode,
  source: string,
  transformChildren: (children: LocalNode[]) => LocalNode[] | null
): LocalNode | null {
  const safe: LocalNode = {
    type: node.type,
    id: typeof node.id === 'string' ? node.id : '',
    range: normalizeRange(node, source.length),
  };

  if (typeof node.value === 'string') safe.value = node.value;
  if (typeof node.url === 'string') safe.url = node.url;
  if (typeof node.title === 'string' || node.title === null) safe.title = node.title;
  if (typeof node.depth === 'number') safe.depth = node.depth;
  if (typeof node.ordered === 'boolean') safe.ordered = node.ordered;
  if (typeof node.start === 'number') safe.start = node.start;
  if (node.checked === true || node.checked === false || node.checked === null) {
    safe.checked = node.checked;
  }
  if (typeof node.lang === 'string') safe.lang = node.lang;
  const align = readAlign(node.align);
  if (align) safe.align = align;

  if (node.type === 'component' && typeof node.name === 'string') {
    safe.name = node.name;
    const allowedAttrs = CHAT_RMD_ALLOWED_COMPONENTS[node.name] ?? [];
    const attrs: Record<string, string> = {};
    for (const key of allowedAttrs) {
      const value = node.attrs?.[key];
      if (typeof value === 'string') attrs[key] = value;
    }
    safe.attrs = attrs;
  }

  if (node.type === 'div' && typeof node.attrs?.align === 'string') {
    safe.attrs = { align: node.attrs.align };
  }

  if (node.children && node.children.length > 0) {
    const children = transformChildren(node.children);
    if (!children) return null;
    safe.children = children;
  }
  return safe;
}

function transformNodes(nodes: readonly LocalNode[], source: string): LocalNode[] | null {
  const output: LocalNode[] = [];
  for (const node of nodes) {
    if (!node || typeof node.type !== 'string') return null;
    const transformed = transformNode(node, source);
    if (!transformed) return null;
    output.push(...transformed);
  }
  return output;
}

function transformNode(node: LocalNode, source: string): LocalNode[] | null {
  if (node.type === 'link') {
    const hrefAllowed = typeof node.url === 'string' && chatReactiveUrlPolicy(node.url, 'link');
    if (!hrefAllowed) {
      // 不合格链接降级为文本：有子节点就保留可见文字，否则回退到原始源码。
      if (node.children && node.children.length > 0) {
        const children = transformNodes(node.children, source);
        if (children) return children;
      }
      const literal = literalTextNode(node, source);
      return literal ? [literal] : null;
    }
  }

  if (node.type === 'component') {
    if (!isAllowedChatComponent(node)) {
      const literal = literalTextNode(node, source);
      return literal ? [literal] : null;
    }
    const rebuilt = rebuildAllowedNode(node, source, (children) => transformNodes(children, source));
    if (rebuilt) return [rebuilt];
    const literal = literalTextNode(node, source);
    return literal ? [literal] : null;
  }

  if (node.type === 'div') {
    if (!isAllowedChatDiv(node)) {
      const literal = literalTextNode(node, source);
      return literal ? [literal] : null;
    }
    const rebuilt = rebuildAllowedNode(node, source, (children) => transformNodes(children, source));
    if (rebuilt) return [rebuilt];
    const literal = literalTextNode(node, source);
    return literal ? [literal] : null;
  }

  if (!CHAT_RMD_ALLOWED_NODE_TYPES.has(node.type)) {
    const literal = literalTextNode(node, source);
    return literal ? [literal] : null;
  }

  const rebuilt = rebuildAllowedNode(node, source, (children) => transformNodes(children, source));
  if (rebuilt) return [rebuilt];

  // 白名单节点自身无法重建（通常是被拒绝子节点也取不到源码）时，整段回退为源码。
  const literal = literalTextNode(node, source);
  return literal ? [literal] : null;
}

/** 剩余节点里的组件名，按首次出现去重；与编译器的 `usedComponents` 同口径。 */
function collectUsedComponents(nodes: readonly LocalNode[]): string[] {
  const seen = new Set<string>();
  const names: string[] = [];
  const walk = (list: readonly LocalNode[]): void => {
    for (const node of list) {
      if (node.type === 'component' && typeof node.name === 'string' && !seen.has(node.name)) {
        seen.add(node.name);
        names.push(node.name);
      }
      if (node.children) walk(node.children);
    }
  };
  walk(nodes);
  return names;
}

type ChatComponentDefinition = NonNullable<LocalDocument['componentDefinitions']>[number];

/**
 * 静态视图用 `componentDefinitions` 判断 `component` 节点能否脱离 runtime：
 * 缺条目或 `capabilities.static !== true` 都会把整篇判成「需要运行期」而拒绝渲染。
 * 只认白名单组件、且带静态能力的清单；其余字段保持编译器产出原文（plain data），
 * 上游会再用已安装的 reactConfig 校验摘要 —— 伪造条目只会得到诊断，不会获得能力。
 */
function isRenderableComponentDefinition(value: unknown): value is ChatComponentDefinition {
  if (!value || typeof value !== 'object') return false;
  const definition = value as Record<string, unknown>;
  if (typeof definition.id !== 'string' || typeof definition.version !== 'string') return false;
  if (
    typeof definition.name !== 'string' ||
    CHAT_RMD_ALLOWED_COMPONENTS[definition.name] === undefined
  ) {
    return false;
  }
  const capabilities = definition.capabilities;
  return (
    !!capabilities &&
    typeof capabilities === 'object' &&
    (capabilities as Record<string, unknown>).static === true
  );
}

function sanitizeComponentDefinitions(
  definitions: LocalDocument['componentDefinitions'],
  usedComponents: readonly string[]
): LocalDocument['componentDefinitions'] | undefined {
  if (!Array.isArray(definitions) || definitions.length === 0) return undefined;
  const used = new Set(usedComponents);
  const kept = definitions.filter(
    (definition) => isRenderableComponentDefinition(definition) && used.has(definition.name)
  );
  return kept.length > 0 ? kept : undefined;
}

/**
 * 把编译文档收缩为聊天静态视图允许的形状。
 *
 * 成功时：`requiresRuntime` 固定 false；能力开关全关；style / script / 计算 / 绑定 /
 * kernel 等运行期元数据全部清空或删除；节点只保留白名单类型与白名单字段。
 * `componentConfigKey` 与存活组件的清单保留给静态视图校验配置身份和静态能力。
 */
export function applyChatDocumentPolicy(document: LocalDocument): ChatDocumentPolicyResult {
  if (!document || typeof document.source !== 'string' || !Array.isArray(document.nodes)) {
    return { ok: false, code: CHAT_RMD_POLICY_UNSUPPORTED };
  }

  const nodes = transformNodes(document.nodes, document.source);
  if (!nodes) return { ok: false, code: CHAT_RMD_POLICY_UNSUPPORTED };

  const usedComponents = collectUsedComponents(nodes);
  const componentDefinitions = sanitizeComponentDefinitions(
    document.componentDefinitions,
    usedComponents
  );

  const sanitized: LocalDocument = {
    syntax: 'local',
    source: document.source,
    requiresRuntime: false,
    usedComponents,
    nodes,
    initialState: {},
    bindings: {},
    // 不输出 legacy `html` 字段：上游静态视图看到任何 `html` 值都会把整篇判为
    // 需要运行期（历史整篇 HTML 通道）并拒绝渲染；HTML 能力由 capabilities 记录。
    capabilities: sanitizeCapabilities(),
  };
  if (document.syntaxVersion) sanitized.syntaxVersion = document.syntaxVersion;
  if (typeof document.componentConfigKey === 'string' && document.componentConfigKey.length > 0) {
    sanitized.componentConfigKey = document.componentConfigKey;
  }
  if (componentDefinitions) sanitized.componentDefinitions = componentDefinitions;

  return { ok: true, document: sanitized };
}
