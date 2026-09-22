// @vitest-environment jsdom
//
// audio-refs.ts —— `[@音频/<ID>]` 的识别、替换、预算与**跨语法互不干扰**。
//
// 【为什么这一组要单独打】这条语法踩的是三次已经踩过的雷，每次都不报错：
//   1. **`\s*` 会把任意同名用户拖进 @ 通知**（extractMentions 跑在原始正文上）。
//      这里用「正则源码里不许出现 \s」做结构性断言 —— 比逐个列举危险串更难绕过。
//   2. **保留合集名要两端一起改**。表情那条正则的形状与本语法完全同构，
//      只改一端 = 「面板里挑得出、一渲染却变成播放器」。这里直接对 STICKER_REF_RE
//      断言（那是真两端之一），另一端（sticker-service 扫盘）在 service 用例里。
//   3. **代码块里的 token 不许展开**（源文阶段没有 DOM，跳过不了 CODE/PRE）。
//      这是博客侧最可能的静默错误：用户想展示语法本身，却得到一个真播放器。

import { describe, it, expect } from 'vitest';
import {
  AUDIO_ID_LEN,
  AUDIO_REF_CLASS,
  AUDIO_REF_COLLECTION,
  AUDIO_REF_PROBE,
  AUDIO_REF_RE,
  MAX_AUDIO_REFS,
  audioRefHtml,
  audioUrl,
  collectAudioRefs,
  embedAudioRefs,
  replaceAudioRefs,
  stripAudioTokens,
} from '@/lib/audio-refs';
import { STICKER_REF_RE, STICKER_REF_PROBE } from '@/lib/sticker-refs';
import { IMAGE_REF_PROBE } from '@/lib/content-refs';
import { maskMarkdownCode } from '@/lib/favorite-refs';

const ID = 'AbCdEf1234'; // 10 位，与生成器同形
const TOKEN = `[@${AUDIO_REF_COLLECTION}/${ID}]`;

/** 每个用例新建正则：模块级 g 正则的 lastIndex 会在多次 exec 之间残留。 */
const freshRe = () => new RegExp(AUDIO_REF_RE.source, 'g');
const freshProbe = () => new RegExp(AUDIO_REF_PROBE.source);

// ═══ 一、识别 ════════════════════════════════════════════════════════════════

describe('令牌识别', () => {
  it('认得标准形态', () => {
    const m = freshRe().exec(TOKEN);
    expect(m?.[1]).toBe(ID);
  });

  it(`id 恰好 ${AUDIO_ID_LEN} 位；多一位少一位都不认`, () => {
    const short = `[@${AUDIO_REF_COLLECTION}/${ID.slice(0, 9)}]`;
    const long = `[@${AUDIO_REF_COLLECTION}/${ID}x]`;
    expect(freshProbe().test(short)).toBe(false);
    expect(freshProbe().test(long)).toBe(false);
  });

  it('id 只认字母数字：下划线 / 连字符 / 斜杠都不行', () => {
    // ⚠️ 这条是安全边界，不是洁癖 —— id 会被拼进 /api/audio/<id>/raw 并写成 DOM 属性
    for (const bad of ['AbCdEf_234', 'AbCdEf-234', 'AbCdEf/234', 'AbCdEf.234']) {
      expect(freshProbe().test(`[@${AUDIO_REF_COLLECTION}/${bad}]`)).toBe(false);
    }
  });

  it('★ 正则里一个 `\\s` 都没有（@ 提及的安全边界）★', () => {
    // 与 sticker-refs / user-refs 同一条纪律：段内一旦允许空白，
    // `[@音 频/xxx]` 会让 extractMentions 的 lookahead 满足，凭空给「音」发通知。
    // 断言源码里不出现 \s —— 比逐个列举危险串更难绕过。
    expect(AUDIO_REF_RE.source).not.toContain('\\s');
    expect(AUDIO_REF_PROBE.source).not.toContain('\\s');
  });

  it('带空白的变体一律不认（它们必须原样留成字面量）', () => {
    const variants = [
      `[@ ${AUDIO_REF_COLLECTION}/${ID}]`,
      `[@${AUDIO_REF_COLLECTION} /${ID}]`,
      `[@${AUDIO_REF_COLLECTION}/ ${ID}]`,
      `[@${AUDIO_REF_COLLECTION}/${ID} ]`,
      `[@音 频/${ID}]`,
    ];
    for (const v of variants) {
      expect(freshProbe().test(v), `${v} 不该被认出来`).toBe(false);
    }
  });

  it('token 里的 id 只可能是我们校验过的形态（拼 URL 因此无需转义）', () => {
    expect(AUDIO_REF_RE.source).toContain('[A-Za-z0-9]');
  });
});

