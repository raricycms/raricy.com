// ─────────────────────────────────────────────────────────────────────────────
// reactive-source-migration.test.ts —— 站点预算迁移适配层
//
// 复现的是「站点编译通过、上游迁移器却按默认 10,000 节点预算拒绝」那条静默错：
// 长文正文既没有语法变化，也没有新激活标签，却整批迁移不动。夹具全部匿名、
// 现生成，不读任何业务库。
// ─────────────────────────────────────────────────────────────────────────────

import { describe, expect, it } from 'vitest';
import { compileLocal, LOCAL_SYNTAX_VERSION, migrateLocalSource } from 'reactive-md';
import {
  findDynamicConstraintActivations,
  migrateLocalSourceWithSiteBudget,
} from '@/lib/reactive/source-migration';
import {
  findLeadingVersionDirective,
  findVersionDirectives,
} from '@/lib/reactive/version-directive';
import { reactiveCompileOptions } from '@/lib/reactive/host-components';

const OLD_DECLARATION = '<!-- reactive-md: local-draft-2 -->';

/**
 * 6,000 个短段落：约 6,000 个语法节点。
 * 站点预算（15,000）通过；上游迁移器默认预算（10,000）拒绝。
 */
function longDraft2Source(paragraphs = 6000): string {
  return `${OLD_DECLARATION}\n\n${Array.from(
    { length: paragraphs },
    (_, index) => `第 ${index} 段`
  ).join('\n\n')}`;
}

describe('findLeadingVersionDirective', () => {
  it('识别 BOM、空行与普通注释之后的版本指令', () => {
    const source = `﻿\n<!-- ordinary comment -->\n\n${OLD_DECLARATION}\r\n\r\n正文`;
    const found = findLeadingVersionDirective(source);
    expect(found?.version).toBe('local-draft-2');
    expect(source.slice(found!.range.start, found!.range.end)).toBe(OLD_DECLARATION);
  });

  it('跨行普通注释之后仍能找到声明（与上游前导区规则一致）', () => {
    const source = `<!--
license note
-->
${OLD_DECLARATION}

正文`;
    const found = findLeadingVersionDirective(source);
    expect(found?.version).toBe('local-draft-2');
  });

  it('正文开始后出现的指令不算（避免把代码示例当成声明）', () => {
    const source = `正文\n\n${OLD_DECLARATION}`;
    expect(findLeadingVersionDirective(source)).toBeNull();
  });

  // R3-102：`<!-- 说明 --> 正文` 这种「注释行里还带正文」的形状不是前导注释；
  // 整行当注释跳过的旧实现会把下一行的旧声明误认成前导声明。
  it('同行注释 + 正文之后不再认声明（前导区到正文为止）', () => {
    expect(findLeadingVersionDirective(`<!-- 说明 --> 正文\n${OLD_DECLARATION}`)).toBeNull();
    expect(findLeadingVersionDirective(`<!-- 说明 -->正文\n\n${OLD_DECLARATION}`)).toBeNull();
    // 只有空白尾巴的注释行仍是合法前导注释
    expect(
      findLeadingVersionDirective(`<!-- 说明 -->   \n${OLD_DECLARATION}`)?.version
    ).toBe('local-draft-2');
  });

  it('跨行注释的结束行后面还带正文 → 同样停止（不再认声明）', () => {
    const source = `<!--\n说明\n--> 正文\n\n${OLD_DECLARATION}`;
    expect(findLeadingVersionDirective(source)).toBeNull();
  });
});

describe('findDynamicConstraintActivations：只看约束属性的值区间', () => {
  const CODES = (source: string) =>
    findDynamicConstraintActivations(source).map((diagnostic) => diagnostic.code);

  it('属性值里的动态 min/max/required 仍然阻塞（真阳性）', () => {
    expect(
      CODES(`<!-- reactive-md: local-draft-2 -->

<number bind="b" label="B" initial="5" min="{{ b }}" max="10">`)
    ).toEqual(['site.migration.dynamic-constraint']);

    expect(
      CODES(`<!-- reactive-md: local-draft-2 -->

<input bind="b" required="{{ flag }}" />`)
    ).toEqual(['site.migration.dynamic-constraint']);
  });

  it('★ 开标签之后的普通插值不是属性（不能再套用最后一个 min/max）', () => {
    expect(
      CODES(`<!-- reactive-md: local-draft-2 -->

<slider bind="b" label="B" initial="1" min="0" max="10">

当前值：{{ b }}`)
    ).toEqual([]);
  });

  it('非约束属性里的插值不阻塞（value / label / initial）', () => {
    expect(
      CODES(`<!-- reactive-md: local-draft-2 -->

<progress bind="p" label="{{ name }}" value="{{ p }}">`)
    ).toEqual([]);
  });

  it('闭标签之后的插值也不阻塞', () => {
    expect(
      CODES(`<!-- reactive-md: local-draft-2 -->

<date bind="d" label="D" initial="{{ today }}" min="2020-01-01"></date>

之后 {{ d }}`)
    ).toEqual([]);
  });
});

