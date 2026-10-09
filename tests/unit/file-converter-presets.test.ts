// ─────────────────────────────────────────────────────────────────────────────
// file-converter-presets.test.ts —— 用途预设 / 固定配方 与能力登记表的**对账**
//
// 【为什么需要这条】presets.ts 是纯数据，引用的是各 category 模块里的边 id 与
// 参数键。边改名、参数改名、边被降级为 planned —— 每一件都让预设静默变成
// 「点了没反应 / 参数被忽略」，而且**不报任何错**。这里把「预设引用的东西
// 必须真实存在且形状吻合」钉成单测。
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from 'vitest';
import { PRESETS, RECIPES } from '@/lib/file-converter/presets';
import { CATEGORIES } from '@/lib/file-converter/categories';
import { edgeById } from '@/lib/file-converter/registry';
import type { EdgeDef, ParamOption, ParamSpec } from '@/lib/file-converter/types';

function edgeInCategory(categoryKey: string, edgeId: string): EdgeDef | null {
  const cat = CATEGORIES.find((c) => c.key === categoryKey);
  return cat?.edges.find((e) => e.id === edgeId) ?? null;
}

function staticOptions(p: ParamSpec): ParamOption[] | null {
  if (Array.isArray(p.options)) return p.options;
  return null; // 动态选项（读 info.streams / sheets）在识别时才有意义，这里不展开
}

/** 预设参数值与 ParamSpec 的形状对账（能静态判的都判）。 */
function checkParamValue(edgeId: string, spec: ParamSpec, value: unknown): string | null {
  switch (spec.type) {
    case 'select': {
      if (typeof value !== 'string') return `${edgeId}: 参数 ${spec.key} 是 select，预设值必须是字符串`;
      const opts = staticOptions(spec);
      if (opts && !opts.some((o) => o.value === value)) {
        return `${edgeId}: 参数 ${spec.key} 的预设值 ${JSON.stringify(value)} 不在静态选项里`;
      }
      return null;
    }
    case 'range':
    case 'number': {
      if (typeof value !== 'number') return `${edgeId}: 参数 ${spec.key} 是 ${spec.type}，预设值必须是数字`;
      if (spec.min !== undefined && value < spec.min) return `${edgeId}: 参数 ${spec.key} 预设值 ${value} < min ${spec.min}`;
      if (spec.max !== undefined && value > spec.max) return `${edgeId}: 参数 ${spec.key} 预设值 ${value} > max ${spec.max}`;
      return null;
    }
    case 'checkbox':
      return typeof value === 'boolean' ? null : `${edgeId}: 参数 ${spec.key} 是 checkbox，预设值必须是布尔`;
    case 'color':
    case 'text':
      return typeof value === 'string' ? null : `${edgeId}: 参数 ${spec.key} 是 ${spec.type}，预设值必须是字符串`;
    default:
      return null;
  }
}

describe('用途预设与固定配方（roadmap §14 / §12.4）', () => {
  it('预设与配方 id 各自唯一、互不重叠', () => {
    const presetIds = PRESETS.map((p) => p.id);
    const recipeIds = RECIPES.map((r) => r.id);
    expect(new Set(presetIds).size).toBe(presetIds.length);
    expect(new Set(recipeIds).size).toBe(recipeIds.length);
    for (const id of recipeIds) expect(presetIds).not.toContain(id);
  });

  it.each([
    ...PRESETS.map((p) => ({ kind: 'preset' as const, def: p })),
    ...RECIPES.map((r) => ({ kind: 'recipe' as const, def: r })),
  ])('$kind $def.id 引用的边真实存在、可执行、类别吻合、参数吻合', ({ def }) => {
    // 边存在（全表查）
    const edge = edgeById(CATEGORIES, def.edgeId);
    expect(edge, `${def.id}: 边 ${def.edgeId} 在登记册里不存在`).not.toBeNull();

    // 预设引用的是可执行边 —— planned 边（如 office:docx-to-pdf）不许进预设
    expect(edge!.status, `${def.id}: 边 ${def.edgeId} 是 planned，不能做预设`).not.toBe('planned');

    // 类别吻合（预设落在它声明的那个标签页）
    const inCategory = edgeInCategory(def.category, def.edgeId);
    expect(inCategory, `${def.id}: 边 ${def.edgeId} 不在类别 ${def.category} 下`).not.toBeNull();

    // 参数键是边参数的子集，且值形状吻合
    const specByKey = new Map(edge!.params.map((p) => [p.key, p]));
    for (const [key, value] of Object.entries(def.params)) {
      const spec = specByKey.get(key);
      expect(spec, `${def.id}: 边 ${def.edgeId} 没有参数 ${key}`).toBeDefined();
      const problem = checkParamValue(def.edgeId, spec!, value);
      expect(problem, problem ?? '').toBeNull();
    }
  });

  it('配方的打包方式只认 zip / gzip', () => {
    for (const r of RECIPES) {
      expect(['zip', 'gzip'], `${r.id}: packaging=${r.packaging}`).toContain(r.packaging);
    }
  });
});
