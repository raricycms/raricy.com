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

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { compileLocal } from 'reactive-md';
import ReactiveSubDocument from '@/app/components/reactive/ReactiveSubDocument';
import { renderSiteEmbedStatic } from '@/app/components/reactive/site-embed-static';
import {
  __resetInlineMarkdownCacheForTests,
  adaptReactiveReferences,
  prepareInlineMarkdownDocument,
  scanReactiveReferences,
} from '@/lib/reactive/ref-adapter';
import { checkSyntaxBudget } from '@/lib/reactive/syntax-budget';
import type { SiteMediaPayload } from '@/lib/reactive/ref-types';
import { applyLegacyHtmlCompat } from '@/lib/reactive/legacy-compat';
import { reactiveCompileOptions } from '@/lib/reactive/host-components';
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
const MEDIA_REF = 'abcdef1234'; // compat 的 10 位小写十六进制

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

  it('同输入同引用版本 → 产物稳定；引用版本变化反映在 hostData 上', async () => {
    const source = `板 [@${CLIP_ID}] 投 [@${VOTE_ID}]`;
    const run = (version: string) =>
      adaptReactiveReferences(source, {
        mode: 'expand',
        resolve: async () => ({ status: 'ready', version }),
      });
    const a = await run('v1');
    const b = await run('v1');
    const c = await run('v2');
    expect(a.adaptedSource).toBe(b.adaptedSource);
    expect(a.hostData).toEqual(b.hostData);
    expect(c.hostData).not.toEqual(a.hostData);
  });
});

// ═══ 三、external 模式：一个请求都不发 ════════════════════════════════════════

