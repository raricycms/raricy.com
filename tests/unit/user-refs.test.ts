// @vitest-environment jsdom
// ─────────────────────────────────────────────────────────────────────────────
// user-refs.test.ts —— 用户名片 `[@用户/<用户名>]` 的**语法边界、DOM 构造与安全面**
//
// 【与 sticker-refs.test.ts 的分工】那份钉表情引用，这份钉名片引用。两者形状同构
// （都是 `[@名字/名字]`、都在净化之后由我们自己的代码建节点），所以用例也照它的路子写。
//
// 【本文件最要紧的四条】
//   1. **不许段内空白** —— extractMentions 的正则是 `/@([\p{L}\p{N}_-]{1,20})(?=\s|$)/gu`，
//      它跑在**原始正文**上。token 里一旦有空白，`[@用户 张三丰]` 里的 `@用户 ` 正好满足
//      lookahead → 凭空给一个叫「用户」的人发通知。所以下面那条不是格式洁癖，是安全断言。
//   2. **名字段必须与 validateUsername 同口径** —— 规则是复制的（那边拖着 prisma，
//      客户端 import 不了），复制就会漂。有一条**逐例对照**的用例钉着两边判定相同。
//   3. **DOM 形状与 `<Avatar>` 同构** —— 少了 `avatar` / `avatar__frame`，这张名片就
//      永远没有头像框，而且不报错（样式规则是按那两个类名写的）。
//   4. **动态文本一律 textContent** —— 用户名是不可信输入，拼 innerHTML 等于把到手的
//      内容又交还给解析器。
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from 'vitest';
import {
  MAX_USER_REFS,
  USER_CARD_COLLECTION,
  USER_REF_AVATAR_CLASS,
  USER_REF_CLASS,
  USER_REF_NAME_CLASS,
  USER_REF_PROBE,
  USER_REF_RE,
  buildUserCardElement,
  collectUserCardNames,
  embedUserRefs,
  stripUserCardTokens,
  type UserCardData,
} from '@/lib/user-refs';
import type { RichTextContext } from '@/lib/rich-text';
import { validateUsername } from '@/lib/user-service';
import { extractMentions } from '@/lib/chat-service';
import { isMentioned } from '@/app/chat/ChatMessageItem';
import { IMAGE_REF_CLASS } from '@/lib/content-refs';
import { STICKER_REF_CLASS, stickerUrl } from '@/lib/sticker-refs';
import { renderChatMarkdown } from '@/lib/chat-markdown';
import { renderCommentMarkdown } from '@/lib/comment-markdown';

/** 两个渲染器都要跑 —— 评论与讨论白名单逐字相同，只差链接类名，一处漏打补丁
 *  另一处不会知道（与 sticker-refs.test.ts 的 parity 写法同源）。 */
const RENDERERS = [
  { name: '讨论', render: renderChatMarkdown },
  { name: '评论', render: renderCommentMarkdown },
] as const;

/** 渲染 + 解析成 DOM，便于按结构断言（字符串比对会被转义形式骗过去）。 */
function mount(render: (s: string, ctx?: RichTextContext) => string, content: string, ctx?: RichTextContext): HTMLElement {
  const root = document.createElement('div');
  root.innerHTML = render(content, ctx);
  return root;
}

/** querySelector 用的类名选择器（类名本身是常量，这里只是拼一个 `.x`）。 */
const USER_REF_CLASS_SEL = `.${USER_REF_CLASS}`;

/** 取一个字符串里所有名片匹配的原始文本（全局正则每次新建，避免 lastIndex 残留）。 */
function matches(text: string): string[] {
  return [...text.matchAll(new RegExp(USER_REF_RE.source, 'gu'))].map((m) => m[0]);
}

/** 一份像样的名片数据。 */
function card(over: Partial<UserCardData> = {}): UserCardData {
  return { id: '550e8400-e29b-41d4-a716-446655440000', username: '张三丰', frameUrl: null, ...over };
}

/** 造一个容器并把正文塞进去，返回可继续喂给 embedUserRefs 的根。 */
function holder(html: string): HTMLElement {
  const root = document.createElement('div');
  root.innerHTML = html;
  return root;
}

