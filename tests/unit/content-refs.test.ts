// @vitest-environment jsdom
// ─────────────────────────────────────────────────────────────────────────────
// content-refs.test.ts —— 评论 / 聊天里 `[@ ]` 内容引用的**安全边界**
//
// 【为什么和 chat-markdown / comment-markdown 分开】那两份钉的是「白名单里允许
// 什么」，这份钉的是本次新开的那条**旁路**：`[@<10位图床ID>]` 能出图，靠的是
// 「净化之后由我们自己 createElement 建 <img>」，而不是把 img 加进白名单。
// 所以这里的每个用例都在问同一件事：**这条旁路有没有把防线 4 带塌**。
//
// 【安全用例的写法】与另外两份一致，每个向量问两个问题：
//   1. 危险元素/属性在不在？（img / on* / javascript:）
//   2. 用户输入有没有被**看见**？（转义成文本，而不是静默消失）
//
// 【两份渲染器都要跑】评论与聊天白名单逐字相同、只差链接类名，本文件对两者
// 跑同一组用例（parity）：一处漏打补丁、另一处不会知道 —— 这正是 rich-text.ts
// 文件头讲的「防线漂移」。
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from 'vitest';
import {
  CLIP_EXPAND_MAX,
  MAX_IMAGE_REFS,
  clipboardFailureText,
  firstClipboardRef,
  replaceClipboardRef,
  truncateClipboardContent,
} from '@/lib/content-refs';
import { renderChatMarkdown } from '@/lib/chat-markdown';
import { renderCommentMarkdown } from '@/lib/comment-markdown';

/** 渲染 + 解析成 DOM，便于按结构断言（字符串比对会被转义形式骗过去）。 */
function mount(render: (s: string) => string, content: string): HTMLElement {
  const root = document.createElement('div');
  root.innerHTML = render(content);
  return root;
}

/** 一份合法的 10 位图床 ID（大小写字母 + 数字）。 */
const IMG_ID = 'AbCdEf1234';
/** 一份合法的 8 位剪贴板 ID（小写字母 + 数字）。 */
const CLIP_ID = 'a1b2c3d4';
/** 一份合法的 9 位投票 ID。 */
const VOTE_ID = 'vOtE12345';

/** 两个渲染器 + 名字，用来对同一组用例跑 parity。 */
const RENDERERS = [
  { name: '聊天', render: renderChatMarkdown },
  { name: '评论', render: renderCommentMarkdown },
] as const;

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

// ── 纯函数层 ────────────────────────────────────────────────────────────────

describe('content-refs 纯逻辑', () => {
  it('只认第一条云剪贴板引用（一条消息最多 1 条）', () => {
    const ref = firstClipboardRef(`看这个 [@${CLIP_ID}] 还有 [@deadbeef]`);
    expect(ref?.id).toBe(CLIP_ID);
    // 第二条既不展开也不请求 —— 原样留在正文里
    const out = replaceClipboardRef(
      `看这个 [@${CLIP_ID}] 还有 [@deadbeef]`,
      ref!,
      '正文'
    );
    expect(out).toBe('看这个 正文 还有 [@deadbeef]');
  });

  it('内部空白也认（与博客同口径）', () => {
    expect(firstClipboardRef(`[@ ${CLIP_ID} ]`)?.id).toBe(CLIP_ID);
  });

  it('9 位 / 10 位 / 其它长度都不是云剪贴板引用', () => {
    expect(firstClipboardRef(`[@${VOTE_ID}]`)).toBeNull();
    expect(firstClipboardRef(`[@${IMG_ID}]`)).toBeNull();
    expect(firstClipboardRef('[@abc]')).toBeNull();
    expect(firstClipboardRef('[@abcdefghijk]')).toBeNull();
  });

  it('★ 插入的剪贴板正文里若含同样的 [@id]，不会再被展开一次（区间切片）', () => {
    const text = `[@${CLIP_ID}]`;
    const ref = firstClipboardRef(text)!;
    // 剪贴板正文里恰好也写着同一个引用
    const out = replaceClipboardRef(text, ref, `正文里也写了 [@${CLIP_ID}]`);
    expect(out).toBe(`正文里也写了 [@${CLIP_ID}]`);
    // 再找一次：若实现是 replace 重扫，这里会又命中插入内容里的那处
    expect(firstClipboardRef(out)).not.toBeNull(); // 它仍在文本里，但**已经展开过了**
  });

  it('超长剪贴板正文会截断并给出回原页的链接', () => {
    const long = 'x'.repeat(CLIP_EXPAND_MAX + 500);
    const out = truncateClipboardContent(long, CLIP_ID);
    expect(out.length).toBeLessThan(long.length);
    expect(out).toContain(`/clipboard/${CLIP_ID}`);
    expect(out).toContain('已截断');
    // 没超长就原样返回
    expect(truncateClipboardContent('短', CLIP_ID)).toBe('短');
  });

  it('失败文案与博客侧逐字一致', () => {
    expect(clipboardFailureText(CLIP_ID)).toBe(`[剪贴板 ${CLIP_ID} 加载失败]`);
  });
});