// ═══ 二、跨语法互不干扰（保留合集名那一端）═══════════════════════════════════

describe('与其它引用语法互不干扰', () => {
  it('★ 表情那条正则**不认**音频 token（保留合集名的这一端）★', () => {
    // 不加负向先行断言的话，`音频` 会被当成一个合集名，token 变成一张表情图。
    // 两端必须一起改 —— 另一头是 sticker-service.ts 的扫盘。
    const stickerRe = new RegExp(STICKER_REF_RE.source, 'gu');
    expect(stickerRe.test(TOKEN)).toBe(false);
    const stickerProbe = new RegExp(STICKER_REF_PROBE.source, 'u');
    expect(stickerProbe.test(TOKEN)).toBe(false);
  });

  it('表情 token 照旧能认（让开音频没有误伤它）', () => {
    const stickerProbe = new RegExp(STICKER_REF_PROBE.source, 'u');
    expect(stickerProbe.test('[@猫猫/开心]')).toBe(true);
  });

  it('图床那条 10 位正则不认音频 token（中文卡住了 `\\w`/ALNUM）', () => {
    expect(IMAGE_REF_PROBE.test(TOKEN)).toBe(false);
  });

  it('反过来，音频正则也不认图床 token', () => {
    expect(freshProbe().test('[@AbCdEf1234]')).toBe(false);
  });
});

// ═══ 三、短标记（侧栏预览 / 通知正文）════════════════════════════════════════

describe('stripAudioTokens', () => {
  it('换成 `[音频]`，与既有的 [图片]/[博客]/[表情] 同口径', () => {
    expect(stripAudioTokens(`你好 ${TOKEN} 再见`)).toBe('你好 [音频] 再见');
  });

  it('一次替换全部，且不残留', () => {
    const two = `${TOKEN} 和 [@${AUDIO_REF_COLLECTION}/ZZZZZZZZZZ]`;
    expect(stripAudioTokens(two)).toBe('[音频] 和 [音频]');
  });

  it('连续调用两次结果一致（g 正则 lastIndex 没有残留）', () => {
    const s = `x ${TOKEN} y`;
    expect(stripAudioTokens(s)).toBe(stripAudioTokens(s));
  });
});

// ═══ 四、DOM 展开（评论 / 讨论）═══════════════════════════════════════════════

function mount(html: string): HTMLElement {
  const div = document.createElement('div');
  div.innerHTML = html;
  return div;
}

function audioEls(root: HTMLElement): HTMLAudioElement[] {
  return [...root.querySelectorAll('audio')] as HTMLAudioElement[];
}

describe('embedAudioRefs', () => {
  it('把 token 换成 <audio controls>，src 指向我们自己的路由', () => {
    const root = mount(`<p>听 ${TOKEN}</p>`);
    embedAudioRefs(root);

    const els = audioEls(root);
    expect(els).toHaveLength(1);
    expect(els[0].getAttribute('src')).toBe(audioUrl(ID));
    expect(els[0].getAttribute('src')).toBe(`/api/audio/${ID}/raw`);
    expect(els[0].hasAttribute('controls')).toBe(true);
    expect(els[0].className).toBe(AUDIO_REF_CLASS);
    // 降级用：加载失败时 RichContentBody 靠它把原文换回来
    expect(els[0].getAttribute('data-token')).toBe(TOKEN);
  });

  it('前后文本保留', () => {
    const root = mount(`<p>前 ${TOKEN} 后</p>`);
    embedAudioRefs(root);
    expect(root.textContent).toBe('前  后');
  });

  it('`preload="metadata"` —— 要让用户看见时长，且只取容器头部而非整份文件', () => {
    const root = mount(`<p>${TOKEN}</p>`);
    embedAudioRefs(root);
    expect(audioEls(root)[0].getAttribute('preload')).toBe('metadata');
  });

  it('跳过 A / CODE / PRE 父节点（要展示语法本身时写得出字面量）', () => {
    for (const tag of ['a', 'code', 'pre']) {
      const root = mount(`<${tag}>${TOKEN}</${tag}>`);
      embedAudioRefs(root);
      expect(audioEls(root), `<${tag}> 里不该展开`).toHaveLength(0);
      expect(root.textContent).toBe(TOKEN);
    }
  });

  it(`★ 预算封顶 ${MAX_AUDIO_REFS} 个，超出部分原样留字面量 ★`, () => {
    // 上限是正文的确定性函数，所以不破坏 rich-text 的渲染缓存。
    // 每个引用背后都是 MB 级传输，放开等于一条消息放大出几百 MB。
    const many = Array.from({ length: MAX_AUDIO_REFS + 3 }, () => TOKEN).join(' ');
    const root = mount(`<p>${many}</p>`);
    embedAudioRefs(root);

    expect(audioEls(root)).toHaveLength(MAX_AUDIO_REFS);
    // 超出的那些必须还是字面量，不是被悄悄吃掉
    expect(root.textContent).toContain(TOKEN);
  });

  it('一个文本节点里多个 token 都会被展开', () => {
    const root = mount(`<p>${TOKEN}${TOKEN}</p>`);
    embedAudioRefs(root);
    expect(audioEls(root)).toHaveLength(2);
  });

  it('没有 token 时不动 DOM', () => {
    const root = mount('<p>普通正文</p>');
    const before = root.innerHTML;
    embedAudioRefs(root);
    expect(root.innerHTML).toBe(before);
  });

  it('绝不拼 innerHTML：已转义的内容仍是转义文本', () => {
    const root = mount('<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>');
    embedAudioRefs(root);
    expect(root.querySelector('script')).toBeNull();
  });
});

