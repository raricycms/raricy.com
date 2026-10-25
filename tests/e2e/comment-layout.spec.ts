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
//   · 纵向：每张评论卡片保留下内距，嵌套列表不额外添加下外边距；
//   · 横向：`.comment-item` 有 min-width，跌破它时**只由 `.comment-section > .comment-list`
//     接住**（那里是 overflow-x: auto）—— 中间层必须保持 visible，否则每层各画一条横条。
// 于是「页面本身不横向滚动」这条老契约照旧，被允许溢出的只有那一个容器。
// 细节见 pages/blog/_comments.scss 里 .comment-list / .comment-item 两处的整段说明。
//
// 【2026-10：楼中楼从「回复槽」改成每层一张卡】嵌套列表透明、只剩左内距表达层级，
// 同级子评论之间不再有分割线（换卡不换线），每张卡片都保留底部留白，
// 只是「回复槽」这个词在本文件里指的是那条透明缩进列表。

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

// ── 标题计数 / 空态 ─────────────────────────────────────────────────────────────
//
// 这两个都是**只有客户端拉完评论才成立**的状态（首屏 comment 列表是空的），所以必须在
// 真浏览器里等它落定；接口层看到的是另一份数据，测不到徽标上的数。
test('标题计数包含楼中楼，不是只数根评论', async ({ page }) => {
  await registerFreshUser(page, { core: true });
  const blogId = await createBlog(page, `评论计数 ${uniqueTag()}`);

  const tag = uniqueTag();
  const root = await postComment(page, blogId, `计数根 ${tag}`);
  await postComment(page, blogId, `计数回复一 ${tag}`, root);
  await postComment(page, blogId, `计数回复二 ${tag}`, root);

  await page.goto(`/blog/${blogId}`);
  await expect(page.locator('.comment-item', { hasText: `计数回复一 ${tag}` }).last()).toBeVisible();
  // 1 条根 + 2 条回复。只数根节点时这里会是 1，正是要拦的静默错。
  await expect(page.locator('.comment-section__count')).toHaveText('3');
});

test('没有评论时显示空态，且列表里没有评论卡片', async ({ page }) => {
  await registerFreshUser(page, { core: true });
  const blogId = await createBlog(page, `评论空态 ${uniqueTag()}`);

  await page.goto(`/blog/${blogId}`);
  await expect(page.locator('.comment-status--empty')).toBeVisible();
  await expect(page.locator('#comment-list .comment-item')).toHaveCount(0);
  // 空态也是 #comment-list 的一部分（评论区永远是同一个 DOM 骨架）
  await expect(page.locator('#comment-list .comment-status--empty')).toHaveCount(1);
});

// 每张卡片都应包住子回复，底部留白不能因展开楼中楼而消失。
test('楼中楼展开和收起时每张评论卡片都保留底部留白', async ({ page }) => {
  await registerFreshUser(page, { core: true });
  const blogId = await createBlog(page, '楼中楼间距 ' + uniqueTag());
  const tag = uniqueTag();
  let parent: string | undefined;
  for (let i = 0; i < 5; i++) {
    parent = await postComment(page, blogId, '第' + (i + 1) + '层 ' + tag, parent);
  }

  await page.goto('/blog/' + blogId);
  await expect(page.locator('.comment-item')).toHaveCount(5);

  const cards = await page.locator('.comment-item').evaluateAll((items) =>
    items.map((item) => {
      const style = getComputedStyle(item);
      const children = item.querySelector<HTMLElement>(':scope > .children.comment-list');
      return {
        paddingTop: parseFloat(style.paddingTop),
        paddingBottom: parseFloat(style.paddingBottom),
        bottomGap: children
          ? item.getBoundingClientRect().bottom - children.getBoundingClientRect().bottom
          : null,
      };
    })
  );
  for (const card of cards) {
    expect(card.paddingBottom, '评论卡片缺少下内距').toBeGreaterThan(0);
    expect(card.paddingBottom).toBe(card.paddingTop);
    if (card.bottomGap !== null) {
      expect(Math.abs(card.bottomGap - card.paddingBottom), '子回复贴住父卡片底边').toBeLessThanOrEqual(1);
    }
  }

  const nested = page.locator('#comment-list > .comment-item > .children > .comment-item');
  await nested.locator(':scope > .comment-item__body .comment-collapse').click();
  await expect(nested.locator(':scope > .children')).toBeHidden();
  const collapsed = await nested.evaluate((item) => {
    const style = getComputedStyle(item);
    return { top: style.paddingTop, bottom: style.paddingBottom };
  });
  expect(collapsed.bottom).toBe(collapsed.top);
});