// ── 纯函数层：语法 ──────────────────────────────────────────────────────────

describe('user-refs 语法', () => {
  it('认得最基本的 `[@用户/张三丰]`，并抓出名字', () => {
    const m = USER_REF_PROBE.exec('你好 [@用户/张三丰] 再见');
    expect(m?.[1]).toBe('张三丰');
  });

  it('ASCII 名同样认', () => {
    expect(USER_REF_PROBE.exec('[@用户/alice]')?.[1]).toBe('alice');
  });

  it('★ 段内空白一律不匹配 —— 这是 @提及 不被误触发的唯一防线', () => {
    // 若这条挂了（比如有人给正则加了 `\s*`），`[@用户 张三丰]` 就会被认成名片；
    // 而 extractMentions 跑在原始正文上，`@用户 ` 满足它的 (?=\s|$) → 凭空通知一个
    // 叫「用户」的人。所以这里不是格式洁癖，是安全断言。
    for (const bad of [
      '[@用户 张三丰]',
      '[@ 用户/张三丰]',
      '[@用户/ 张三丰]',
      '[@用户/张三丰 ]',
      '[@用户\t/张三丰]',
      '[@用户/张 三]',
    ]) {
      expect(matches(bad), bad).toEqual([]);
    }
  });

  it('★ 与真实的 extractMentions 对照：名片 token 不会给任何人发通知', () => {
    // 上一条断言「正则不认带空白的 token」，这一条把结论钉在**真正的那个函数**上 ——
    // 免得上面那份样本恰好漏掉了将来引入的某个边界。
    for (const text of [
      '[@用户/张三丰]',
      '[@用户/张三丰] 你好',
      '看 [@用户/张三丰] 和 [@用户/李四光]',
      '[@用户/用户]',
      '[@用户/admin]',
    ]) {
      expect(extractMentions(text), text).toEqual([]);
    }
  });

  it('★ 不误伤 8 位剪贴板 / 10 位图床引用', () => {
    for (const other of ['[@a1b2c3d4]', '[@AbCdEf1234]', '[@ AbCdEf1234 ]']) {
      expect(matches(other), other).toEqual([]);
    }
  });

  it('★ 相邻的两个 token 各算一个，不会被贪婪吞并', () => {
    // 名字段字符集不含 `]` 才成立
    expect(matches('[@用户/张三丰] 和 [@用户/李四光]')).toEqual(['[@用户/张三丰]', '[@用户/李四光]']);
    expect(matches('[@用户/张三丰][@用户/李四光]')).toEqual(['[@用户/张三丰]', '[@用户/李四光]']);
  });

  it('★ markdown 元字符不在白名单里（否定式字符集会静默退化）', () => {
    for (const bad of ['[@用户/`x`]', '[@用户/*x*]', '[@用户/x.y]', '[@用户/<b>]', '[@用户/x\\y]']) {
      expect(matches(bad), bad).toEqual([]);
    }
  });

  it('长度：2 位不认、3 位认、20 位认、21 位不认', () => {
    const n = (len: number) => 'a'.repeat(len);
    expect(matches(`[@用户/${n(2)}]`)).toEqual([]);
    expect(matches(`[@用户/${n(3)}]`)).toHaveLength(1);
    expect(matches(`[@用户/${n(20)}]`)).toHaveLength(1);
    expect(matches(`[@用户/${n(21)}]`)).toEqual([]);
  });

  it('★ 以 `_` / `-` 起止的名字不认（那本来就不是合法用户名），中间可以有', () => {
    // 不收的话「看起来合法却永远不生效」+ 每次渲染白打一次接口
    for (const bad of ['[@用户/_abc]', '[@用户/abc_]', '[@用户/-abc]', '[@用户/abc-]']) {
      expect(matches(bad), bad).toEqual([]);
    }
    for (const ok of ['[@用户/a_b]', '[@用户/a-b]', '[@用户/a_b-c]']) {
      expect(matches(ok), ok).toHaveLength(1);
    }
  });

  it('★ 只认 `用户` 这个合集名 —— 表情 token 与它无关', () => {
    expect(USER_CARD_COLLECTION).toBe('用户');
    expect(matches('[@猫猫/开心]')).toEqual([]);
    expect(matches('[@用户]')).toEqual([]); // 没有斜杠 = 不是名片（也不是表情）
  });

  it('空名字不匹配', () => {
    expect(matches('[@用户/]')).toEqual([]);
    expect(matches('[@用户//张三丰]')).toEqual([]);
  });

  it('★ 与 validateUsername 逐例对照（规则是复制的，复制就会漂）', () => {
    // 名字段的正则只能复制一份：user-service 拖着 prisma，客户端 import 不了。
    // 这条用例是两边唯一的粘合剂 —— 判定不同就意味着「能手打的 token」与
    // 「真能注册出来的名字」对不上了。
    const samples = [
      '张三丰',
      'alice',
      'ab',
      'a',
      '',
      'a_b',
      'a-b',
      '-abc',
      'abc-',
      '_abc',
      'abc_',
      'a_b-c',
      'a'.repeat(20),
      'a'.repeat(21),
      '用户',
      'a b',
      'a/b',
      'a.b',
      '张三丰-李四光',
    ];
    for (const name of samples) {
      expect(USER_REF_PROBE.test(`[@用户/${name}]`), name).toBe(validateUsername(name).ok);
    }
  });
});

