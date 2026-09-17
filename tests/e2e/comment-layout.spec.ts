// 评论区**布局**端到端（真浏览器 + 真视口）
//
// 【为什么这条必须走 e2e】断言的是「楼中楼不把祖先撑出横向溢出」。那是
// `box-sizing: border-box` 与 `width: 100%` 在**真实排版**下的合力，读代码算不出来：
//
//   · 顶层 .comment-list 是 `.comment-section` 的直接子元素，被
//     `.comment-section > &` 那条重置压住了（padding/margin 都归零）；
//   · 但**回复**渲染成 `<li class="comment-item">` 里的 `<ul class="children comment-list">`，
//     父级是 <li> 而不是 .comment-section，匹配不到那条重置 —— 于是它按
//     `width: 100%` + `margin-left: 15px` 原样生效。border-box 下 padding 算在
//     100% 里、margin 不算，所以每一层向右溢出 15px，冒泡到最近的可滚祖先。
//
// 用户报的症状：**评论区底部多出一条横向滚动条**。那个滚动容器是 CommentSection
// 自己的根节点 —— 它也用了 `.blog-detail` 这个页面级类名（见文件末尾那条），因此
// 白拿了一份 `overflow-x: auto`。
//
// 【本文件登记在 RESPONSIVE_SPECS 里】它验的是排版事实，窄屏换行行为不同，两个
// project 都要跑。

import { test, expect } from '@playwright/test';
import { registerFreshUser, uniqueTag } from './helpers';

/** 建一篇博客（走真实接口），返回 id。 */
async function createBlog(page: import('@playwright/test').Page, title: string): Promise<string> {
  const res = await page.request.post('/api/blogs', {
    data: { title, description: 'e2e 造数', content: '# 正文' },
  });
  expect(res.status(), `建文章失败：${await res.text()}`).toBe(200);
  return (await res.json()).blog_id as string;
}

/** 发一条评论 / 回复（parentId 给了就是楼中楼），返回 id。 */
async function postComment(
  page: import('@playwright/test').Page,
  blogId: string,
  content: string,
  parentId?: string
): Promise<string> {
  const res = await page.request.post(`/api/blogs/${blogId}/comments`, {
    data: parentId ? { content, parent_id: parentId } : { content },
  });
  expect(res.status(), `发评论失败：${await res.text()}`).toBe(200);
  return ((await res.json()) as { comment: { id: string } }).comment.id;
}

test('楼中楼不横向溢出：评论区底部不该出现横向滚动条', async ({ page }) => {
  await registerFreshUser(page, { core: true });
  const blogId = await createBlog(page, `评论区布局 ${uniqueTag()}`);

  const tag = uniqueTag();
  const top = await postComment(page, blogId, `顶层 ${tag}`);
  const mid = await postComment(page, blogId, `二层 ${tag}`, top);
  await postComment(page, blogId, `三层 ${tag}`, mid);

  await page.goto(`/blog/${blogId}`);
  // 等评论真渲染出来（客户端拉的），否则量到的是一片空容器
  await expect(page.locator('.comment-item', { hasText: tag }).first()).toBeVisible();
  // 三层嵌套确实成立（否则下面等于什么都没测）
  await expect(page.locator('.comment-list .comment-list .comment-list')).toHaveCount(1);

  const report = await page.evaluate(() => {
    const section = document.querySelector('#comment-section');
    if (!section) return { missing: true, scrollers: [], lists: [] };
    // CommentSection 的根节点（也挂着 .blog-detail）
    const wrap = section.closest('.blog-detail') as HTMLElement;
    const scrollers: string[] = [];
    const lists: string[] = [];

    // ① 症状：整页 + 评论区里的每个滚动容器都不该有横向溢出
    const nodes: HTMLElement[] = [document.documentElement, wrap, ...wrap.querySelectorAll<HTMLElement>('*')];
    for (const n of nodes) {
      if (n.scrollWidth > n.clientWidth + 1) {
        scrollers.push(`${n.tagName.toLowerCase()}.${n.className || '(无类名)'} +${n.scrollWidth - n.clientWidth}px`);
      }
    }
    // ② 病因：每一层 .comment-list 的右边界不许越过父级（含父级 padding 的右边界）
    for (const l of wrap.querySelectorAll<HTMLElement>('.comment-list')) {
      const p = l.parentElement;
      if (!p) continue;
      const diff = l.getBoundingClientRect().right - p.getBoundingClientRect().right;
      if (diff > 1) lists.push(`超出父级 ${diff.toFixed(1)}px`);
    }
    return { missing: false, scrollers, lists };
  });

  expect(report.missing, '页面上没有 #comment-section，用例的前提就不成立').toBe(false);
  expect(report.scrollers, `这些容器横向溢出了：${report.scrollers.join('、')}`).toEqual([]);
  expect(report.lists, `楼中楼右边界越过了父级：${report.lists.join('、')}`).toEqual([]);
});

// 备注（未修，待定）：CommentSection 的根节点用 `className="blog-detail"`，
// 与 `src/app/blog/[id]/page.tsx` 的外层 `<article>` 同名 —— 于是它又吃了一遍
// max-width: 940px / margin: 50px auto / padding: 0 20px / overflow-x: auto，
// 评论区因此比正文再内缩 20px、再下移 50px，并且自带一个滚动容器（上面那条
// 横向滚动条就是画在它身上的）。改类名可以一并消掉，但会动到评论区的位置与宽度，
// 需要在真浏览器里目视确认，故此处只记录、未改。