describe('adaptReactiveReferences（external）', () => {
  it('绝不调用 resolve；剪贴板 / 投票 / 收藏夹一律保留字面量，只展开音频', async () => {
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
    });

    expect(resolveCalls).toBe(0);
    expect(result.adaptedSource).toContain(tag('audio', AUDIO_ID));
    expect(result.adaptedSource).toContain(`[@${CLIP_ID}]`);
    // 投票 / 收藏夹：读口要 core+，对外视图保持字面量
    expect(result.adaptedSource).toContain(`[@${VOTE_ID}]`);
    expect(result.adaptedSource).toContain(`[@${FAV_ID}]`);
    // 剪贴板也不展开 —— 不发标签就不会出现占位
    expect(result.adaptedSource).toContain('[@AbCd5678]');
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

  it('转义只替换开头的 `<`，其余逐字保留', async () => {
    const source = `前 ${forged} 后`;
    const result = await adaptReactiveReferences(source, { mode: 'external' });

    const at = result.adaptedSource.indexOf('&lt;');
    expect(at).toBeGreaterThanOrEqual(0);
    expect(result.adaptedSource).toBe(source.replace('<', '&lt;'));
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

  // R3-103 的「两次并发适配共享同一条闸门（生产里是 client-compile 的模块级闸门）」
  // 已有更贴近生产的守护：reactive-client-compile.test.ts 的
  // describe('预览与导出共享同一条取数闸门') —— 它直接并发调用两处真实入口，
  // 因此这里不再用注入 scheduler 的方式复述同一条规则（R4 去重）。
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

// ═══ 七、产物形状与稳定性（区间映射已随快照机制退出，见 R3-106）════════════

describe('适配产物：替换落点精确、同输入稳定', () => {
  it('引用替换只落在 token 区间，前缀/后缀逐字保留', async () => {
    const token = `[@${CLIP_ID}]`;
    const source = `前缀 ${token} 后缀`;
    const result = await adaptReactiveReferences(source, {
      mode: 'expand',
      resolve: async () => ({ status: 'ready' }),
    });

    expect(result.adaptedSource.startsWith('前缀 ')).toBe(true);
    expect(result.adaptedSource).toContain(tag('clipboard', CLIP_ID));
    expect(result.adaptedSource.endsWith(' 后缀')).toBe(true);
  });

  it('没有引用时输出逐字不变', async () => {
    const plain = '普通正文，没有引用。';
    const result = await adaptReactiveReferences(plain, { mode: 'external' });
    expect(result.adaptedSource).toBe(plain);
    expect(result.hostData).toEqual({});
  });

  it('空正文也不炸', async () => {
    const result = await adaptReactiveReferences('', { mode: 'external' });
    expect(result.adaptedSource).toBe('');
    expect(result.hostData).toEqual({});
  });
});

// ═══ 剪贴板内联语义 ═══════════════════════════════════════════════════════════

describe('剪贴板引用：Markdown 子剪贴板内联一层（与父文档格式无关）', () => {
  const content = '# 子标题\n\n子正文';

  async function adapt(mode: 'expand' | 'external') {
    return adaptReactiveReferences(`前 [@${CLIP_ID}] 后`, {
      mode,
      resolve: async () => ({
        status: 'ready',
        title: '子剪贴板',
        format: 'markdown',
        content,
        version: 'v1',
      }),
    });
  }

  it('★ Markdown 子剪贴板 → hostData 携带同版本静态子文档 ★', async () => {
    const result = await adapt('expand');
    const data = result.hostData[`clipboard:${CLIP_ID}`];
    expect(data).toMatchObject({ kind: 'clipboard', status: 'ready', title: '子剪贴板' });
    // 原始正文不再下发：消费者只有编译后的子文档。
    expect(data.content).toBeUndefined();
    expect(data.document).toBeDefined();
    expect(data.hostData).toBeDefined();

    // 与详情页同一条准备链：compat → external 适配 → markdown 编译选项。
    const compat = applyLegacyHtmlCompat(content);
    const direct = await adaptReactiveReferences(compat.source, {
      mode: 'external',
      dataImages: compat.dataImages,
    });
    const compiled = compileLocal(direct.adaptedSource, reactiveCompileOptions('markdown'));
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    expect(data.document).toEqual(compiled.document);
    expect(data.hostData).toEqual(direct.hostData);
  });

  it('Markdown 子剪贴板即使父文档是 Reactive 也内联（format 升级后阅读不变）', async () => {
    const result = await adapt('expand');
    const data = result.hostData[`clipboard:${CLIP_ID}`];
    expect(data.kind).toBe('clipboard');
    expect(data.document).toBeDefined();
    expect(data.content).toBeUndefined();
  });

  it('external 视图不取数、不携带正文（全部保留字面量）', async () => {
    const result = await adapt('external');
    expect(result.hostData[`clipboard:${CLIP_ID}`]).toBeUndefined();
    expect(result.adaptedSource).toContain(`[@${CLIP_ID}]`);
  });

  it('Reactive 子剪贴板不内联（不嵌套 Reactive 运行时）', async () => {
    const result = await adaptReactiveReferences(`[@${CLIP_ID}]`, {
      mode: 'expand',
      resolve: async () => ({
        status: 'ready',
        title: 'reactive 子剪贴板',
        format: 'reactive',
        content: '<counter bind="n" label="N" initial="1" />',
      }),
    });
    expect(result.hostData[`clipboard:${CLIP_ID}`].content).toBeUndefined();
    expect(result.hostData[`clipboard:${CLIP_ID}`].document).toBeUndefined();
  });

  it('子正文按自己的 Markdown 语义清洗：媒体、公式与详情页同一份产物', async () => {
    const media =
      '<video src="https://third-party.example/a.mp4"></video>\n\n公式 $x^2$ 与 **粗体**。\n\n[@AbCd5678]';
    const result = await adaptReactiveReferences(`前 [@${CLIP_ID}] 后`, {
      mode: 'expand',
      resolve: async () => ({
        status: 'ready',
        title: '媒体子剪贴板',
        format: 'markdown',
        content: media,
        version: 'v1',
      }),
    });
    const data = result.hostData[`clipboard:${CLIP_ID}`];
    expect(data.document).toBeDefined();
    if (!data.document) return;

    const types: string[] = [];
    const walk = (nodes: typeof data.document.nodes): void => {
      for (const node of nodes) {
        types.push(node.type);
        if (node.children) walk(node.children);
      }
    };
    walk(data.document.nodes);

    // 历史 `<video>` 走受限 media host（可播放 controls，preload=none、无 autoplay）；
    // 公式按 Markdown 模板编译成 inlineMath 节点；嵌套剪贴板 token 仍是字面量（不递归）。
    expect(types).not.toContain('htmlDocument');
    expect(types).toContain('hostComponent');
    const mediaKeys = Object.keys(data.hostData ?? {}).filter((key) => key.startsWith('media:'));
    expect(mediaKeys).toHaveLength(1);
    expect(data.hostData?.[mediaKeys[0]]).toMatchObject({
      kind: 'media',
      status: 'ready',
      payload: { media: 'video', src: 'https://third-party.example/a.mp4' },
    });
    expect(types).toContain('inlineMath');
    expect(JSON.stringify(data.document)).not.toContain('<video');
    expect(JSON.stringify(data.hostData)).toContain('third-party.example/a.mp4');
    expect(JSON.stringify(data.document)).toContain('[@AbCd5678]');

    // 与详情页（clipboard 的阅读路径）同一条准备链逐字一致。
    const compat = applyLegacyHtmlCompat(media);
    const direct = await adaptReactiveReferences(compat.source, {
      mode: 'external',
      dataImages: compat.dataImages,
      mediaSources: compat.mediaSources,
    });
    const compiled = compileLocal(direct.adaptedSource, reactiveCompileOptions('markdown'));
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    expect(data.document).toEqual(compiled.document);

    // 内联渲染与「详情页同一条准备链的产物」用同一份静态渲染器必须逐字一致：
    // 历史 `<video>` 只留链接、公式仍由同一个文档视图渲染。
    const inlineHtml = renderToStaticMarkup(
      createElement(ReactiveSubDocument, {
        document: data.document,
        hostData: data.hostData,
        hostRenderer: renderSiteEmbedStatic,
      })
    );
    const detailHtml = renderToStaticMarkup(
      createElement(ReactiveSubDocument, {
        document: compiled.document,
        hostData: direct.hostData,
        hostRenderer: renderSiteEmbedStatic,
      })
    );
    expect(inlineHtml).toBe(detailHtml);
    // 产品口径：保留可播放 controls、默认 preload=none、绝无 autoplay。
    expect(inlineHtml).toContain('<video');
    expect(inlineHtml).toContain('controls');
    expect(inlineHtml).toContain('preload="none"');
    expect(inlineHtml).not.toContain('autoplay');
    expect(inlineHtml).toContain('third-party.example/a.mp4');
    expect(inlineHtml).toContain('data-render-mode="static"');

    // 宿主渲染入口：有子产物就内联，没有（external 快照 / 子编译失败）就退回卡片。
    const node = {
      type: 'component',
      id: 'clip-embed',
      range: { start: 0, end: 0 },
      attrs: { kind: 'clipboard', ref: CLIP_ID },
    };
    const inlined = renderToStaticMarkup(
      createElement('div', null, renderSiteEmbedStatic(node, data, { mode: 'interactive' } as never))
    );
    expect(inlined).toContain('clipboard-inline');
    const card = renderToStaticMarkup(
      createElement(
        'div',
        null,
        renderSiteEmbedStatic(
          node,
          { ...data, document: undefined, hostData: undefined },
          { mode: 'interactive' } as never
        )
      )
    );
    expect(card).toContain('site-embed-clipboard');
    expect(card).not.toContain('clipboard-inline');
  });
});

// ═══ 历史 HTML 音视频：compat token → media kind ═════════════════════════════

describe('历史 HTML 音视频 token（media kind）', () => {
  const mediaPayload = {
    media: 'video' as const,
    src: 'https://cdn.example/video.mp4',
    poster: 'https://cdn.example/poster.jpg',
    sources: [{ src: 'https://cdn.example/video.webm', type: 'video/webm' }],
    tracks: [
      {
        src: 'https://cdn.example/zh.vtt',
        kind: 'subtitles' as const,
        srclang: 'zh',
        label: '中文',
        default: true,
      },
    ],
    preload: 'none' as const,
    loop: true,
    muted: true,
    playsInline: true,
    width: 640,
    height: 360,
  };
  const token = `[[媒体:${MEDIA_REF}]]`;

  it('扫描出 media；external 也展开为标签 + hostData（纯正文派生数据）', async () => {
    const source = `前 ${token} 后`;
    expect(scanReactiveReferences(source).map((slot) => slot.kind)).toEqual(['media']);

    let resolveCalls = 0;
    const result = await adaptReactiveReferences(source, {
      mode: 'external',
      mediaSources: { [MEDIA_REF]: mediaPayload },
      resolve: async () => {
        resolveCalls += 1;
        return undefined;
      },
    });

    expect(resolveCalls).toBe(0);
    expect(result.adaptedSource).toContain(tag('media', MEDIA_REF));
    expect(result.hostData[`media:${MEDIA_REF}`]).toMatchObject({
      kind: 'media',
      ref: MEDIA_REF,
      status: 'ready',
    });
    expect(result.hostData[`media:${MEDIA_REF}`].payload).toEqual(mediaPayload);
  });

  it('代码块 / 行内代码里的同形 token 原样保留', async () => {
    const fenced = `\`\`\`\n${token}\n\`\`\``;
    const inline = '`' + token + '`';
    const result = await adaptReactiveReferences(`前 ${token} 后\n\n${fenced}\n\n${inline}`, {
      mode: 'external',
      mediaSources: { [MEDIA_REF]: mediaPayload },
    });
    expect(result.adaptedSource).toContain(fenced);
    expect(result.adaptedSource).toContain(inline);
    expect(result.adaptedSource.match(/kind="media"/g) ?? []).toHaveLength(1);
  });

  it('mediaSources 缺键 / 形状非法 → 保留字面量，不发明组件', async () => {
    const source = `前 ${token} 后`;
    const invalid: Record<string, SiteMediaPayload>[] = [
      {},
      { [MEDIA_REF]: { media: 'video' } },
    ];
    for (const mediaSources of invalid) {
      const result = await adaptReactiveReferences(source, {
        mode: 'external',
        mediaSources,
      });
      expect(result.adaptedSource).toContain(token);
      expect(result.hostData[`media:${MEDIA_REF}`]).toBeUndefined();
    }
  });

  it(`media 与图片 / 剪贴板共用 ${MAX_BLOG_REF_ITEMS} 处预算`, async () => {
    const tokens = Array.from({ length: MAX_BLOG_REF_ITEMS + 1 }, () => token).join(' ');
    const result = await adaptReactiveReferences(tokens, {
      mode: 'external',
      mediaSources: { [MEDIA_REF]: mediaPayload },
    });
    expect(result.adaptedSource.match(/kind="media"/g) ?? []).toHaveLength(MAX_BLOG_REF_ITEMS);
    expect(result.adaptedSource).toContain(token);
  });
});

// ═══ 子正文：共享语法预算 + 有界纯产物缓存 ═══════════════════════════════════

describe('内联子文档：语法预算与有界缓存', () => {
  it('★ 50k 未闭合 `<` 不进入 compileLocal：很快返回 null（共享 syntax-budget）', async () => {
    __resetInlineMarkdownCacheForTests();
    const malicious = '<'.repeat(50_000);
    expect(checkSyntaxBudget(malicious)?.diagnostic.code).toBe('site.syntax-budget');

    const started = performance.now();
    expect(await prepareInlineMarkdownDocument(malicious)).toBeNull();
    const elapsed = performance.now() - started;
    // 旧实现会把这 50k 交给 compileLocal（超线性）；预算闸门必须先拦下。
    expect(elapsed).toBeLessThan(1000);

    // 重复提交同一份恶意内容命中缓存里的 null，仍然快速返回。
    const second = performance.now();
    expect(await prepareInlineMarkdownDocument(malicious)).toBeNull();
    expect(performance.now() - second).toBeLessThan(1000);
  });

  it('★ 50k 未闭合 `{{` 同样被预算拦下', async () => {
    __resetInlineMarkdownCacheForTests();
    const malicious = '{{'.repeat(25_000);
    expect(checkSyntaxBudget(malicious)?.diagnostic.code).toBe('site.syntax-budget');

    const started = performance.now();
    expect(await prepareInlineMarkdownDocument(malicious)).toBeNull();
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it('缓存只复用同一份纯产物；不同内容不串', async () => {
    __resetInlineMarkdownCacheForTests();
    const first = await prepareInlineMarkdownDocument('# 甲\n\n正文甲');
    const again = await prepareInlineMarkdownDocument('# 甲\n\n正文甲');
    const other = await prepareInlineMarkdownDocument('# 乙\n\n正文乙');

    expect(first).not.toBeNull();
    expect(again).toBe(first); // 命中缓存 → 同一个不可变产物
    expect(other).not.toBeNull();
    expect(other).not.toBe(first);
    expect(JSON.stringify(other?.document)).toContain('正文乙');
    expect(JSON.stringify(other?.document)).not.toContain('正文甲');
  });
});
