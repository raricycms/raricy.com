// ─────────────────────────────────────────────────────────────────────────────
// reactive-ref-adapter.test.ts —— 纯引用预适配（P3/P9）的**行为**用例
//
// 这些用例钉的都是「错了也不报错」的那几类：
//   · 代码块 / 行内代码里的 token 被展开（承诺过不展开，页面上却多出一个组件）；
//   · external 模式偷偷调 resolve（对外视图一渲染就发一串 core+ 请求）；
//   · 发了 `<site-embed>` 却没有 hostData（页面出现 local-host-unavailable 占位）；
//   · 预算数错（多展开 / 少展开一条，界面一切如常）；
//   · 作者伪造宿主标签没被转义（站点自己把作者手打的标签当组件渲染）。
//
// 刻意**不**断言源码字符串长什么样（除了产物本身必须逐字对上的标签 / URL）——
// 要的是行为，不是实现细节。
// ─────────────────────────────────────────────────────────────────────────────

import { describe, expect, it } from 'vitest';
import { ADAPTER_VERSION, adaptReactiveReferences, scanReactiveReferences } from '@/lib/reactive/ref-adapter';
import {
  locateDiagnosticRange,
  mapAdaptedRangeToSource,
  mapSourceRangeToAdapted,
} from '@/lib/reactive/source-map';
import type { ReferenceReader, ReferenceSlot, ResolvedReference } from '@/lib/reactive/ref-types';
import {
  MAX_BLOG_REF_ITEMS,
  MAX_REF_CONCURRENCY,
  MAX_REF_EXPAND_CHARS,
  MAX_REF_FETCHES,
} from '@/lib/content-refs';

const IMAGE_ID = 'AaBbCcDd10'; // 10 位
const AUDIO_ID = 'EeFfGgHh20'; // 10 位
const VOTE_ID = 'AbCdEf123'; // 9 位
const CLIP_ID = 'AbCd1234'; // 8 位
const FAV_ID = '123456'; // 6 位数字

const tag = (kind: string, ref: string) => `<site-embed kind="${kind}" ref="${ref}" />`;

/** 一个只按 kind 回固定结果的 reader，顺便记录调用。 */
function stubReader(
  impl: (slot: ReferenceSlot) => Promise<ResolvedReference | undefined> = async () => ({ status: 'ready' })
): { reader: ReferenceReader; calls: string[] } {
  const calls: string[] = [];
  const reader: ReferenceReader = async (slot) => {
    calls.push(`${slot.kind}:${slot.ref}`);
    return impl(slot);
  };
  return { reader, calls };
}

// ═══ 一、扫描 ════════════════════════════════════════════════════════════════

describe('scanReactiveReferences：按 id 长度分流、保持原文顺序', () => {
  it('四类数字 token 按长度认出，6 位必须纯数字', () => {
    const src = `a [@${CLIP_ID}] b [@ ${VOTE_ID} ] c [@${IMAGE_ID}] d [@${FAV_ID}] e [@abcdef]`;
    const slots = scanReactiveReferences(src);
    expect(slots.map((s) => s.kind)).toEqual(['clipboard', 'vote', 'image', 'favorite']);
    expect(slots.map((s) => s.ref)).toEqual([CLIP_ID, VOTE_ID, IMAGE_ID, FAV_ID]);
    // token 取原文（含内部空白），区间是 UTF-16 半开
    expect(src.slice(slots[1].start, slots[1].end)).toBe(`[@ ${VOTE_ID} ]`);
    expect(slots[0].end - slots[0].start).toBe(`[@${CLIP_ID}]`.length);
  });

  it('代码块与行内代码里的 token 不算（输出阶段也不改它们）', () => {
    const src =
      `正文 [@${CLIP_ID}]\n\n` +
      `\`\`\`\n[@${CLIP_ID}]\n\`\`\`\n\n` +
      '行内 `[@' + CLIP_ID + ']` 完';
    const slots = scanReactiveReferences(src);
    expect(slots).toHaveLength(1);
    expect(src.slice(slots[0].start, slots[0].end)).toBe(`[@${CLIP_ID}]`);
  });

  it('音频用现有 collector：白名单形态、最多 3 条、与数字引用一起按位置排序', () => {
    const audio = (i: number) => `[@音频/AaBbCcD${i}00]`;
    const src = `${audio(0)} x [@${IMAGE_ID}] y ${audio(1)} z ${audio(2)} w ${audio(3)}`;
    const slots = scanReactiveReferences(src);
    expect(slots.filter((s) => s.kind === 'audio')).toHaveLength(3);
    expect(slots.map((s) => s.kind)).toEqual(['audio', 'image', 'audio', 'audio']);
  });
});