describe('findVersionDirectives：代码示例里的版本指令不算残留声明', () => {
  const CURRENT = '<!-- reactive-md: local-draft-3 -->';
  const OLD = '<!-- reactive-md: local-draft-2 -->';

  it('缩进代码块里的示例被屏蔽', () => {
    const source = `${CURRENT}

正文

    ${OLD}

尾部`;
    expect(findVersionDirectives(source).map((row) => row.version)).toEqual(['local-draft-3']);
  });

  it('引用块里的缩进代码示例被屏蔽', () => {
    const source = `${CURRENT}

> 示例：
>
>     ${OLD}`;
    expect(findVersionDirectives(source).map((row) => row.version)).toEqual(['local-draft-3']);
  });

  it('<pre> 里的示例被屏蔽（含属性）', () => {
    const source = `${CURRENT}

<pre class="example">${OLD}</pre>`;
    expect(findVersionDirectives(source).map((row) => row.version)).toEqual(['local-draft-3']);
  });

  it('真正的正文深处残留旧声明仍然被找到', () => {
    const source = `${CURRENT}

正文

${OLD}

尾部`;
    expect(findVersionDirectives(source).map((row) => row.version)).toEqual([
      'local-draft-3',
      'local-draft-2',
    ]);
  });
});

describe('migrateLocalSourceWithSiteBudget', () => {
  it('上游只因默认预算失败时，用站点预算完成迁移', () => {
    const source = longDraft2Source();

    // 前提：站点配置能编译，**上游迁移器本身确实因默认 10k 预算拒绝**。
    const compiled = compileLocal(source.replace(OLD_DECLARATION, `<!-- reactive-md: ${LOCAL_SYNTAX_VERSION} -->`), reactiveCompileOptions('reactive'));
    expect(compiled.ok).toBe(true);
    const upstream = migrateLocalSource(source, { fromVersion: 'local-draft-2' });
    expect(upstream.ok).toBe(false);
    expect(upstream.diagnostics.map((d) => d.code)).toEqual(['local.budget']);

    const migrated = migrateLocalSourceWithSiteBudget(source, 'local-draft-2');
    expect(migrated.ok).toBe(true);
    expect(migrated.changed).toBe(true);
    expect(migrated.source.startsWith(`<!-- reactive-md: ${LOCAL_SYNTAX_VERSION} -->`)).toBe(true);
    // 正文原始字节保持不动。
    expect(migrated.source.endsWith(source.slice(OLD_DECLARATION.length))).toBe(true);
    expect(compileLocal(migrated.source, reactiveCompileOptions('reactive')).ok).toBe(true);
  });

  it('没有版本指令时在 BOM 之后补指令，保留 CRLF', () => {
    const body = Array.from({ length: 6000 }, (_, index) => `段落 ${index}`).join('\r\n\r\n');
    const source = `﻿${body}`;
    const migrated = migrateLocalSourceWithSiteBudget(source, 'local-draft-2');
    expect(migrated.ok).toBe(true);
    expect(migrated.source.startsWith(`﻿<!-- reactive-md: ${LOCAL_SYNTAX_VERSION} -->\r\n\r\n`)).toBe(true);
  });

  it('★ 长文里的新激活 <external> 仍然整批阻塞，不被预算适配吞掉 ★', () => {
    const source = `${OLD_DECLARATION}\n\n${Array.from(
      { length: 3000 },
      (_, index) => `<external name="x${index}" type="number"></external>\n\n第 ${index} 段`
    ).join('\n\n')}`;
    const migrated = migrateLocalSourceWithSiteBudget(source, 'local-draft-2');
    expect(migrated.ok).toBe(false);
    expect(migrated.diagnostics.some((diagnostic) => diagnostic.code === 'local.upgrade.tag')).toBe(true);
  });

  it('站点预算仍不够时如实阻塞，不落一份没复核的正文', () => {
    const source = longDraft2Source(55_000);
    const migrated = migrateLocalSourceWithSiteBudget(source, 'local-draft-2');
    expect(migrated.ok).toBe(false);
    expect(migrated.source).toBe(source);
    expect(migrated.diagnostics.some((diagnostic) => diagnostic.code === 'local.budget')).toBe(true);
  });

  it('非预算阻塞（未知版本）原样返回，不走适配', () => {
    const source = `${OLD_DECLARATION}\n\n正文`;
    const migrated = migrateLocalSourceWithSiteBudget(source, 'local-draft-9');
    expect(migrated.ok).toBe(false);
    expect(migrated.source).toBe(source);
  });
});