// ═══ 五、博客侧：收集与替换 ═══════════════════════════════════════════════════

describe('collectAudioRefs / replaceAudioRefs（博客源文）', () => {
  it('收集到 id 与位置', () => {
    const src = `前 ${TOKEN} 后`;
    const slots = collectAudioRefs(src, maskMarkdownCode(src));
    expect(slots).toHaveLength(1);
    expect(slots[0].id).toBe(ID);
    expect(slots[0].match).toBe(TOKEN);
    expect(src.slice(slots[0].start, slots[0].start + slots[0].match.length)).toBe(TOKEN);
  });

  it('★ 代码块 / 行内代码里的 token **不**收集（否则嵌出真播放器）★', () => {
    const fenced = ['```', TOKEN, '```'].join('\n');
    const inline = `写 \`${TOKEN}\` 就能引用`;

    for (const src of [fenced, inline]) {
      const slots = collectAudioRefs(src, maskMarkdownCode(src));
      expect(slots, `${src} 里的 token 不该被展开`).toHaveLength(0);
      // 替换也不该改动原文 —— 用户要的就是看见语法本身
      expect(replaceAudioRefs(src, slots)).toBe(src);
    }
  });

  it('代码块外的照常展开（盖码没有误伤）', () => {
    const src = [`\`\`\``, TOKEN, '```', '', `正文 ${TOKEN}`].join('\n');
    const slots = collectAudioRefs(src, maskMarkdownCode(src));
    expect(slots).toHaveLength(1);
    expect(slots[0].start).toBeGreaterThan(src.indexOf('```\n\n'));
  });

  it('替换成 <audio> 标签串，且按区间切片（不是 replace）', () => {
    const src = `听 ${TOKEN}`;
    const out = replaceAudioRefs(src, collectAudioRefs(src, maskMarkdownCode(src)));
    expect(out).toContain('<audio');
    expect(out).toContain(`src="/api/audio/${ID}/raw"`);
    expect(out).toContain('controls');
    expect(out).not.toContain(TOKEN);
  });

  it('多个 token 一起替换，位置不互相位移', () => {
    const a = `[@${AUDIO_REF_COLLECTION}/AAAAAAAAAA]`;
    const b = `[@${AUDIO_REF_COLLECTION}/BBBBBBBBBB]`;
    const src = `${a} 中间 ${b}`;
    const out = replaceAudioRefs(src, collectAudioRefs(src, maskMarkdownCode(src)));

    expect(out).toContain('/api/audio/AAAAAAAAAA/raw');
    expect(out).toContain('/api/audio/BBBBBBBBBB/raw');
    expect(out).toContain('中间');
    expect(out).not.toContain(TOKEN);
  });

  it(`收集也受 ${MAX_AUDIO_REFS} 封顶`, () => {
    const many = Array.from({ length: MAX_AUDIO_REFS + 5 }, () => TOKEN).join(' ');
    expect(collectAudioRefs(many, maskMarkdownCode(many))).toHaveLength(MAX_AUDIO_REFS);
  });

  it('audioRefHtml 只输出我们自己的 URL，不含任何用户可控的 URL', () => {
    expect(audioRefHtml(ID)).toContain(`src="/api/audio/${ID}/raw"`);
    // ⚠️ 不设 data-token：博客那条管线会过 DOMPurify 且 ALLOW_DATA_ATTR: false，
    // 写了也会被剥掉 —— 与其留一个看似有效实则失效的属性，不如不写。
    expect(audioRefHtml(ID)).not.toContain('data-token');
  });
});