// ═══ 二、expand 模式：生成组件与数据成对 ══════════════════════════════════════

describe('adaptReactiveReferences（expand）', () => {
  it('preserves separate favorite and audio budgets after fifty image embeds', async () => {
    const source = [
      ...Array.from({ length: 50 }, () => `[@${IMAGE_ID}]`),
      ...Array.from({ length: 4 }, () => `[@${FAV_ID}]`),
      ...Array.from({ length: 4 }, () => `[@音频/${AUDIO_ID}]`),
    ].join('\n');
    const result = await adaptReactiveReferences(source, {
      mode: 'expand', resolve: async () => ({ status: 'ready', payload: { count: 1 } }),
    });
    expect(result.adaptedSource.match(/kind="favorite"/g)).toHaveLength(3);
    expect(result.adaptedSource.match(/kind="audio"/g)).toHaveLength(3);
    expect(result.adaptedSource).toContain(`[@${FAV_ID}]`);
    expect(result.adaptedSource).toContain(`[@音频/${AUDIO_ID}]`);
  });
  it('五类引用各自落到正确形态，标签与 hostData 同时产出', async () => {
    const source = [
      `图 [@${IMAGE_ID}]`,
      `音 [@音频/${AUDIO_ID}]`,
      `投 [@${VOTE_ID}]`,
      `藏 [@${FAV_ID}]`,
      `板 [@${CLIP_ID}]`,
    ].join('\n');

    const { reader, calls } = stubReader(async (slot) => {
      if (slot.kind === 'clipboard') {
        return { status: 'ready', title: '一段笔记', format: 'reactive', version: 'v2' };
      }
      if (slot.kind === 'vote') return { status: 'ready', payload: { votes: 3 } };
      if (slot.kind === 'favorite') return { status: 'ready', payload: { count: 2 } };
      return { status: 'ready' };
    });

    const result = await adaptReactiveReferences(source, { mode: 'expand', resolve: reader });

    expect(result.adaptedSource).toContain(`![${IMAGE_ID}](/api/images/${IMAGE_ID}/raw)`);
    expect(result.adaptedSource).toContain(tag('audio', AUDIO_ID));
    expect(result.adaptedSource).toContain(tag('vote', VOTE_ID));
    expect(result.adaptedSource).toContain(tag('favorite', FAV_ID));
    expect(result.adaptedSource).toContain(tag('clipboard', CLIP_ID));

    // 键必须是 `${kind}:${ref}`（改了属性名 / 大小写，数据就永远取不到）
    expect(result.hostData[`audio:${AUDIO_ID}`]).toMatchObject({ kind: 'audio', ref: AUDIO_ID, status: 'ready' });
    expect(result.hostData[`vote:${VOTE_ID}`]).toMatchObject({ status: 'ready' });
    expect(result.hostData[`favorite:${FAV_ID}`]).toMatchObject({ status: 'ready' });
    expect(result.hostData[`clipboard:${CLIP_ID}`]).toMatchObject({ title: '一段笔记', format: 'reactive', version: 'v2' });

    // 剪贴板首期只做链接卡片：源码绝不进正文，也不进 hostData
    expect(result.adaptedSource).not.toContain('一段笔记');
    expect(result.hostData[`clipboard:${CLIP_ID}`].content).toBeUndefined();

    // 图片与音频不取数（音频 id 自带地址，raw 路由判权）
    expect(calls).not.toContain(`audio:${AUDIO_ID}`);
    expect(calls).not.toContain(`image:${IMAGE_ID}`);
    expect(calls.sort()).toEqual([`clipboard:${CLIP_ID}`, `favorite:${FAV_ID}`, `vote:${VOTE_ID}`].sort());
  });

  it('referenceSnapshotId 稳定；引用版本一变就变', async () => {
    const source = `板 [@${CLIP_ID}] 投 [@${VOTE_ID}]`;
    const a = await adaptReactiveReferences(source, {
      mode: 'expand',
      resolve: async () => ({ status: 'ready', version: 'v1' }),
    });
    const b = await adaptReactiveReferences(source, {
      mode: 'expand',
      resolve: async () => ({ status: 'ready', version: 'v1' }),
    });
    const c = await adaptReactiveReferences(source, {
      mode: 'expand',
      resolve: async () => ({ status: 'ready', version: 'v2' }),
    });
    expect(a.referenceSnapshotId).toBe(b.referenceSnapshotId);
    expect(a.referenceSnapshotId).not.toBe(c.referenceSnapshotId);
    expect(a.referenceSnapshotId).toContain(ADAPTER_VERSION);
  });
});

