// ─────────────────────────────────────────────────────────────────────────────
// reactive-compile.test.ts —— 服务端编译核心（T2）的**行为**用例
//
// 钉的是四类「错了也不报错」的事：
//   · 宿主 schema 没生效（`<site-embed>` 变成未知组件 / 诊断满屏）；
//   · 作者伪造的 `<site-embed>` 被当成真宿主节点（安全边界）；
//   · 拒绝判据只看 `ok`（HTML / 未知组件 / 数学降级会静默改内容）；
//   · 缓存键少一段（换个 format 仍命中旧编译）。
//
// 不读源码字符串、不碰数据库：用例里的正文都没有 `[@…]` 引用。
// ─────────────────────────────────────────────────────────────────────────────

import { beforeEach, describe, expect, it } from 'vitest';
import { compileLocal } from 'reactive-md';
import type { LocalDocument, LocalNode } from 'reactive-md';
import { getNativeComponentCatalog, renderNativeSnippet } from 'reactive-md/authoring';

import {
  REACTIVE_COMPILER_VERSION,
  REACTIVE_COMPILE_OPTIONS,
  SITE_EMBED_TAG,
} from '@/lib/reactive/host-components';
import { applyLegacyHtmlCompat } from '@/lib/reactive/legacy-compat';
import {
  reactiveDiagnosticCodes,
  reactiveFallbackReasons,
  shouldRejectReactive,
} from '@/lib/reactive/diagnostics';
import {
  compileReactiveSource,
  resetReactiveCompileCacheForTests,
  stats,
} from '@/lib/reactive/compile';

const EMBED_REF = 'AbCd1234Ef';

function collectNodes(nodes: readonly LocalNode[] | undefined, type: string): LocalNode[] {
  const found: LocalNode[] = [];
  const walk = (list: readonly LocalNode[]) => {
    for (const node of list) {
      if (node.type === type) found.push(node);
      if (node.children) walk(node.children);
    }
  };
  walk(nodes ?? []);
  return found;
}

// ═══ 一、宿主 schema ══════════════════════════════════════════════════════════

describe('SITE_EMBED_SCHEMA', () => {
  it('把 <site-embed> 编译成宿主节点，且不产生诊断', () => {
    const result = compileLocal(
      `<site-embed kind="audio" ref="${EMBED_REF}" />`,
      REACTIVE_COMPILE_OPTIONS
    );

    expect(result.ok).toBe(true);
    expect(result.diagnostics).toEqual([]);
    if (result.ok) {
      const hosts = collectNodes(result.document.nodes, 'hostComponent');
      expect(hosts).toHaveLength(1);
      expect(hosts[0]).toMatchObject({
        name: SITE_EMBED_TAG,
        attrs: { kind: 'audio', ref: EMBED_REF },
      });
    }
  });
});

// ═══ 二、作者伪造标签 ════════════════════════════════════════════════════════

describe('作者伪造的 <site-embed>', () => {
  it('适配器先转义，编译后不会变成宿主节点', async () => {
    resetReactiveCompileCacheForTests();
    const forged = `<site-embed kind="audio" ref="${EMBED_REF}" />`;

    const outcome = await compileReactiveSource({
      source: `前 ${forged} 后`,
      format: 'reactive',
      mode: 'external',
      viewer: null,
    });

    expect(outcome.adaptedSource).toContain('&lt;site-embed');
    expect(outcome.result.ok).toBe(true);
    if (outcome.result.ok) {
      expect(collectNodes(outcome.result.document.nodes, 'hostComponent')).toHaveLength(0);
    }
    // 没有真引用 → 也没有宿主数据
    expect(outcome.hostData).toEqual({});
  });
});

// ═══ 三、拒绝判据 ════════════════════════════════════════════════════════════

