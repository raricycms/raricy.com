// @vitest-environment jsdom
// ─────────────────────────────────────────────────────────────────────────────
// sticker-refs.test.ts —— 评论 / 讨论里表情包引用 `[@合集/表情]` 的**语法边界与安全面**
//
// 【与 content-refs.test.ts 的分工】那份钉图床引用，这份钉表情引用。两条旁路同构
// （都是「净化之后由我们自己的代码 createElement 建 <img>」），所以这里的用例也
// 照它的路子写：每个向量问「危险元素在不在」与「用户输入有没有被看见」。
//
// 【本文件最要紧的三条】
//   1. **不许段内空白** —— 这不只是格式洁癖。extractMentions 的正则是
//      `/@([\p{L}\p{N}_-]{1,20})(?=\s|$)/gu`，它跑在**原始正文**上（不经过我们的
//      正则）。若 token 允许空白，`[@猫 猫/开心]` 里的 `@猫 ` 正好满足 lookahead →
//      凭空给一个叫「猫」的用户发通知。token 不含空白，这条路才不存在。
//   2. **class 不能与图床图相同** —— RichContentBody 的点击委托按 rich-image-ref
//      判定「点开原图」，同类名会让点表情弹出大图灯箱。
//   3. **不许误伤 8 / 10 位引用** —— 那两种是精确长度 + 纯字母数字，而表情 token
//      必含 `/`，天然不撞；这条用例把它钉死。
//
// 【两份渲染器都要跑】照 content-refs.test.ts 的 parity 写法：评论与讨论白名单
// 逐字相同、只差链接类名，一处漏打补丁另一处不会知道。
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from 'vitest';
import {
  EMOJI_REF_CLASS,
  MAX_STICKER_REFS,
  STICKER_REF_CLASS,
  STICKER_REF_RE,
  STICKER_REF_PROBE,
  stickerKey,
  stickerUrl,
  stripStickerTokens,
} from '@/lib/sticker-refs';
import { IMAGE_REF_CLASS } from '@/lib/content-refs';
import { renderChatMarkdown } from '@/lib/chat-markdown';
import { renderCommentMarkdown } from '@/lib/comment-markdown';

/** 渲染 + 解析成 DOM，便于按结构断言（字符串比对会被转义形式骗过去）。 */
function mount(render: (s: string) => string, content: string): HTMLElement {
  const root = document.createElement('div');
  root.innerHTML = render(content);
  return root;
}

const RENDERERS = [
  { name: '讨论', render: renderChatMarkdown },
  { name: '评论', render: renderCommentMarkdown },
] as const;

/** 一份合法的 10 位图床 ID（大小写字母 + 数字）。 */
const IMG_ID = 'AbCdEf1234';
/** 一份合法的 8 位剪贴板 ID。 */
const CLIP_ID = 'a1b2c3d4';

/** 取一个字符串里所有表情匹配的原始文本（全局正则每次新建，避免 lastIndex 残留）。 */
function matches(text: string): string[] {
  return [...text.matchAll(new RegExp(STICKER_REF_RE.source, 'gu'))].map((m) => m[0]);
}

/** 收集带 on* 事件属性的元素（转义成文本的「属性」不算 —— 那只是字符）。 */
function elementsWithEventAttrs(root: HTMLElement): string[] {
  const bad: string[] = [];
  root.querySelectorAll('*').forEach((el) => {
    for (const attr of Array.from(el.attributes)) {
      if (/^on/i.test(attr.name)) bad.push(`${el.tagName}[${attr.name}]`);
    }
  });
  return bad;
}

// ── 纯函数层：语法 ──────────────────────────────────────────────────────────