// ── 深层楼中楼：最内层不许被挤成一个字宽，整片评论区共用一条横向滚动条 ──────────────
//
// 【为什么必须自己钉视口】两个 project 都跑这个文件，而触发深度取决于可用宽度：
//   · 每深一层缩进 = 嵌套列表左内距（桌面 14 / 窄屏 10）+ 子评论卡左右内距
//     （桌面 16＋16 / 窄屏 12＋12），桌面每层约 46px、窄屏每层约 34px；
//   · 1280 桌面 → 可用约 868，要十几层才跌破 min-width；
//   · 390 窄屏 → 可用 358，第 5 层（根算第 1 层）起就跌破。
// 不钉视口的话 desktop 那一遍得造十几条评论，两遍测的还不是同一件事。
// 固定 390 后两遍量到的几何完全一致，顺带走「窄屏缩进收窄」那条分支。
// setViewportSize 必须在 goto **之前**（同 favorite-layout.spec.ts 的 at()）。
const DEEP_VW = 390;
// 390 下可用 358、根卡内距 16、每层缩进 22（列表 10 + 卡片内距 12）：第 5 层起跌破
// min-width。取 20 层 —— 最内层左边缘约 424、宽 240 ⇒ 右边缘 664，比 358 多出约 306px，
// 远大于 ±1px 容差。20 条评论远在 commentDaily（8000/天，无分钟档）之下。
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

// ─────────────────────────────────────────────────────────────────────────────
// 底条从两颗孩子变成三颗（提示 / 匿名勾选项 / 提交）之后的排版
//
// 【为什么值得一条】输入区底条是 `display:flex; justify-content:space-between`，
// 原来的两颗孩子靠 space-between 天然贴两端；插进第三颗（匿名勾选项）之后，
// 布局是否正确不再能从「贴两端」推出来 —— 窄屏下挤掉提交按钮、或把整条顶出行外，
// 都是**只在某个宽度才出现**的坏法。这条文件登记在 RESPONSIVE_SPECS 里，
// 于是桌面与窄屏都会量。
// ─────────────────────────────────────────────────────────────────────────────
test('匿名勾选项挤进底条后：三样都在行内，且底条没有被顶宽', async ({ page }) => {
  await registerFreshUser(page, { core: true });
  const blogId = await createBlog(page, `匿名底条 ${uniqueTag()}`);
  await page.goto(`/blog/${blogId}`);

  const composer = page.locator('.comment-composer').first();
  await expect(composer).toBeVisible();

  const anon = composer.locator('.comment-composer__anon input[type="checkbox"]');
  await expect(anon, '勾选项没渲染出来 —— 匿名就无从发起').toBeVisible();
  const send = composer.locator('.comment-composer__send');
  await expect(send).toBeVisible();

  const geom = await page.evaluate(() => {
    const box = document.querySelector('.comment-composer__foot') as HTMLElement | null;
    const a = document.querySelector('.comment-composer__anon') as HTMLElement | null;
    const s = document.querySelector('.comment-composer__send') as HTMLElement | null;
    if (!box || !a || !s) return null;
    const b = box.getBoundingClientRect();
    const ar = a.getBoundingClientRect();
    const sr = s.getBoundingClientRect();
    return {
      overflow: box.scrollWidth - box.clientWidth,
      // 三样都必须落在底条自己的矩形里（允许 1px 的亚像素误差）
      anonInside: ar.left >= b.left - 1 && ar.right <= b.right + 1,
      sendInside: sr.left >= b.left - 1 && sr.right <= b.right + 1,
      // 提交按钮不许被勾选项挤到下一行（两者纵向有交集才算同一行）
      sameRow: ar.bottom > sr.top && sr.bottom > ar.top,
    };
  });

  expect(geom, '底条没找到').not.toBeNull();
  expect(geom!.overflow, '底条被顶宽了 —— 会溢出到面板外').toBeLessThanOrEqual(1);
  expect(geom!.anonInside, '勾选项跑到行外了').toBe(true);
  expect(geom!.sendInside, '提交按钮跑到行外了').toBe(true);
  expect(geom!.sameRow, '提交按钮被挤到下一行了').toBe(true);
});

