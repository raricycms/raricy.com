// `/explore` 的**站外可见文案**（站长口径）。
//
// 【守的是什么】站外访客不该从这一页直接意识到「这只是公开部分，还有个里站」。这条口径
// **只能靠文案守**：代码上没有任何东西挡得住。下一个人看到 `listPublicBlogs` 与一页只有
// public 的列表，很自然会「顺手澄清」成「公开文章」—— 那一刻口径就没了，且没有任何报错。
//
// 手法：剥掉源码注释后，剩下的中文就是**真的会渲染给访客看的**（JSX 文本与 metadata），
// 再断言里面不出现把「子集」概念说破的词。
//
// ⚠️ 这里是绊线，不是证明器。h1 与页面标题另由 explore.spec.ts 的 e2e 覆盖；
// 装饰性文案（副标题等）不在此固定，改文案不该触发测试。

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

const exploreVisible = stripComments(fs.readFileSync(EXPLORE, 'utf-8'));

describe('/explore 的站外文案', () => {
  it('剥注释自检（否则下面几条会静默变绿）', () => {
    const sample = '// 公开\n/** 站内 */\n<h1>博客</h1>';
    const stripped = stripComments(sample);
    expect(stripped, '行注释没剥掉').not.toContain('公开');
    expect(stripped, '块注释没剥掉').not.toContain('站内');
    expect(stripped).toContain('<h1>博客</h1>');
    // 真实页面里渲染文本仍在（证明不是把整个文件剥空了）
    expect(exploreVisible).toContain('<h1>博客</h1>');
  });

  it('★ 站外可见的文案里不出现「公开」「站内」等把子集说破的词', () => {
    for (const word of ['公开', '站内', '核心用户', '可见范围']) {
      expect(
        exploreVisible.includes(word),
        `文案里出现了「${word}」—— 它会让站外访客意识到这只是个子集。` +
          `要么换个说法，要么先回去确认站长改了口径。`
      ).toBe(false);
    }
  });

  it('页面标题仍按「博客」表述，不写成「公开博客」', () => {
    expect(exploreVisible).toContain("title: '博客");
  });

  it('空态分两种说法：搜出来的空与本来就没有', () => {
    // 搜无结果却写「这里还没有文章」，搜的人会以为自己搜错了地方 ——
    // 与「限频提示不能写成没有结果」是同一条纪律。
    expect(exploreVisible).toContain('没有找到匹配的文章');
    expect(exploreVisible).toContain('这里还没有文章');
  });
});
