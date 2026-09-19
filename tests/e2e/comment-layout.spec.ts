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
// 用户报的症状：**评论区底部多出一条横向滚动条**。那个滚动容器当时是 CommentSection
// 自己的根节点 —— 它误用了 `.blog-detail` 这个页面级类名，白拿了一份 `overflow-x: auto`。
// 该类名已拆掉（改用与正文同列的 `.blog-content-container-container`，见文件末尾），
// 于是溢出不再被就地裁掉而是**冒泡到 `<article class="blog-detail">`** —— 那也是滚动
// 容器，所以下面 ① 把它一并量进去；只量 documentElement 会漏。
//
// 【本文件登记在 RESPONSIVE_SPECS 里】它验的是排版事实，窄屏换行行为不同，两个
// project 都要跑。
//
// 【2026-09-19：顶层列表成了**刻意**的横向滚动容器（第二条用例钉着它）】
// 上面那条「溢出不许冒泡」只对**浅层**楼中楼成立。深层楼中楼另有两条契约：
//   · 纵向：有子楼的评论下内距归零、嵌套列表下外边距归零，末尾空白不再随层数累加；
//   · 横向：`.comment-item` 有 min-width，跌破它时**只由 `.comment-section > .comment-list`
//     接住**（那里是 overflow-x: auto）—— 中间层必须保持 visible，否则每层各画一条横条。
// 于是「页面本身不横向滚动」这条老契约照旧，被允许溢出的只有那一个容器。
// 细节见 pages/blog/_blog.scss 里 .comment-list / .comment-item 两处的整段说明。

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
    // CommentSection 的根节点。
    // ⚠️ 它的祖先 `<article class="blog-detail">` 也带 `overflow-x: auto`，必须一并量：
    // 评论根不再是滚动容器之后，溢出会**冒泡到那一层**，只量 documentElement 会漏掉。
    const wrap = section.parentElement as HTMLElement;
    const article = section.closest('.blog-detail') as HTMLElement | null;
    const scrollers: string[] = [];
    const lists: string[] = [];

    // ① 症状：整页 + 正文外层 + 评论区里的每个滚动容器都不该有横向溢出
    const nodes: HTMLElement[] = [
      document.documentElement,
      ...(article ? [article] : []),
      wrap,
      ...wrap.querySelectorAll<HTMLElement>('*'),
    ];
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

// ── 楼中楼末尾不许随层数累积空白 ────────────────────────────────────────────────
//
// 成因：每一层都付两次账 —— `.comment-item` 的 padding-bottom 18 与嵌套
// `.comment-list` 的 margin-bottom 15。父级的 padding 挡住外边距折叠、子级的下外边距
// 又算进父级的 auto 高度，两者**相加**（不是取大者）⇒ 每深一层多 33px。
// 归零后每处都是「18 + 1px 分隔线 + 18」。
//
// 表达方式是「深层末尾的盒间距 ≤ 平级之间的盒间距」，而不是写死 37px —— 37 是
// `.comment-item` 的 padding 凑出来的实现细节，这里要钉的是「不随层数变」这件事。
test('楼中楼末尾不再逐层累积空白', async ({ page }) => {
  await registerFreshUser(page, { core: true });
  const blogId = await createBlog(page, `楼中楼间距 ${uniqueTag()}`);

  const tag = uniqueTag();
  const top = await postComment(page, blogId, `根一 ${tag}`);
  const mid = await postComment(page, blogId, `二层 ${tag}`, top);
  await postComment(page, blogId, `三层 ${tag}`, mid);
  // 末尾补一条根评论：要量的就是「深层末尾 → 下一条根评论」这段
  await postComment(page, blogId, `根二 ${tag}`);

  await page.goto(`/blog/${blogId}`);
  await expect(page.locator('.comment-item', { hasText: `二层 ${tag}` }).last()).toBeVisible();

  const gaps = await page.evaluate(() => {
    // ⚠️ 根评论只认顶层列表的**直接子元素**。按文本找会踩「父级 textContent 包住整棵
    //    子树」这个坑：`根一` 会把它自己子树里最深的那条也一起命中（comment-rich.spec.ts
    //    记着同一个坑）。反过来，最内层**只能**靠「最后一个匹配」拿到（文档序最后即最深）。
    const roots = [...document.querySelectorAll<HTMLElement>('#comment-list > .comment-item')];
    const deep = [...document.querySelectorAll<HTMLElement>('.comment-item')]
      .filter((el) => (el.textContent ?? '').includes('三层'))
      .pop() as HTMLElement | undefined;
    if (roots.length !== 2 || !deep) return null;
    const gap = (a: HTMLElement, b: HTMLElement) =>
      b.getBoundingClientRect().top - a.getBoundingClientRect().bottom;
    return { sibling: gap(roots[0], roots[1]), afterDeep: gap(deep, roots[1]) };
  });

  expect(gaps, '顶层列表里不是两条根评论，或者找不到最内层那条').not.toBeNull();
  // 前提：平级两条根评论之间本来就没有盒间距（间距全在各自的 padding 里）
  expect(gaps!.sibling, '平级之间居然有盒间距，下面的比较就失去意义了').toBeLessThanOrEqual(1);
  // 改前这里是 33×(3−1) = 66px
  expect(
    gaps!.afterDeep,
    `深层回复与下一条根评论之间空了 ${gaps!.afterDeep}px —— 每层的下边距/下内距又叠起来了`
  ).toBeLessThanOrEqual(1);
});