// ─────────────────────────────────────────────────────────────────────────────
// 折叠箭头：收起 / 展开子回复
//
// 折叠是纯客户端状态（CommentSection 的 Set<string>），接口层看不到；而「hidden 让
// 整棵子树退出排版」只有真浏览器说得清。断三件事：
//   ① 带子楼的评论才有箭头，叶子没有；
//   ② 点一下：子列表不可见、aria-expanded 变 false，子孙一并被收起；
//   ③ 再点回来：子列表重新可见、aria-expanded 变 true。
// 另外钉住「只折本条子树」—— 另一条根评论的子回复不许被连带折叠。
// ─────────────────────────────────────────────────────────────────────────────
test('折叠箭头收起并重新展开子回复', async ({ page }) => {
  await registerFreshUser(page, { core: true });
  const blogId = await createBlog(page, `评论折叠 ${uniqueTag()}`);

  const tag = uniqueTag();
  const root = await postComment(page, blogId, `折叠根 ${tag}`);
  const child = await postComment(page, blogId, `折叠子 ${tag}`, root);
  await postComment(page, blogId, `折叠孙 ${tag}`, child);
  const otherRoot = await postComment(page, blogId, `另一根 ${tag}`);
  await postComment(page, blogId, `另一子 ${tag}`, otherRoot);

  await page.goto(`/blog/${blogId}`);
  // ⚠️ 必须 .last()：父级 li 的 textContent 包住整棵子树，祖先**都**命中 hasText。
  await expect(page.locator('.comment-item', { hasText: `折叠孙 ${tag}` }).last()).toBeVisible();

  const rootItem = page.locator('#comment-list > .comment-item', { hasText: `折叠根 ${tag}` });
  const arrow = rootItem.locator(':scope > .comment-item__body .comment-collapse');
  const children = rootItem.locator(':scope > ul.children');

  // ① 根有子楼 → 有箭头；孙子没有子楼 → 没有箭头
  await expect(arrow).toHaveAttribute('aria-expanded', 'true');
  await expect(arrow).toHaveAttribute('aria-label', '收起回复');
  const childrenId = await children.getAttribute('id');
  expect(childrenId, '子列表没有 id，aria-controls 就没有落点').toBeTruthy();
  await expect(arrow).toHaveAttribute('aria-controls', childrenId!);
  await expect(children).toBeVisible();
  await expect(
    page.locator('.comment-item', { hasText: `折叠孙 ${tag}` }).last().locator('.comment-collapse')
  ).toHaveCount(0);

  // ② 收起：子列表（含孙回复）不可见，ARIA 同步
  await arrow.click();
  await expect(arrow).toHaveAttribute('aria-expanded', 'false');
  await expect(arrow).toHaveAttribute('aria-label', '展开回复');
  await expect(children).toBeHidden();
  await expect(
    page.locator('.comment-item', { hasText: `折叠孙 ${tag}` }).last(),
    '折叠父级后孙回复还看得见 —— hidden 没盖住整棵子树'
  ).toBeHidden();

  // 只折本条子树：另一条根评论的子回复照旧
  await expect(page.locator('.comment-item', { hasText: `另一子 ${tag}` }).last()).toBeVisible();

  // ③ 展开：子列表回来，状态复位
  await arrow.click();
  await expect(arrow).toHaveAttribute('aria-expanded', 'true');
  await expect(children).toBeVisible();
  await expect(page.locator('.comment-item', { hasText: `折叠孙 ${tag}` }).last()).toBeVisible();
});