describe('拒绝判据', () => {
  const options = REACTIVE_COMPILE_OPTIONS;

  it('干净编译不拒绝', () => {
    const result = compileLocal('普通正文，没有特殊语法。', options);
    expect(result.ok).toBe(true);
    expect(reactiveFallbackReasons(result)).toEqual([]);
  });

  it.each([
    '<div class="x">hi</div>',
    '<table><tr><td colspan="bad">x</td></tr></table>',
    '<div style="color:red">{{ missing }}',
  ])('原生 HTML 局部降级：Reactive 接受局部源码回退，不拒绝 %s', (source) => {
    const result = compileLocal(`${source}\n\n<counter bind="n" label="N" initial="2">`, options);
    expect(result.ok).toBe(true);
    expect(reactiveDiagnosticCodes(result)).toContain('local.html.fallback');
    expect(shouldRejectReactive(result)).toBe(false);
    if (result.ok) {
      expect(collectNodes(result.document.nodes, 'fallback')[0]?.value).toBe(source);
      expect(result.document.bindings.n).toBeDefined();
    }
  });

  it('local.component.unknown（未知标签）会拒绝', () => {
    const result = compileLocal('<audio controls></audio>', options);
    expect(reactiveDiagnosticCodes(result)).toContain('local.component.unknown');
    expect(shouldRejectReactive(result)).toBe(true);
  });

  it('安全 HTML 回退不能掩盖同一篇里的未知组件', () => {
    const result = compileLocal('<div class="x">hi</div>\n\n<my-widget />', options);
    expect(result.ok).toBe(true);
    expect(reactiveDiagnosticCodes(result)).toEqual(expect.arrayContaining(['local.html.fallback', 'local.component.unknown']));
    expect(shouldRejectReactive(result)).toBe(true);
  });

  it('数学显示降级（粗码与细分 messageKey）都会拒绝', () => {
    const command = compileLocal(String.raw`$\foo{x}$`, options);
    expect(command.ok).toBe(true);
    expect(reactiveDiagnosticCodes(command)).toContain('local.math.display');
    expect(reactiveFallbackReasons(command)).toContain('local.math.display.unsupported-command');
    expect(shouldRejectReactive(command)).toBe(true);

    const environment = compileLocal(
      String.raw`$$\begin{unknown}x\end{unknown}$$`,
      options
    );
    expect(reactiveFallbackReasons(environment)).toContain(
      'local.math.display.unsupported-environment'
    );
    expect(shouldRejectReactive(environment)).toBe(true);
  });

  it('反斜线行内和块级公式能编译为数学节点', () => {
    const result = compileLocal(String.raw`行内 \(x^2\)` + '\n\n' + String.raw`\[y^2\]`, REACTIVE_COMPILE_OPTIONS);
    expect(result.ok).toBe(true);
    expect(reactiveFallbackReasons(result)).toEqual([]);
    if (result.ok) {
      expect(collectNodes(result.document.nodes, 'inlineMath')).toHaveLength(1);
      expect(collectNodes(result.document.nodes, 'math')).toHaveLength(1);
    }
  });

  it('ok:false 一定拒绝，即使没有命中白名单', () => {
    const result = compileLocal('{{ 1 + }}', options);
    expect(result.ok).toBe(false);
    expect(reactiveFallbackReasons(result)).toEqual([]);
    expect(shouldRejectReactive(result)).toBe(true);
  });

  // 原来还有一条「白名单包含契约要求的全部码」：逐字抄 REACTIVE_FALLBACK_CODES 的
  // 12 个字符串断言它们都在常量里 —— 它只复述实现常量本身，上游新增码或删码都
  // 抓不到，真正的风险（降级码不在白名单 → 静默放行）由上面各条的 shouldRejectReactive
  // 行为断言覆盖。按 R4 静态清单口径删除（R4）。
});

// ═══ 四、编译缓存 ════════════════════════════════════════════════════════════

