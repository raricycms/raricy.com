// `/explore` 的**站外可见文案**。
//
// 【为什么值得一条静态守卫】站长 2026-09 的明确口径：站外访客不该从这一页直接意识到
// 「这只是公开部分，还有个里站」。而这条口径**只能靠文案守**，代码上没有任何东西挡得住
// —— 下一个人（或下一个模型）看到 `listPublicBlogs` 与一页只有 public 的列表，很自然
// 会「顺手澄清」成「公开文章」，觉得那样更准确。那一刻口径就没了，而且没有任何报错。
//
// 手法：把源码里的注释剥掉，剩下的中文就是**真的会渲染给访客看的**（JSX 文本与 metadata）。
// 然后断言里面不出现「公开」「站内」这类把「子集」概念说破的词。
//
// ⚠️ 静态守卫是绊线，不是证明器。真正的保证还有 e2e 那条断言 h1 文案的用例。

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const EXPLORE = path.resolve(import.meta.dirname, '../../src/app/explore/page.tsx');

/** 剥掉源码里的注释 —— 剩下的才是会渲染出去的文本。 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '') // /** */ 与 JSX 的 {/* */}
    .replace(/^[ \t]*\/\/.*$/gm, ''); // 行注释
}

const exploreSrc = fs.readFileSync(EXPLORE, 'utf-8');
const exploreVisible = stripComments(exploreSrc);

describe('/explore 的站外文案', () => {
  it('产出自检：剥注释这一步真的剥掉了（否则下面几条会静默变绿）', () => {
    expect(exploreSrc).toContain('公开'); // 注释里确实有
    expect(exploreVisible, '剥注释后不该还剩注释里的「公开」').not.toContain('公开');
    // 但渲染文本必须还在（证明不是把整个文件剥空了）
    expect(exploreVisible).toContain('<h1>');
    expect(exploreVisible).toContain('这里还没有文章');
  });

  it('★ 站外可见的文案里不出现「公开」或「站内」', () => {
    // 这两个词都会把「本站还有一半没给你看」明说出来。访客点顶栏「博客」进来，
    // 看到的就是「博客」—— 那条链是自洽的，不需要他关心背后的档位设计。
    for (const word of ['公开', '站内', '核心用户', '可见范围']) {
      expect(
        exploreVisible.includes(word),
        `文案里出现了「${word}」—— 它会让站外访客意识到这只是个子集。` +
          `要么换个说法，要么先回去确认站长改了口径。`
      ).toBe(false);
    }
  });

  it('h1 与副标题与站内 /blog 逐字相同（这一页对访客**就是**博客）', () => {
    const blog = stripComments(
      fs.readFileSync(path.resolve(import.meta.dirname, '../../src/app/blog/page.tsx'), 'utf-8')
    );
    expect(exploreVisible, '/explore 的 h1').toContain('<h1>博客</h1>');
    expect(blog, '站内 /blog 的 h1').toContain('<h1>博客</h1>');
    expect(exploreVisible, '两侧副标题也该一致').toContain('<p>分享思考与见解</p>');
    expect(blog).toContain('<p>分享思考与见解</p>');
  });

  it('标题与描述自足，不写「作者选择公开的」那类对比句', () => {
    expect(exploreVisible).toContain("title: '博客 - 聪明山'");
    expect(exploreVisible).toContain("description: '聪明山的原创文章与思考分享。'");
  });

  it('空态分两种说法：搜出来的空与本来就没有', () => {
    // 搜无结果却写「这里还没有文章」，搜的人会以为自己搜错了地方 ——
    // 与「限频提示不能写成没有结果」是同一条纪律。
    expect(exploreVisible).toContain('没有找到匹配的文章');
    expect(exploreVisible).toContain('这里还没有文章');
  });
});
