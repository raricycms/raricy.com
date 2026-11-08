// 评论区**行为**端到端（真浏览器）
//
// 保留的是只有客户端渲染/交互才成立的状态：标题计数含楼中楼、空态、折叠箭头的
// 展开/收起状态机、就地回复表单的开合。楼中楼的横向溢出、卡片内距、头像/操作行
// 对齐、底条三件的几何属于外观，按仓库纪律不再由 e2e 钉住 —— 由受影响页面与视口的
// 实际检查负责（见 reports/round4/parts/e2e-visual.md 的页面验收清单）。

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

// 标题计数 / 空态这两个都是**只有客户端拉完评论才成立**的状态（首屏 comment 列表
// 是空的），所以必须在真浏览器里等它落定；接口层看到的是另一份数据，测不到徽标上的数。
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

// 折叠是纯客户端状态（CommentSection 的 Set<string>），接口层看不到；而「hidden 让
// 整棵子树退出排版」只有真浏览器说得清。断三件事：
//   ① 带子楼的评论才有箭头，叶子没有；
//   ② 点一下：子列表不可见、aria-expanded 变 false，子孙一并被收起；
//   ③ 再点回来：子列表重新可见、aria-expanded 变 true。
// 另外钉住「只折本条子树」—— 另一条根评论的子回复不许被连带折叠。
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

// 就地回复的表单：只留输入框本体（不再有「回复 某某：…」预览条），右上角一颗叉。
// 外框的内距/圆角/底色与叉的像素位置属于外观，已退出断言。
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

  // ② 叉可用：点它，表单从评论下方消失，回到顶部（新写一条评论的状态）
  const closeBtn = inline.getByRole('button', { name: '取消回复' });
  await expect(closeBtn).toBeVisible();
  await closeBtn.click();
  await expect(inline).toHaveCount(0);
  await expect(page.locator('#comment-form')).toBeVisible();
});