// ── 纯函数层：挑名字与剥离 ──────────────────────────────────────────────────

describe('collectUserCardNames', () => {
  it('按出现顺序给出名字', () => {
    expect(collectUserCardNames('[@用户/张三丰] 和 [@用户/李四光]')).toEqual(['张三丰', '李四光']);
  });

  it('同一个名字只给一次（只查一遍接口）', () => {
    expect(collectUserCardNames('[@用户/张三丰][@用户/张三丰][@用户/李四光]')).toEqual(['张三丰', '李四光']);
  });

  it('★ 封顶在 MAX_USER_REFS —— 一条短消息不该打出几百次请求', () => {
    const many = Array.from({ length: MAX_USER_REFS + 5 }, (_, i) => `[@用户/u${i}ser]`).join(' ');
    expect(collectUserCardNames(many)).toHaveLength(MAX_USER_REFS);
  });

  it('没有名片就返回空数组；不认的 token（超长 / 非法字符）不算数', () => {
    expect(collectUserCardNames('普通正文')).toEqual([]);
    expect(collectUserCardNames(`[@用户/${'a'.repeat(21)}]`)).toEqual([]);
    expect(collectUserCardNames('[@猫猫/开心]')).toEqual([]);
  });
});

describe('stripUserCardTokens', () => {
  it('换成可读的 `@名字`（侧栏 / 引用块 / 通知预览共用）', () => {
    expect(stripUserCardTokens('你好 [@用户/张三丰] 再见')).toBe('你好 @张三丰 再见');
    expect(stripUserCardTokens('[@用户/张三丰][@用户/李四光]')).toBe('@张三丰@李四光');
  });

  it('不动别的东西', () => {
    expect(stripUserCardTokens('没有名片')).toBe('没有名片');
    expect(stripUserCardTokens('[@猫猫/开心]')).toBe('[@猫猫/开心]');
    expect(stripUserCardTokens('[@a1b2c3d4]')).toBe('[@a1b2c3d4]');
  });
});

// ── DOM 构造 ────────────────────────────────────────────────────────────────