// ── 深层楼中楼：最内层不许被挤成一个字宽，整片评论区共用一条横向滚动条 ──────────────
//
// 【为什么必须自己钉视口】两个 project 都跑这个文件，而触发深度取决于可用宽度：
//   1280 桌面 → 可用 868、每层缩进 15px，要 **43 层**才跌破 min-width；
//   390 窄屏 → 可用 358、每层缩进 8px（≤768px 那档），**16 层**跌破。
// 不钉视口的话 desktop 那一遍得造 43 条评论，两遍测的还不是同一件事。
// 固定 390 后两遍量到的几何完全一致，顺带走「窄屏缩进压到 8px」那条分支。
// setViewportSize 必须在 goto **之前**（同 favorite-layout.spec.ts 的 at()）。
const DEEP_VW = 390;
// 390 下可用 358、每层 8px：第 16 层（238px）起被压倒 min-width 以下。取 20 层 ——
// 最内层左边缘 8×19 = 152、宽 240 ⇒ 右边缘 392，比 358 多出 34px，远大于 ±1px 容差。
// 20 条评论远在 commentDaily（8000/天，无分钟档）之下。
const DEEP_LEVELS = 20;

test('深层楼中楼：最内层不被挤窄，整片评论区共用一个横向滚动条', async ({ page }) => {
  await registerFreshUser(page, { core: true });
  const blogId = await createBlog(page, `深层楼中楼 ${uniqueTag()}`);

  const tag = uniqueTag();
  let parent: string | undefined;
  let deepest = '';
  for (let i = 0; i < DEEP_LEVELS; i++) {
    deepest = `第${i + 1}层 ${tag}`;
    parent = await postComment(page, blogId, deepest, parent);
  }

  await page.setViewportSize({ width: DEEP_VW, height: 900 });
  await page.goto(`/blog/${blogId}`);

  // ⚠️ 必须 .last()：父级 li 的 textContent 包住整个子树，20 个祖先**都**命中 hasText。
  const deepRow = page.locator('.comment-item', { hasText: deepest }).last();
  await expect(deepRow).toBeVisible();

  const geom = await deepRow.evaluate((el) => {
    const li = el as HTMLElement;
    const parentList = li.parentElement as HTMLElement;
    const topList = document.getElementById('comment-list') as HTMLElement;
    const cs = getComputedStyle(li);
    const nested = [...topList.querySelectorAll<HTMLElement>('.comment-list')].filter(
      (l) => l !== topList
    );
    const before = {
      minW: parseFloat(cs.minWidth),
      liW: li.getBoundingClientRect().width,
      // 父级列表的**内容**宽度：它才是这一层的可用宽度
      parentAvail: parentList.clientWidth - parseFloat(getComputedStyle(parentList).paddingLeft),
      topOverflowX: getComputedStyle(topList).overflowX,
      topOverflow: topList.scrollWidth - topList.clientWidth,
      nestedOverflowX: nested.map((l) => getComputedStyle(l).overflowX),
      pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      blogOverflow: (() => {
        const bd = document.querySelector('.blog-detail') as HTMLElement | null;
        return bd ? bd.scrollWidth - bd.clientWidth : 0;
      })(),
    };
    // 滚到底再看一眼：横条得是真能滚，且滚到底最内层要露得全
    topList.scrollLeft = 99999; // 浏览器自会夹到最大值
    return {
      ...before,
      scrolled: topList.scrollLeft,
      unreachable: li.getBoundingClientRect().right - topList.getBoundingClientRect().right,
    };
  });

  // ① 前提：这一层的可用宽度确实已跌破最小宽度（否则下面两条是白过的）
  expect(
    geom.parentAvail,
    `可用宽度 ${geom.parentAvail} 还没跌破 ${geom.minW}，用例前提不成立`
  ).toBeLessThan(geom.minW);

  // ② 用户报的症状：最内层被挤成「一行一个字」。240 不从测试里抄，读计算值 —— 免得
  //    样式与用例两边各写一个数、日后 drift（helpers.ts 对配额数字留过同样的疤）。
  expect(geom.liW, `最内层被压到 ${geom.liW}px，正文会退化成一行一个字`).toBeGreaterThanOrEqual(
    geom.minW - 1
  );

  // ③ 整片评论区共用一个横向滚动条：顶层是滚动容器，中间层**必须**不是
  expect(geom.topOverflowX, '顶层列表不是横向滚动容器了').toBe('auto');
  expect(geom.topOverflow, '顶层列表没有横向溢出 = 最内层根本没被撑住').toBeGreaterThan(1);
  expect(geom.nestedOverflowX, '中间层也成了滚动容器 ⇒ 会出现多条横条').toEqual(
    geom.nestedOverflowX.map(() => 'visible')
  );
  expect(geom.scrolled, '横条在，但列表其实滚不动').toBeGreaterThan(1);
  expect(geom.unreachable, '滚到底最内层还是露不全').toBeLessThanOrEqual(1);

  // ④ 老契约不许被破坏：溢出必须被顶层列表接住，页面与 .blog-detail 都不许长出横条
  expect(geom.pageOverflow, '页面被顶出横向滚动了').toBeLessThanOrEqual(1);
  expect(geom.blogOverflow, '.blog-detail 长出横条了 —— 溢出没被顶层列表接住').toBeLessThanOrEqual(
    1
  );
});

// 【2026-09-18 已修】CommentSection 的根节点原为 `className="blog-detail"`，与
// `src/app/blog/[id]/page.tsx` 的外层 `<article>` 同名 —— 于是它又吃了一遍
// max-width: 940px / margin: 50px auto / padding: 0 16px / overflow-x: auto，
// 评论区因此自带一个滚动容器（上面那条横向滚动条正是画在它身上的），
// 左右也比正文卡各宽 4px（窄屏则窄 16px）。
//
// 现改为与正文同列的 `.blog-content-container-container`（MarkdownRenderer 的根节点
// 用的也是它）：评论块左右边缘与正文卡**完全对齐**，两个断点都对；檐沟只有一份定义
// （桌面 20px / 窄屏 0），不会再 drift。桌面比修前窄 4px、窄屏比修前宽 16px。
//
// ⚠️ 顺带丢掉的还有那个 50px 上外边距（原先与 `.read-controls` 的 40px 折叠成 50px）——
// 现在评论区与操作区的间距就是 `.read-controls` 自己的 40px（窄屏 30px）。
// 若日后觉得太挤，改 `.read-controls` 的下外边距，**不要**给评论根节点加 margin。