// ═══ 三、external 模式：一个请求都不发 ════════════════════════════════════════

describe('adaptReactiveReferences（external）', () => {
  it('绝不调用 resolve；投票 / 收藏夹保留字面量；剪贴板只认下发的公开数据', async () => {
    let resolveCalls = 0;
    const reader: ReferenceReader = async () => {
      resolveCalls += 1;
      throw new Error('external 模式不得调用 resolve');
    };
    const source = [
      `音 [@音频/${AUDIO_ID}]`,
      `投 [@${VOTE_ID}]`,
      `藏 [@${FAV_ID}]`,
      `有 [@${CLIP_ID}]`,
      '无 [@AbCd5678]',
    ].join('\n');

    const result = await adaptReactiveReferences(source, {
      mode: 'external',
      resolve: reader,
      externalClips: {
        [CLIP_ID]: { content: '公开正文', format: 'markdown', version: 'v1', title: '公开板' },
      },
    });

    expect(resolveCalls).toBe(0);
    expect(result.adaptedSource).toContain(tag('audio', AUDIO_ID));
    expect(result.adaptedSource).toContain(`[@${CLIP_ID}]`);
    // 投票 / 收藏夹：读口要 core+，对外视图保持字面量
    expect(result.adaptedSource).toContain(`[@${VOTE_ID}]`);
    expect(result.adaptedSource).toContain(`[@${FAV_ID}]`);
    // 不在下发表里的剪贴板也保持字面量 —— 不发标签就不会出现占位
    expect(result.adaptedSource).toContain('[@AbCd5678]');
    // 下发的正文只用于提供标题 / 版本，绝不内联
    expect(result.adaptedSource).not.toContain('公开正文');
    expect(result.hostData[`clipboard:${CLIP_ID}`]).toBeUndefined();
    expect(result.hostData[`vote:${VOTE_ID}`]).toBeUndefined();
  });
});

// ═══ 四、伪造的宿主标签 ══════════════════════════════════════════════════════

describe('作者伪造 `<site-embed`', () => {
  const forged = `<site-embed kind="audio" ref="${AUDIO_ID}" />`;

  it('盖码后转义正文里的伪造标签；代码块与行内代码原样保留', async () => {
    const code = `\`\`\`\n${forged}\n\`\`\``;
    const inline = '`' + forged + '`';
    const source = `前 ${forged} 后\n\n${code}\n\n${inline}`;

    const result = await adaptReactiveReferences(source, { mode: 'external' });

    expect(result.adaptedSource.startsWith('前 &lt;site-embed')).toBe(true);
    // 代码里的同形文本不动（与 `[@…]` 的盖码纪律同源）
    expect(result.adaptedSource).toContain(code);
    expect(result.adaptedSource).toContain(inline);
    // 没有真引用 → 也没有 hostData
    expect(Object.keys(result.hostData)).toHaveLength(0);
  });

  it('转义也生成正确的映射：诊断落到原文那个 `<` 上', async () => {
    const source = `前 ${forged} 后`;
    const result = await adaptReactiveReferences(source, { mode: 'external' });

    const at = result.adaptedSource.indexOf('&lt;');
    expect(at).toBeGreaterThanOrEqual(0);
    const mapped = locateDiagnosticRange(result.segments, { start: at, end: at + 4 });
    expect(mapped).toMatchObject({
      origin: 'generated',
      start: source.indexOf('<site-embed'),
      end: source.indexOf('<site-embed') + 1,
    });
  });
});