describe('sticker-refs 语法', () => {
  it('认得最基本的 `[@合集/表情]`，并抓出两段', () => {
    const m = STICKER_REF_PROBE.exec('你好 [@猫猫/开心] 再见');
    expect(m?.[1]).toBe('猫猫');
    expect(m?.[2]).toBe('开心');
  });

  it('ASCII 名同样认（站长可以用英文目录名）', () => {
    const m = STICKER_REF_PROBE.exec('[@cats/happy]');
    expect(m?.[1]).toBe('cats');
    expect(m?.[2]).toBe('happy');
  });

  it('★ 段内空白一律不匹配 —— 这是 @提及 不被误触发的唯一防线', () => {
    // 若这条挂了（比如有人给正则加了 `\s*`），`[@猫 猫/开心]` 就会被认成表情；
    // 而 extractMentions 跑在原始正文上，`@猫 ` 满足它的 (?=\s|$) → 凭空通知一个叫
    // 「猫」的用户。所以这里不是格式洁癖，是安全断言。
    for (const bad of [
      '[@猫 猫/开心]',
      '[@猫猫 /开心]',
      '[@猫猫/ 开心]',
      '[@ 猫猫/开心]',
      '[@猫猫/开心 ]',
      '[@猫猫\t/开心]',
    ]) {
      expect(matches(bad), bad).toEqual([]);
    }
  });

  it('★ 不误伤 8 位剪贴板 / 10 位图床引用（表情 token 必含斜杠）', () => {
    for (const other of [`[@${CLIP_ID}]`, `[@${IMG_ID}]`, `[@ ${IMG_ID} ]`]) {
      expect(matches(other), other).toEqual([]);
    }
  });

  it('★ 两个 token 相邻时各算一个，不会被贪婪吞并', () => {
    // 段字符集不含 `]` 才成立 —— 否则第一段会一路吃到 `] 和 [@c`
    expect(matches('[@a/b] 和 [@c/d]')).toEqual(['[@a/b]', '[@c/d]']);
    expect(matches('[@a/b][@c/d]')).toEqual(['[@a/b]', '[@c/d]']);
  });

  it('★ markdown 元字符不在白名单里（否定式字符集会静默退化）', () => {
    // 用 `[^\]/\s]+` 那种否定式写法时这些会匹配，随后被 marked 拆进多个文本节点，
    // TreeWalker 匹配不到 → 静默退回字面量：没有报错、没有日志，用户只看到「没出来」。
    for (const bad of ['[@开心/`x`]', '[@开心/*x*]', '[@开心/x_y]', '[@开心/<b>]', '[@开心/x.y]']) {
      expect(matches(bad), bad).toEqual([]);
    }
  });

  it('段长上限 32，超长不匹配', () => {
    const ok = 'a'.repeat(32);
    const tooLong = 'a'.repeat(33);
    expect(matches(`[@${ok}/${ok}]`)).toHaveLength(1);
    expect(matches(`[@${tooLong}/x]`)).toEqual([]);
    expect(matches(`[@x/${tooLong}]`)).toEqual([]);
  });

  it('只有一段 / 三段都不匹配（语法就两级）', () => {
    expect(matches('[@猫猫]')).toEqual([]);
    expect(matches('[@a/b/c]')).toEqual([]);
  });

  it('空的合集名或表情名不匹配', () => {
    expect(matches('[@/开心]')).toEqual([]);
    expect(matches('[@猫猫/]')).toEqual([]);
  });

  it('★ `用户` 是保留合集名 —— 名片 token 归名片那条管线，表情一律不看它', () => {
    // 让开之后连带两件事：预览里的 `[@用户/张三]` 不会被压成 `[表情]`；渲染时也不会
    // 白去请求一次 /api/stickers/用户/张三。反过来若这条挂了，名片会在有表情素材的站上
    // 被当成表情（404 → 降级显示原文），表现成「有时好有时坏」。
    for (const card of ['[@用户/张三丰]', '[@用户/alice]', '[@用户/黄脸]']) {
      expect(matches(card), card).toEqual([]);
    }
    // 只是**这个**名字被让开：别的合集名照旧，含以「用户」开头的（SEG 会整段吃掉）
    expect(matches('[@用户群/开心]')).toEqual(['[@用户群/开心]']);
    expect(matches('[@猫猫/开心]')).toEqual(['[@猫猫/开心]']);
  });

  it('★ `音频` 同样是保留合集名 —— 音频 token 归 audio-refs 那条管线', () => {
    // 与上一条同源的问题、同源的代价：形状也是 `[@A/B]`。不加断言的话，
    // `[@音频/AbCdEf1234]` 会被当成「合集=音频」→ 渲染时白请求一次
    // /api/stickers/音频/AbCdEf1234（404）→ 降级显示原文 token。
    // ⚠️ 这条是**后补**的：既有的 `用户` 断言不会因为新增一个保留名而变红，
    // 所以不主动加就等于让新的保留名裸奔。
    for (const a of ['[@音频/AbCdEf1234]', '[@音频/zzzzzzzzzz]', '[@音频/黄脸]']) {
      expect(matches(a), a).toEqual([]);
    }
    // 只是**这个**名字被让开，以「音频」开头的其它合集名照旧
    expect(matches('[@音频库/开心]')).toEqual(['[@音频库/开心]']);
  });

  it('★ 让开之后分段捕获仍是 m[1] / m[2]（先行断言必须是非捕获的）', () => {
    // 面板拼 token、用例取段名都依赖这两个下标 —— 有一天有人把 `(?!…)` 写成 `(?=(…))`，
    // 段名会整体错位一格，而那不会报错。
    const m = STICKER_REF_PROBE.exec('[@猫猫/开心]');
    expect(m?.[1]).toBe('猫猫');
    expect(m?.[2]).toBe('开心');
    expect(m?.length).toBe(3);
  });

  it('★ 用户手写 <img onerror> 不会被这条旁路带进来', () => {
    expect(matches('[@猫猫/开心" onerror="alert(1)]')).toEqual([]);
    expect(matches('[@猫猫/../../etc/passwd]')).toEqual([]);
  });
});