describe('buildUserCardElement', () => {
  it('是一个指向 /u/<id> 的链接', () => {
    const el = buildUserCardElement(document, card());
    expect(el.tagName).toBe('A');
    expect(el.getAttribute('href')).toBe('/u/550e8400-e29b-41d4-a716-446655440000');
    expect(el.classList.contains(USER_REF_CLASS)).toBe(true);
  });

  it('★ 头像盒子同时带 `avatar` 与自己的类 —— 少了 avatar 就永远没有框', () => {
    const box = buildUserCardElement(document, card({ frameUrl: '/api/frames/cat.png' })).querySelector(
      `.${USER_REF_AVATAR_CLASS}`
    )!;
    expect(box.classList.contains('avatar')).toBe(true);
    expect(box.tagName).toBe('SPAN');
  });

  it('★ 头像地址走 avatarUrl（永不 404 的 identicon 兜底）', () => {
    const img = buildUserCardElement(document, card()).querySelector('img.avatar__img')!;
    expect(img.getAttribute('src')).toBe(
      '/api/avatar/550e8400-e29b-41d4-a716-446655440000'
    );
    // 名字就在紧挨着的文本里，头像图是装饰
    expect(img.getAttribute('alt')).toBe('');
  });

  it('★ 有框时框必须在，且是纯装饰（alt 空 + aria-hidden）', () => {
    const frame = buildUserCardElement(
      document,
      card({ frameUrl: '/api/frames/cat.png' })
    ).querySelector('img.avatar__frame')!;
    expect(frame.getAttribute('src')).toBe('/api/frames/cat.png');
    expect(frame.getAttribute('alt')).toBe('');
    expect(frame.getAttribute('aria-hidden')).toBe('true');
  });

  it('没戴框 / 框过期 / 素材缺失（frameUrl 为 null）时不画那个 img', () => {
    expect(buildUserCardElement(document, card()).querySelector('img.avatar__frame')).toBeNull();
  });

  it('★ 绝不与图床图 / 表情共用一个类名（否则点名片会弹大图灯箱）', () => {
    const el = buildUserCardElement(document, card({ frameUrl: '/api/frames/cat.png' }));
    for (const img of el.querySelectorAll('img')) {
      expect(img.classList.contains(IMAGE_REF_CLASS)).toBe(false);
      expect(img.classList.contains(STICKER_REF_CLASS)).toBe(false);
    }
  });

  it('用户名走 textContent —— 恶意名字不会变成元素', () => {
    const evil = '<img src=x onerror="window.__x=1">';
    const el = buildUserCardElement(document, card({ username: evil }));
    const name = el.querySelector(`.${USER_REF_NAME_CLASS}`)!;
    expect(name.textContent).toBe(evil);
    expect(name.children).toHaveLength(0);
    expect(el.querySelectorAll('img')).toHaveLength(1); // 只有头像那一张
  });

  it('img 上不存在任何用户可控的属性名', () => {
    const img = buildUserCardElement(
      document,
      card({ frameUrl: '/api/frames/cat.png' })
    ).querySelector('img.avatar__img')!;
    expect(Array.from(img.attributes).map((a) => a.name).sort()).toEqual([
      'alt',
      'class',
      'loading',
      'src',
    ]);
  });
});

// ── 替换趟 ──────────────────────────────────────────────────────────────────