// ─────────────────────────────────────────────────────────────────────────────
// 对齐：头像 / 正文 / 操作行同一条竖线，折叠箭头守在操作行右端
//
// 这两件都是**排版结果**，读样式表算不出来（正文有没有让出缩进、箭头落在哪一行，
// 由 flex 与可用宽度共同决定）。改版前是「正文缩进到头像宽 + 间距，箭头挂在身份行
// 末尾」；下面的断言就是那次改版的落点 —— 别只靠截图看。
// ─────────────────────────────────────────────────────────────────────────────
test('正文与操作行从头像左边缘起排，折叠箭头在操作行同一行右端', async ({ page }) => {
  await registerFreshUser(page, { core: true });
  const blogId = await createBlog(page, `评论对齐 ${uniqueTag()}`);

  const tag = uniqueTag();
  const root = await postComment(page, blogId, `对齐根 ${tag}`);
  await postComment(page, blogId, `对齐子 ${tag}`, root);

  await page.goto(`/blog/${blogId}`);
  const item = page.locator('#comment-list > .comment-item', { hasText: `对齐根 ${tag}` });
  await expect(item.locator(':scope > .children .comment-item').first()).toBeVisible();

  const geom = await item.evaluate((li) => {
    const q = (sel: string) => li.querySelector<HTMLElement>(sel);
    const avatar = q(':scope > .comment-meta .comment-author-avatar');
    const content = q(':scope > .comment-item__body > .comment-content');
    const actions = q(':scope > .comment-item__body > .comment-actions');
    // 登录着的核心用户 → 点赞与回复按钮都在，用它当「按钮那一行」的参照
    const like = q(':scope > .comment-item__body .comment-actions .comment-like');
    const arrow = q(':scope > .comment-item__body .comment-actions .comment-collapse');
    if (!avatar || !content || !actions || !like || !arrow) return null;
    const box = (el: HTMLElement) => el.getBoundingClientRect();
    const a = box(avatar);
    const c = box(content);
    const act = box(actions);
    const lk = box(like);
    const ar = box(arrow);
    return {
      avatarLeft: a.left,
      contentLeft: c.left,
      actionsLeft: act.left,
      actionsRight: act.right,
      arrowRight: ar.right,
      // 与点赞按钮在纵向有交集 = 同一行（不比较行高，触屏下按钮会更高）
      sameRow: ar.bottom > lk.top && lk.bottom > ar.top,
    };
  });

  expect(geom, '评论卡片里没找到头像 / 正文 / 操作行，断言前提不成立').not.toBeNull();
  expect(Math.abs(geom!.contentLeft - geom!.avatarLeft), '正文没有和头像左对齐').toBeLessThanOrEqual(1);
  expect(
    Math.abs(geom!.actionsLeft - geom!.avatarLeft),
    '操作行没有和头像左对齐'
  ).toBeLessThanOrEqual(1);
  expect(Math.abs(geom!.arrowRight - geom!.actionsRight), '折叠箭头没贴在操作行右端').toBeLessThanOrEqual(1);
  expect(geom!.sameRow, '折叠箭头掉到了操作按钮下面').toBe(true);
});