// ── 纯函数层：键与 URL ──────────────────────────────────────────────────────

describe('sticker-refs 键与 URL', () => {
  it('★ NFC 归一化：NFD 输入与 NFC 输入得到同一个键', () => {
    // Windows 的 NTFS 不做归一化，手机输入法可能产出 NFD —— 不归一化就是
    // 「看起来一模一样但匹配不上」，且完全静默。
    const nfc = 'café'; // é 单码点
    const nfd = 'café'; // e + 组合尖音符
    expect(nfc).not.toBe(nfd); // 确认这俩确实不同码点，否则下面的断言是空的
    expect(stickerKey(nfd, nfd)).toBe(stickerKey(nfc, nfc));
  });

  it('URL 以站内路由为前缀，且能解回原名', () => {
    const url = stickerUrl('猫猫', '开心');
    expect(url.startsWith('/api/stickers/')).toBe(true);
    const [collection, name] = url.slice('/api/stickers/'.length).split('/');
    expect(decodeURIComponent(collection)).toBe('猫猫');
    expect(decodeURIComponent(name)).toBe('开心');
  });

  it('stripStickerTokens 把 token 换成 [表情]，与 [图片] 同口径', () => {
    expect(stripStickerTokens('你好 [@猫猫/开心] 再见')).toBe('你好 [表情] 再见');
    expect(stripStickerTokens('[@a/b][@c/d]')).toBe('[表情][表情]');
    expect(stripStickerTokens('没有表情')).toBe('没有表情');
  });
});

// ── 管线层：两个渲染器 parity ───────────────────────────────────────────────