// ── 管线层：图床图片 ────────────────────────────────────────────────────────

describe.each(RENDERERS)('$name 正文的 [@10位图床ID]', ({ render }) => {
  it('渲染成内联图片，src 恰为站内图床地址', () => {
    const root = mount(render, `看图 [@${IMG_ID}]`);
    const imgs = root.querySelectorAll('img');
    expect(imgs).toHaveLength(1);
    expect(imgs[0].getAttribute('src')).toBe(`/api/images/${IMG_ID}/raw`);
    // 字面量不再以文本形式残留
    expect(root.textContent).not.toContain('[@');
  });

  it('内部带空白的写法也认', () => {
    expect(mount(render, `[@ ${IMG_ID} ]`).querySelectorAll('img')).toHaveLength(1);
  });

  it('img 上不存在任何用户可控的属性名', () => {
    const img = mount(render, `[@${IMG_ID}]`).querySelector('img')!;
    expect(Array.from(img.attributes).map((a) => a.name).sort()).toEqual([
      'alt',
      'class',
      'loading',
      'src',
    ]);
  });

  it('一条消息里的图片引用有上限，超出的保留字面量', () => {
    const many = Array.from({ length: MAX_IMAGE_REFS + 5 }, () => `[@${IMG_ID}]`).join(' ');
    const imgs = mount(render, many).querySelectorAll('img');
    expect(imgs).toHaveLength(MAX_IMAGE_REFS);
    expect(mount(render, many).textContent).toContain('[@');
  });

  it('★ 代码块 / 行内代码里的引用不展开（用户要能展示这个语法本身）', () => {
    const fenced = mount(render, '```\n[@' + IMG_ID + ']\n```');
    expect(fenced.querySelectorAll('img')).toHaveLength(0);
    expect(fenced.textContent).toContain(`[@${IMG_ID}]`);

    const inline = mount(render, '`[@' + IMG_ID + ']`');
    expect(inline.querySelectorAll('img')).toHaveLength(0);
    expect(inline.textContent).toContain(`[@${IMG_ID}]`);
  });

  it('★ 链接标签内的引用不展开成 <a> 套 <img>', () => {
    const root = mount(render, `[[@${IMG_ID}]](/blog/1)`);
    expect(root.querySelectorAll('a img')).toHaveLength(0);
  });
});

// ── 管线层：攻击面 ──────────────────────────────────────────────────────────

describe.each(RENDERERS)('$name 正文的引用攻击面', ({ render }) => {
  it('★ 防线 4 未被削弱：外链图片仍降级成链接', () => {
    const root = mount(render, '![x](https://evil.example/x.png)');
    expect(root.querySelectorAll('img')).toHaveLength(0);
    expect(root.querySelector('a')?.getAttribute('href')).toBe('https://evil.example/x.png');
  });

  it('★ 防线 1 未被削弱：手写 <img onerror> 仍被当文本、且用户看得见', () => {
    const root = mount(render, '<img src=x onerror="window.__x=1">');
    expect(root.querySelectorAll('img')).toHaveLength(0);
    expect(elementsWithEventAttrs(root)).toEqual([]);
    expect(root.textContent).toContain('<img src=x onerror=');
  });

  it('★ 9 位投票引用保持字面量（刻意不支持）', () => {
    const root = mount(render, `[@${VOTE_ID}]`);
    expect(root.querySelectorAll('img')).toHaveLength(0);
    expect(root.querySelector('.vote-embed')).toBeNull();
    expect(root.textContent).toContain(`[@${VOTE_ID}]`);
  });

  it('★ 形态不合法的 [@...] 一律不产生 img（含注入尝试）', () => {
    for (const evil of [
      `[@${IMG_ID}" onerror="alert(1)]`,
      `[@${IMG_ID}/../../etc/passwd]`,
      '[@__________]', // 10 个下划线：\w 认，严格形态不认
      '[@abcdefghij]', // 10 位但全小写也合法 —— 这条其实**该**出图，见下一条断言
    ]) {
      const root = mount(render, evil);
      if (evil === '[@abcdefghij]') {
        expect(root.querySelectorAll('img')).toHaveLength(1);
      } else {
        expect(root.querySelectorAll('img'), evil).toHaveLength(0);
        expect(elementsWithEventAttrs(root), evil).toEqual([]);
      }
    }
  });

  it('★ 8 位剪贴板引用在渲染器这一层不动它（替换在 hook 层做）', () => {
    const root = mount(render, `[@${CLIP_ID}]`);
    expect(root.querySelectorAll('img')).toHaveLength(0);
    expect(root.textContent).toContain(`[@${CLIP_ID}]`);
  });
});