describe('compileReactiveSource 缓存', () => {
  const source = '缓存用例正文，没有引用。';

  beforeEach(() => {
    resetReactiveCompileCacheForTests();
  });

  it('相同输入命中缓存；键相同', async () => {
    const first = await compileReactiveSource({
      source,
      format: 'reactive',
      mode: 'external',
      viewer: null,
    });
    const second = await compileReactiveSource({
      source,
      format: 'reactive',
      mode: 'external',
      viewer: null,
    });

    expect(first.cacheHit).toBe(false);
    expect(second.cacheHit).toBe(true);
    expect(second.cacheKey).toBe(first.cacheKey);
    expect(stats()).toMatchObject({ hits: 1, misses: 1, entries: 1 });
  });

  it('首次编译和缓存命中都返回可跨 RSC 边界的普通数据', async () => {
    const input = {
      source: '<counter bind="n" label="N" initial="2">\n\n当前 {{ n }}',
      format: 'reactive' as const,
      mode: 'external' as const,
      viewer: null,
    };
    const first = await compileReactiveSource(input);
    const second = await compileReactiveSource(input);
    expect(first.cacheHit).toBe(false);
    expect(second.cacheHit).toBe(true);
    // 版本常量是缓存键的一段：写死版本号会在每次升级依赖时制造一处无意义同步点。
    expect(first.compilerVersion).toBe(REACTIVE_COMPILER_VERSION);
    const visited = new Set<object>();
    const expectPlain = (value: unknown): void => {
      if (!value || typeof value !== 'object' || visited.has(value)) return;
      visited.add(value);
      expect(Object.getPrototypeOf(value)).toBe(Array.isArray(value) ? Array.prototype : Object.prototype);
      Object.values(value).forEach(expectPlain);
    };
    expectPlain(first.result);
    expectPlain(second.result);
  });

  it('format 不再切换编译选项：同一份源码命中同一份编译结果', async () => {
    const reactive = await compileReactiveSource({
      source,
      format: 'reactive',
      mode: 'external',
      viewer: null,
    });
    const markdown = await compileReactiveSource({
      source,
      format: 'markdown',
      mode: 'external',
      viewer: null,
    });

    // markdownBreaks 已统一为 true：format 不再改变选项键，结果可以复用。
    expect(markdown.cacheHit).toBe(true);
    expect(markdown.cacheKey).toBe(reactive.cacheKey);
    expect(stats()).toMatchObject({ hits: 1, misses: 1 });
  });

  it('调用方改自己的结果不会污染缓存', async () => {
    const first = await compileReactiveSource({
      source,
      format: 'reactive',
      mode: 'external',
      viewer: null,
    });
    const firstJson = JSON.stringify(first.result);

    const second = await compileReactiveSource({
      source,
      format: 'reactive',
      mode: 'external',
      viewer: null,
    });
    expect(second.cacheHit).toBe(true);
    if (second.result.ok) {
      second.result.diagnostics.push({
        code: 'test.mutated',
        message: 'caller mutation',
        severity: 'warning',
        range: { start: 0, end: 0 },
        line: 1,
        column: 1,
      });
    }

    const third = await compileReactiveSource({
      source,
      format: 'reactive',
      mode: 'external',
      viewer: null,
    });
    expect(third.cacheHit).toBe(true);
    expect(third.result.diagnostics).toHaveLength(0);
    expect(JSON.stringify(first.result)).toBe(firstJson);
  });
});

// ═══ 五、Components 目录模板 × 统一编译管线 ═══════════════════════════════════
//
// 原 reactive-catalog-matrix.test.ts 并入这里（R4）：它本来就是「统一 compat + 编译」
// 的行为用例，与本节共用同一套夹具，不必再单独维护一个编译测试文件。
// 目录来自上游 getNativeComponentCatalog('zh')（与编辑器菜单同一份事实）。

function instantiateCatalogTemplate(
  component: ReturnType<typeof getNativeComponentCatalog>['components'][number]
): string {
  return renderNativeSnippet(component, '')
    .replace(/\{\{selection(?::(.*?))?\}\}/g, '$1')
    .replace(/\{\{caret\}\}/g, '')
    .replace(/\{\{select:(.*?)\}\}/g, '$1');
}

function componentNames(document: LocalDocument): string[] {
  const names: string[] = [];
  const walk = (nodes: LocalDocument['nodes']): void => {
    for (const node of nodes) {
      if (node.type === 'component' && node.name) names.push(node.name);
      if (node.children) walk(node.children);
    }
  };
  walk(document.nodes);
  return names;
}

describe('Components 目录模板 × 统一编译管线', () => {
  const catalog = getNativeComponentCatalog('zh');

  it('★ 目录非空，且每个模板都真的编译成对应组件节点 ★', () => {
    expect(catalog.components.length).toBeGreaterThan(20);
    for (const component of catalog.components) {
      const source = instantiateCatalogTemplate(component);
      const compat = applyLegacyHtmlCompat(source);
      // 只断言 ok 不够：section / table / progress 被当成历史 HTML 解包后同样 ok，
      // 但组件语义已经永久丢失。这里必须看到真实 component 节点。
      expect(compat.source, `${component.id} 的标签被 compat 改写`).toContain(`<${component.id}`);
      const result = compileLocal(compat.source, REACTIVE_COMPILE_OPTIONS);
      const codes = result.diagnostics.map((d) => d.code);
      expect(result.ok, `${component.id}: ${codes.join(', ')}`).toBe(true);
      expect(codes, component.id).not.toContain('local.component.unknown');
      if (!result.ok) continue; // 上面的断言已失败；这里只为类型收窄
      expect(componentNames(result.document), component.id).toContain(component.id);
    }
  });

  it('旧 HTML 的 <select><option> 仍按历史标签处理，不误当组件子结构', () => {
    const compat = applyLegacyHtmlCompat('<select><option value="a">A</option></select>');
    expect(compat.source).not.toContain('<option');
    expect(compileLocal(compat.source, REACTIVE_COMPILE_OPTIONS).ok).toBe(true);
  });
});