describe('embedUserRefs', () => {
  const cards = new Map<string, UserCardData>([
    ['张三丰', card()],
    ['李四光', card({ id: '11111111-2222-3333-4444-555555555555', username: '李四光', frameUrl: '/f.png' })],
  ]);

  it('把 token 换成名片，前后的文字留在原地', () => {
    const root = holder('你好 [@用户/张三丰] 再见');
    embedUserRefs(root, cards);
    expect(root.querySelectorAll(USER_REF_CLASS_SEL)).toHaveLength(1);
    expect(root.textContent).toBe('你好 张三丰 再见');
  });

  it('★ 查不到的名字原样留字面量（fail-closed，不报错）', () => {
    const root = holder('[@用户/并不存在] 在吗');
    embedUserRefs(root, cards);
    expect(root.querySelectorAll(USER_REF_CLASS_SEL)).toHaveLength(0);
    expect(root.textContent).toBe('[@用户/并不存在] 在吗');
  });

  it('★ 查不到的那些**不占预算** —— 后面画得出来的仍然画出来', () => {
    const text = ['[@用户/甲不存在]', '[@用户/乙不存在]', ...Array.from({ length: MAX_USER_REFS }, () => '[@用户/张三丰]')].join(
      ' '
    );
    const root = holder(text);
    embedUserRefs(root, cards);
    expect(root.querySelectorAll(USER_REF_CLASS_SEL)).toHaveLength(MAX_USER_REFS);
    // 没查到的两个仍是字面量（字数不等，所以只断言包含）
    expect(root.textContent).toContain('[@用户/甲不存在]');
  });

  it('★ 有上限：超出的保留字面量（与表情 / 图床同口径）', () => {
    const many = Array.from({ length: MAX_USER_REFS + 3 }, () => '[@用户/张三丰]').join(' ');
    const root = holder(many);
    embedUserRefs(root, cards);
    expect(root.querySelectorAll(USER_REF_CLASS_SEL)).toHaveLength(MAX_USER_REFS);
    expect(root.textContent).toContain('[@用户/张三丰]');
  });

  it('★ cards 为空时整趟不跑（数据还没到时不该动 DOM）', () => {
    const root = holder('[@用户/张三丰]');
    embedUserRefs(root, undefined);
    expect(root.innerHTML).toBe('[@用户/张三丰]');
    embedUserRefs(root, new Map());
    expect(root.innerHTML).toBe('[@用户/张三丰]');
  });

  it('★ 代码块 / 行内代码里的 token 不展开（用户要能展示这个语法本身）', () => {
    const fenced = holder('<pre><code>[@用户/张三丰]</code></pre>');
    embedUserRefs(fenced, cards);
    expect(fenced.querySelectorAll(USER_REF_CLASS_SEL)).toHaveLength(0);

    const inline = holder('<code>[@用户/张三丰]</code>');
    embedUserRefs(inline, cards);
    expect(inline.querySelectorAll(USER_REF_CLASS_SEL)).toHaveLength(0);
  });

  it('★ 链接标签内的 token 不展开成 <a> 套 <a>', () => {
    const root = holder('<a href="/blog/1">[@用户/张三丰]</a>');
    embedUserRefs(root, cards);
    expect(root.querySelectorAll('a a')).toHaveLength(0);
  });

  it('两种名片共存时各自渲染（不互相吃掉）', () => {
    const root = holder('[@用户/张三丰] 与 [@用户/李四光]');
    embedUserRefs(root, cards);
    const links = root.querySelectorAll(USER_REF_CLASS_SEL);
    expect(links).toHaveLength(2);
    expect(links[0].getAttribute('href')).toContain('550e8400');
    expect(links[1].getAttribute('href')).toContain('11111111');
  });

  it('表情 token 不受影响（它有自己的那一趟）', () => {
    const root = holder('[@用户/张三丰] [@猫猫/开心]');
    embedUserRefs(root, cards);
    expect(root.textContent).toContain('[@猫猫/开心]');
  });
});

// ── 管线层：两个渲染器的 parity ─────────────────────────────────────────────

