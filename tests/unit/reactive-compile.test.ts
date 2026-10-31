// ─────────────────────────────────────────────────────────────────────────────
// reactive-compile.test.ts —— 服务端编译核心（T2）的**行为**用例
//
// 钉的是四类「错了也不报错」的事：
//   · 宿主 schema 没生效（`<site-embed>` 变成未知组件 / 诊断满屏）；
//   · 作者伪造的 `<site-embed>` 被当成真宿主节点（安全边界）；
//   · 回退判据只看 `ok`（HTML / 未知组件 / 数学降级会静默改内容）；
//   · 缓存键少一段（换个 format 仍命中旧编译）。
//
// 不读源码字符串、不碰数据库：用例里的正文都没有 `[@…]` 引用。
// ─────────────────────────────────────────────────────────────────────────────

import { beforeEach, describe, expect, it } from 'vitest';
import { compileLocal } from 'reactive-md';
import type { LocalNode } from 'reactive-md';

import {
  reactiveCompileOptions,
  SITE_EMBED_TAG,
} from '@/lib/reactive/host-components';
import {
  REACTIVE_FALLBACK_CODES,
  reactiveDiagnosticCodes,
  reactiveFallbackReasons,
  shouldRejectReactive,
  shouldFallbackToLegacy,
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
      reactiveCompileOptions('reactive')
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

// ═══ 三、回退判据 ════════════════════════════════════════════════════════════

describe('回退判据', () => {
  const options = reactiveCompileOptions('reactive');

  it('干净编译不回退', () => {
    const result = compileLocal('普通正文，没有特殊语法。', options);
    expect(result.ok).toBe(true);
    expect(shouldFallbackToLegacy(result)).toBe(false);
    expect(reactiveFallbackReasons(result)).toEqual([]);
  });

  it.each([
    '<div class="x">hi</div>',
    '<table><tr><td colspan="bad">x</td></tr></table>',
    '<div style="color:red">{{ missing }}',
  ])('原生 HTML 局部降级：Markdown 回退，Reactive 可发布 %s', (source) => {
    const result = compileLocal(`${source}\n\n<counter bind="n" label="N" initial="2">`, options);
    expect(result.ok).toBe(true);
    expect(reactiveDiagnosticCodes(result)).toContain('local.html.fallback');
    expect(shouldFallbackToLegacy(result)).toBe(true);
    expect(shouldRejectReactive(result)).toBe(false);
    if (result.ok) {
      expect(collectNodes(result.document.nodes, 'fallback')[0]?.value).toBe(source);
      expect(result.document.bindings.n).toBeDefined();
    }
  });

  it('local.component.unknown（未知标签）会回退', () => {
    const result = compileLocal('<audio controls></audio>', options);
    expect(reactiveDiagnosticCodes(result)).toContain('local.component.unknown');
    expect(shouldFallbackToLegacy(result)).toBe(true);
    expect(shouldRejectReactive(result)).toBe(true);
  });

  it('安全 HTML 回退不能掩盖同一篇里的未知组件', () => {
    const result = compileLocal('<div class="x">hi</div>\n\n<my-widget />', options);
    expect(result.ok).toBe(true);
    expect(reactiveDiagnosticCodes(result)).toEqual(expect.arrayContaining(['local.html.fallback', 'local.component.unknown']));
    expect(shouldRejectReactive(result)).toBe(true);
  });

  it('数学显示降级（粗码与细分 messageKey）都会回退', () => {
    const command = compileLocal(String.raw`$\foo{x}$`, options);
    expect(command.ok).toBe(true);
    expect(reactiveDiagnosticCodes(command)).toContain('local.math.display');
    expect(reactiveFallbackReasons(command)).toContain('local.math.display.unsupported-command');
    expect(shouldFallbackToLegacy(command)).toBe(true);
    expect(shouldRejectReactive(command)).toBe(true);

    const environment = compileLocal(
      String.raw`$$\begin{unknown}x\end{unknown}$$`,
      options
    );
    expect(reactiveFallbackReasons(environment)).toContain(
      'local.math.display.unsupported-environment'
    );
    expect(shouldFallbackToLegacy(environment)).toBe(true);
  });

  it('反斜线行内和块级公式能编译为数学节点', () => {
    const result = compileLocal(String.raw`行内 \(x^2\)` + '\n\n' + String.raw`\[y^2\]`, reactiveCompileOptions('markdown'));
    expect(result.ok).toBe(true);
    expect(shouldFallbackToLegacy(result)).toBe(false);
    if (result.ok) {
      expect(collectNodes(result.document.nodes, 'inlineMath')).toHaveLength(1);
      expect(collectNodes(result.document.nodes, 'math')).toHaveLength(1);
    }
  });

  it('ok:false 一定回退，即使没有命中白名单', () => {
    const result = compileLocal('<panel title="x">', options);
    expect(result.ok).toBe(false);
    expect(shouldFallbackToLegacy(result)).toBe(true);
  });

  it('白名单包含契约要求的全部码', () => {
    for (const code of [
      'local.html',
      'local.html.fallback',
      'local.component.unknown',
      'local.options.invalid',
      'local.budget',
      'local.math.display.unsupported-command',
      'local.math.display.unsupported-environment',
      'local.math.display.budget',
      'local.math.display.stray-end',
      'local.math.display.environment-unclosed',
      'local.math.display.environment-missing-name',
      'local.math.display.syntax',
    ]) {
      expect(REACTIVE_FALLBACK_CODES).toContain(code);
    }
  });
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
    expect(first.compilerVersion).toBe('reactive-md/0.7.0');
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

  it('format 变化（选项键变化）必须 miss', async () => {
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

    expect(markdown.cacheHit).toBe(false);
    expect(markdown.cacheKey).not.toBe(reactive.cacheKey);
    expect(stats()).toMatchObject({ hits: 0, misses: 2 });
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
