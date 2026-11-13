// ─────────────────────────────────────────────────────────────────────────────
// reactive-source-migration.test.ts —— 版本指令与动态约束解析
//
// 覆盖「前导区在哪结束」「代码示例里的版本指令不算残留」「哪些动态属性真的阻塞」。
// 站点预算适配层（长文 10k 默认预算拒绝）的长夹具用例已删，由 service 层
// reactive-v07-migration 用真库覆盖同一条适配。夹具全部匿名、现生成，不读任何业务库。
// ─────────────────────────────────────────────────────────────────────────────

import { describe, expect, it } from 'vitest';
import {
  findDynamicConstraintActivations,
  migrateLocalSourceWithSiteBudget,
} from '@/lib/reactive/source-migration';
import {
  findLeadingVersionDirective,
  findVersionDirectives,
} from '@/lib/reactive/version-directive';

const OLD_DECLARATION = '<!-- reactive-md: local-draft-2 -->';

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
  it('非预算阻塞（未知版本）原样返回，不走适配', () => {
    const source = `${OLD_DECLARATION}\n\n正文`;
    const migrated = migrateLocalSourceWithSiteBudget(source, 'local-draft-9');
    expect(migrated.ok).toBe(false);
    expect(migrated.source).toBe(source);
  });
});