describe.each(RENDERERS)('$name 正文的 [@合集/表情]', ({ render }) => {
  it('渲染成内联图片，src 恰为站内表情地址', () => {
    const root = mount(render, '你好 [@猫猫/开心] 再见');
    const imgs = root.querySelectorAll('img');
    expect(imgs).toHaveLength(1);
    expect(imgs[0].getAttribute('src')).toBe(stickerUrl('猫猫', '开心'));
    expect(root.textContent).not.toContain('[@');
    // 行内：前后的文字仍在同一个段落里，没被拆成块
    expect(root.querySelectorAll('p')).toHaveLength(1);
  });

  it('★ 类名是 rich-sticker-ref 而**不是** rich-image-ref（否则点表情会弹大图灯箱）', () => {
    const img = mount(render, '[@猫猫/开心]').querySelector('img')!;
    expect(img.classList.contains(STICKER_REF_CLASS)).toBe(true);
    expect(img.classList.contains(IMAGE_REF_CLASS)).toBe(false);
    expect(STICKER_REF_CLASS).not.toBe(IMAGE_REF_CLASS);
  });

  it('★ alt 与 data-token 都是原始 token —— 这是 404 降级链的两层', () => {
    const img = mount(render, '[@猫猫/开心]').querySelector('img')!;
    expect(img.getAttribute('alt')).toBe('[@猫猫/开心]');
    expect(img.getAttribute('data-token')).toBe('[@猫猫/开心]');
  });

  it('img 上不存在任何用户可控的属性名', () => {
    const img = mount(render, '[@猫猫/开心]').querySelector('img')!;
    expect(Array.from(img.attributes).map((a) => a.name).sort()).toEqual([
      'alt',
      'class',
      'data-token',
      'draggable',
      'loading',
      'src',
    ]);
  });

  it('★ 代码块 / 行内代码里的 token 不展开（用户要能展示这个语法本身）', () => {
    const fenced = mount(render, '```\n[@猫猫/开心]\n```');
    expect(fenced.querySelectorAll('img')).toHaveLength(0);
    expect(fenced.textContent).toContain('[@猫猫/开心]');

    const inline = mount(render, '`[@猫猫/开心]`');
    expect(inline.querySelectorAll('img')).toHaveLength(0);
    expect(inline.textContent).toContain('[@猫猫/开心]');
  });

  it('★ 链接标签内的 token 不展开成 <a> 套 <img>', () => {
    const root = mount(render, '[[@猫猫/开心]](/blog/1)');
    expect(root.querySelectorAll('a img')).toHaveLength(0);
  });

  it('一条消息里的表情有上限，超出的保留字面量', () => {
    const many = Array.from({ length: MAX_STICKER_REFS + 5 }, () => '[@猫猫/开心]').join(' ');
    expect(mount(render, many).querySelectorAll('img')).toHaveLength(MAX_STICKER_REFS);
    expect(mount(render, many).textContent).toContain('[@');
  });

  it('★ 与图床引用共存：一条消息里两种图各自渲染，互不吃掉', () => {
    const root = mount(render, `图 [@${IMG_ID}] 表情 [@猫猫/开心]`);
    const imgs = root.querySelectorAll('img');
    expect(imgs).toHaveLength(2);
    expect(imgs[0].getAttribute('src')).toBe(`/api/images/${IMG_ID}/raw`);
    expect(imgs[0].classList.contains(IMAGE_REF_CLASS)).toBe(true);
    expect(imgs[1].getAttribute('src')).toBe(stickerUrl('猫猫', '开心'));
    expect(imgs[1].classList.contains(STICKER_REF_CLASS)).toBe(true);
  });

  it('★ 内置黄脸：src 指向 /static/emoji/，且**叠上** rich-emoji-ref 而不是换掉', () => {
    const img = mount(render, '[@黄脸/微笑]').querySelector('img')!;
    expect(img.getAttribute('src')).toBe('/static/emoji/1f60a.svg');
    // 两个类都必须在。少哪个都有具体的坏后果：
    //   少 rich-sticker-ref → 缺图时显示**裂图**（降级链按那个类名过滤）；
    //   少 rich-emoji-ref   → 尺寸继承 4em，黄脸变成一张大表情。
    expect(img.classList.contains(STICKER_REF_CLASS)).toBe(true);
    expect(img.classList.contains(EMOJI_REF_CLASS)).toBe(true);
    expect(img.classList.contains(IMAGE_REF_CLASS)).toBe(false);
    // 降级链的两层照旧是原始 token（黄脸走的是同一条链）
    expect(img.getAttribute('alt')).toBe('[@黄脸/微笑]');
    expect(img.getAttribute('data-token')).toBe('[@黄脸/微笑]');
  });

  it('普通表情**不带**黄脸那个尺寸类（回归：别把两种表情弄成一样大）', () => {
    const img = mount(render, '[@猫猫/开心]').querySelector('img')!;
    expect(img.classList.contains(EMOJI_REF_CLASS)).toBe(false);
    expect(img.getAttribute('src')).toBe(stickerUrl('猫猫', '开心'));
  });

  it('黄脸合集里查不到的名字落回字节路由（→404→显示原文，而不是留一张裂图）', () => {
    const img = mount(render, '[@黄脸/并不存在]').querySelector('img')!;
    expect(img.getAttribute('src')).toBe(stickerUrl('黄脸', '并不存在'));
    expect(img.classList.contains(EMOJI_REF_CLASS)).toBe(false);
  });

  it('★ 三种图共存：图床图 / 图片表情 / 黄脸各渲染各的，互不吃掉', () => {
    const root = mount(render, `图 [@${IMG_ID}] 表情 [@猫猫/开心] 黄脸 [@黄脸/大哭]`);
    const imgs = root.querySelectorAll('img');
    expect(imgs).toHaveLength(3);
    expect(imgs[0].getAttribute('src')).toBe(`/api/images/${IMG_ID}/raw`);
    expect(imgs[1].getAttribute('src')).toBe(stickerUrl('猫猫', '开心'));
    expect(imgs[2].getAttribute('src')).toBe('/static/emoji/1f62d.svg');
  });

  it('黄脸与图片表情**共用一个 30 的预算**（不另立额度）', () => {
    const many = Array.from({ length: MAX_STICKER_REFS + 5 }, (_, i) =>
      i % 2 === 1 ? '[@黄脸/微笑]' : '[@猫猫/开心]'
    ).join(' ');
    expect(mount(render, many).querySelectorAll('img')).toHaveLength(MAX_STICKER_REFS);
  });

  it('★ 防线 1 / 4 未被削弱：手写 <img onerror> 仍被当文本，外链图仍降级成链接', () => {
    const root = mount(render, '<img src=x onerror="window.__x=1"> ![x](https://evil.example/x.png)');
    expect(elementsWithEventAttrs(root)).toEqual([]);
    expect(root.textContent).toContain('<img src=x onerror=');
    // 只可能有一个 img —— 而且是外链那个降级后的 <a>，不是 img
    expect(root.querySelectorAll('img')).toHaveLength(0);
  });
});