// ═══ 五、预算 ════════════════════════════════════════════════════════════════

describe('预算：替换数 / 取数数 / 去重 / 音频上限 / 总长度', () => {
  it(`第 ${MAX_BLOG_REF_ITEMS + 1} 处引用保留字面量`, async () => {
    const tokens = Array.from({ length: MAX_BLOG_REF_ITEMS + 1 }, () => `[@${IMAGE_ID}]`).join(' ');
    const result = await adaptReactiveReferences(tokens, { mode: 'external' });
    expect(result.adaptedSource.match(/!\[/g) ?? []).toHaveLength(MAX_BLOG_REF_ITEMS);
    expect(result.adaptedSource).toContain(`[@${IMAGE_ID}]`);
  });

  it(`最多 ${MAX_REF_FETCHES} 次真实取数（按 kind:ref 去重）`, async () => {
    let calls = 0;
    const reader: ReferenceReader = async () => {
      calls += 1;
      return undefined; // 全部保留字面量，只考察候选数
    };
    const tokens = Array.from({ length: MAX_REF_FETCHES + 1 }, (_, i) =>
      `[@${i.toString(36).padStart(8, '0')}]`
    ).join(' ');
    await adaptReactiveReferences(tokens, { mode: 'expand', resolve: reader });
    expect(calls).toBe(MAX_REF_FETCHES);
  });

  it('同一个 id 出现多次只取一次数，但每一处都替换', async () => {
    const { reader, calls } = stubReader(async () => ({ status: 'ready' }));
    const source = `[@${CLIP_ID}] 和 [@${CLIP_ID}] 还有 [@${CLIP_ID}]`;
    const result = await adaptReactiveReferences(source, { mode: 'expand', resolve: reader });
    expect(calls).toEqual([`clipboard:${CLIP_ID}`]);
    expect(result.adaptedSource.match(/<site-embed kind="clipboard"/g) ?? []).toHaveLength(3);
  });

  it('音频最多 3 条，第 4 条保留字面量', async () => {
    const tokens = Array.from({ length: 4 }, (_, i) => `[@音频/AaBbCcD${i}00]`);
    const result = await adaptReactiveReferences(tokens.join(' '), { mode: 'expand' });
    expect(result.adaptedSource.match(/<site-embed kind="audio"/g) ?? []).toHaveLength(3);
    expect(result.adaptedSource).toContain(tokens[3]);
  });

  it(`展开后总长不超过 ${MAX_REF_EXPAND_CHARS}；原文已满额时不再增长`, async () => {
    const token = `[@${IMAGE_ID}]`;
    const full = 'x'.repeat(MAX_REF_EXPAND_CHARS - token.length) + token;
    const over = await adaptReactiveReferences(full, { mode: 'external' });
    expect(over.adaptedSource).toContain(token);
    expect(over.adaptedSource).not.toContain('![');

    const roomy = 'x'.repeat(MAX_REF_EXPAND_CHARS - token.length - 100) + token;
    const fits = await adaptReactiveReferences(roomy, { mode: 'external' });
    expect(fits.adaptedSource).toContain(`![${IMAGE_ID}]`);
  });

  it(`真实取数并发不超过 ${MAX_REF_CONCURRENCY}`, async () => {
    let active = 0;
    let peak = 0;
    const reader: ReferenceReader = async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return { status: 'ready' };
    };
    const tokens = Array.from({ length: 12 }, (_, i) =>
      `[@${i.toString(36).padStart(8, '0')}]`
    ).join('\n');
    await adaptReactiveReferences(tokens, { mode: 'expand', resolve: reader });
    expect(peak).toBeLessThanOrEqual(MAX_REF_CONCURRENCY);
    expect(peak).toBeGreaterThan(1);
  });
});