describe.each(RENDERERS)('$name 正文的 [@用户/…]', ({ render }) => {
  const cards = new Map<string, UserCardData>([
    ['张三丰', card({ frameUrl: '/api/frames/cat.png' })],
    ['李四光', card({ id: '11111111-2222-3333-4444-555555555555', username: '李四光' })],
  ]);
  const ctx: RichTextContext = { userCards: cards };
  /** 一份合法的 10 位图床 ID（大小写字母 + 数字）。 */
  const IMG_ID = 'AbCdEf1234';

  it('渲染成行内名片：一个带框头像 + 名字，整体是一个链接', () => {
    const root = mount(render, '来认识一下 [@用户/张三丰] 吧', ctx);
    const link = root.querySelector(USER_REF_CLASS_SEL)!;
    expect(link.tagName).toBe('A');
    expect(link.getAttribute('href')).toBe('/u/550e8400-e29b-41d4-a716-446655440000');
    expect(link.querySelector('img.avatar__img')?.getAttribute('src')).toBe(
      '/api/avatar/550e8400-e29b-41d4-a716-446655440000'
    );
    expect(link.querySelector('img.avatar__frame')?.getAttribute('src')).toBe('/api/frames/cat.png');
    expect(link.textContent).toBe('张三丰');
    // 前后的文字仍在同一个段落里，没被拆成块
    expect(root.querySelectorAll('p')).toHaveLength(1);
    expect(root.textContent).not.toContain('[@用户/');
  });

  it('★ 数据还没到时是字面量（与剪贴板那条「加载中显示字面量」同口径）', () => {
    const root = mount(render, '[@用户/张三丰]');
    expect(root.querySelectorAll(USER_REF_CLASS_SEL)).toHaveLength(0);
    expect(root.textContent?.trim()).toBe('[@用户/张三丰]');
  });

  it('★ 带名片的正文**不进渲染缓存**：数据前后各渲染一次，两次结果不同', () => {
    // 这条是本节最要紧的一条。缓存以正文为键，若名片也吃缓存，第一次（数据没到 →
    // 字面量）那份会被存下来，第二次带着数据来也只会拿回字面量 —— 症状是
    // 「名片永远不出现」，不报错、不写日志，只有发的那个人看得见。
    const content = '看 [@用户/张三丰]';
    expect(render(content)).toContain('[@用户/张三丰]');
    const withData = render(content, ctx);
    expect(withData).toContain(USER_REF_CLASS);
    // 反向也要成立：那一份「有卡片」的结果没有被留下来毒害下次渲染
    expect(render(content)).toContain('[@用户/张三丰]');
  });

  it('★ 不带名片 token 的正文照旧吃缓存（别把旁路开成大水漫灌）', () => {
    const content = `普通正文 [@${IMG_ID}]`;
    expect(render(content)).toBe(render(content));
  });

  it('★ 与图床图 / 表情共存：三种行内元素各渲染各的，互不吃掉', () => {
    const root = mount(render, `图 [@${IMG_ID}] 表情 [@猫猫/开心] 名片 [@用户/张三丰]`, ctx);
    // 图床图 + 表情 + 名片的头像与框
    expect(root.querySelectorAll('img')).toHaveLength(4);
    expect(root.querySelectorAll(USER_REF_CLASS_SEL)).toHaveLength(1);
    // 按类名认，不按下标 —— 下标会随任何一趟改动的插入顺序漂
    expect(root.querySelector(`img.${IMAGE_REF_CLASS}`)?.getAttribute('src')).toBe(
      `/api/images/${IMG_ID}/raw`
    );
    expect(root.querySelector(`img.${STICKER_REF_CLASS}`)?.getAttribute('src')).toBe(
      stickerUrl('猫猫', '开心')
    );
  });

  it('★ 代码块 / 行内代码里的 token 不展开（用户要能展示这个语法本身）', () => {
    const fenced = mount(render, '```\n[@用户/张三丰]\n```', ctx);
    expect(fenced.querySelectorAll(USER_REF_CLASS_SEL)).toHaveLength(0);
    expect(fenced.textContent).toContain('[@用户/张三丰]');

    const inline = mount(render, '`[@用户/张三丰]`', ctx);
    expect(inline.querySelectorAll(USER_REF_CLASS_SEL)).toHaveLength(0);
    expect(inline.textContent).toContain('[@用户/张三丰]');
  });

  it('★ @提及 与名片互不干扰：整条消息既不被标成提及，也不产生通知', () => {
    // 高亮与通知两条判定都跑在**原始正文**上，所以这里问的是原始字符串
    const content = '看 [@用户/张三丰] 和 @李四光';
    expect(isMentioned(content, '张三丰')).toBe(false);
    expect(isMentioned(content, '用户')).toBe(false);
    expect(extractMentions(content)).toEqual(['李四光']);
  });

  it('一条消息里的名片有上限，超出的保留字面量', () => {
    const many = Array.from({ length: MAX_USER_REFS + 3 }, () => '[@用户/张三丰]').join(' ');
    const root = mount(render, many, ctx);
    expect(root.querySelectorAll(USER_REF_CLASS_SEL)).toHaveLength(MAX_USER_REFS);
    expect(root.textContent).toContain('[@用户/张三丰]');
  });

  it('查不到的名字保留字面量', () => {
    const root = mount(render, '[@用户/并不存在]', ctx);
    expect(root.querySelectorAll(USER_REF_CLASS_SEL)).toHaveLength(0);
    expect(root.textContent).toContain('[@用户/并不存在]');
  });
});