// ─────────────────────────────────────────────────────────────────────────────
// 就地回复的表单：只留输入框本体（不再有「回复 某某：…」预览条），右上角一颗叉
// ─────────────────────────────────────────────────────────────────────────────
test('就地回复只留输入框，右上角的叉能收起表单', async ({ page }) => {
  await registerFreshUser(page, { core: true });
  const blogId = await createBlog(page, `就地回复 ${uniqueTag()}`);

  const tag = uniqueTag();
  await postComment(page, blogId, `回复目标 ${tag}`);

  await page.goto(`/blog/${blogId}`);
  const item = page.locator('#comment-list > .comment-item', { hasText: `回复目标 ${tag}` });
  await item.locator('.comment-action', { hasText: '回复' }).click();

  const inline = page.locator('#comment-form.is-inline');
  await expect(inline).toBeVisible();
  // ① 只留输入框：旧版那条「回复 某某：正文预览」条不再出现
  await expect(inline.locator('.comment-composer__reply')).toHaveCount(0);
  // 目标没有丢 —— 搬进了输入框的占位符里
  await expect(inline.locator('.comment-composer__input')).toHaveAttribute('placeholder', /^回复 /);

  // ② 表单自身**不套外框**：没有内距 / 底色 / 圆角，输入面板就是最外层那一块。
  //    这条必须取计算值：少写一条就会重新长出「框里套框」，而页面看着也不算坏。
  const frame = await inline.evaluate((form) => {
    const panel = form.querySelector<HTMLElement>('.comment-composer__panel');
    const body = form.parentElement?.querySelector<HTMLElement>(':scope > .comment-item__body');
    const content = body?.querySelector<HTMLElement>(':scope > .comment-content') ?? null;
    const cs = getComputedStyle(form as HTMLElement);
    const box = (el: Element | null) => (el ? el.getBoundingClientRect() : null);
    const pb = box(panel);
    const cb = box(content);
    const rgb = panel ? getComputedStyle(panel).backgroundColor : '';
    // Chromium 对 color-mix 的结果会序列化成 `color(srgb … / <alpha>)`，
    // 不一定是 rgba()；两种写法都认，别只匹配 rgba 就当成「不透明」。
    const alphaOf = (value: string): number => {
      if (!value || value === 'transparent') return value ? 0 : 1;
      const rgba = value.match(/rgba?\(([^)]+)\)/);
      if (rgba) {
        const parts = rgba[1].split(/[,\s/]+/).filter(Boolean).map(Number);
        return parts.length === 4 ? parts[3] : 1;
      }
      const colorFn = value.match(/color\(([^)]+)\)/);
      if (colorFn) {
        const slash = colorFn[1].split('/');
        return slash.length > 1 ? parseFloat(slash[1]) : 1;
      }
      return 1;
    };
    return {
      paddingLeft: parseFloat(cs.paddingLeft),
      radius: parseFloat(cs.borderRadius) || 0,
      background: cs.backgroundColor,
      // 面板左边缘与正文左边缘同一条竖线（外框若回来，这里会先偏移一档内距）
      panelLeftGap: pb && cb ? Math.abs(pb.left - cb.left) : null,
      // 面板底色必须是半透明罩：它叠在任何一层评论卡上都可见；
      // 换成固定色会在某一档卡片上消失（一级白卡 / 二级浅灰卡各吃掉一种固定色）
      panelAlpha: alphaOf(rgb),
    };
  });
  expect(frame.paddingLeft, '就地回复框外面又套了一层内距').toBe(0);
  expect(frame.radius, '就地回复框外面又套了一层圆角').toBe(0);
  expect(frame.background, '就地回复框外面又套了一层底色').toBe('rgba(0, 0, 0, 0)');
  expect(frame.panelLeftGap, '回复面板没有和正文左对齐').toBeLessThanOrEqual(1);
  expect(frame.panelAlpha, '回复面板用了不透明底色 —— 会在某一层评论卡上消失').toBeLessThan(1);

  // ③ 叉在面板右上角：与工具条同一行、贴右端
  const closeBtn = inline.getByRole('button', { name: '取消回复' });
  await expect(closeBtn).toBeVisible();
  const geo = await inline.evaluate((form) => {
    const panel = form.querySelector<HTMLElement>('.comment-composer__panel');
    const toolbar = form.querySelector<HTMLElement>('.comment-composer__toolbar');
    const close = form.querySelector<HTMLElement>('.comment-composer__dismiss');
    if (!panel || !toolbar || !close) return null;
    const p = panel.getBoundingClientRect();
    const t = toolbar.getBoundingClientRect();
    const c = close.getBoundingClientRect();
    return {
      inToolbarRow: c.top >= t.top - 1 && c.bottom <= t.bottom + 1,
      rightGap: t.right - c.right,
      topGap: c.top - p.top,
    };
  });
  expect(geo, '就地回复的表单里没有找到右上角的叉').not.toBeNull();
  expect(geo!.inToolbarRow, '叉不在工具条那一行').toBe(true);
  expect(geo!.rightGap, '叉没有贴住面板右端').toBeLessThanOrEqual(1);
  expect(geo!.topGap, '叉跑到了面板下方').toBeLessThanOrEqual(12);

  // ④ 点叉：表单从评论下方消失，回到顶部（新写一条评论的状态）
  await closeBtn.click();
  await expect(inline).toHaveCount(0);
  await expect(page.locator('#comment-form')).toBeVisible();
});