// ═══ 六、局部失败 ════════════════════════════════════════════════════════════

describe('单个引用失败不拖垮整篇', () => {
  it('resolve 抛错 / 返回 undefined → 保留字面量；其余照常替换', async () => {
    const reader: ReferenceReader = async (slot) => {
      if (slot.kind === 'vote') throw new Error('boom');
      if (slot.kind === 'favorite') return undefined;
      return { status: 'ready' };
    };
    const source = `投 [@${VOTE_ID}] 藏 [@${FAV_ID}] 板 [@${CLIP_ID}] 图 [@${IMAGE_ID}]`;
    const result = await adaptReactiveReferences(source, { mode: 'expand', resolve: reader });

    expect(result.adaptedSource).toContain(`[@${VOTE_ID}]`);
    expect(result.adaptedSource).toContain(`[@${FAV_ID}]`);
    expect(result.adaptedSource).toContain(tag('clipboard', CLIP_ID));
    expect(result.adaptedSource).toContain(`![${IMAGE_ID}]`);
  });

  it('resolve 同步抛错也不逃逸', async () => {
    const syncThrow = ((slot: ReferenceSlot) => {
      void slot;
      throw new Error('sync');
    }) as unknown as ReferenceReader;
    const result = await adaptReactiveReferences(`板 [@${CLIP_ID}] 图 [@${IMAGE_ID}]`, {
      mode: 'expand',
      resolve: syncThrow,
    });
    expect(result.adaptedSource).toContain(`[@${CLIP_ID}]`);
    expect(result.adaptedSource).toContain(`![${IMAGE_ID}]`);
  });
});

// ═══ 七、区间映射 ════════════════════════════════════════════════════════════

describe('source-map：半开区间双向映射', () => {
  it('原文保留区精确往返；引用区间映射成整段生成内容', async () => {
    const token = `[@${CLIP_ID}]`;
    const source = `前缀 ${token} 后缀`;
    const result = await adaptReactiveReferences(source, {
      mode: 'expand',
      resolve: async () => ({ status: 'ready' }),
    });

    const tokenStart = source.indexOf(token);
    const tokenEnd = tokenStart + token.length;
    const tagRange = mapSourceRangeToAdapted(result.segments, { start: tokenStart, end: tokenEnd });
    expect(tagRange).not.toBeNull();
    expect(result.adaptedSource.slice(tagRange!.start, tagRange!.end)).toContain(
      tag('clipboard', CLIP_ID)
    );

    const inside = { start: tagRange!.start + 2, end: tagRange!.start + 6 };
    expect(mapAdaptedRangeToSource(result.segments, inside)).toEqual({ start: tokenStart, end: tokenEnd });
    expect(locateDiagnosticRange(result.segments, inside)).toMatchObject({
      origin: 'reference',
      kind: 'clipboard',
      ref: CLIP_ID,
      start: tokenStart,
      end: tokenEnd,
    });

    const prefix = { start: 0, end: 3 };
    expect(mapAdaptedRangeToSource(result.segments, prefix)).toEqual(prefix);
    expect(mapSourceRangeToAdapted(result.segments, prefix)).toEqual(prefix);
  });

  it('没有引用时输出逐字不变、映射是一整段 source', async () => {
    const plain = '普通正文，没有引用。';
    const result = await adaptReactiveReferences(plain, { mode: 'external' });
    expect(result.adaptedSource).toBe(plain);
    expect(result.hostData).toEqual({});
    expect(result.segments).toEqual([
      { origin: 'source', sourceStart: 0, sourceEnd: plain.length, adaptedStart: 0, adaptedEnd: plain.length },
    ]);
  });

  it('空正文也不炸', async () => {
    const result = await adaptReactiveReferences('', { mode: 'external' });
    expect(result.adaptedSource).toBe('');
    expect(result.segments).toEqual([]);
    expect(result.hostData).toEqual({});
    expect(result.referenceSnapshotId).toContain(`adapter=${ADAPTER_VERSION}`);
  });
});
