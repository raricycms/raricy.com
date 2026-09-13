// 博客正文里的投票箱（`[@<9位投票ID>]`）。
//
// 【为什么非 E2E 不可】正文是**客户端**渲染的：ContentRefProcessor 先把 `[@id]`
// 换成 `<div class="vote-embed">`，再由 blog-markdown.ts 拉数据渲染小组件。
// 单测只能钉住构造函数那一半（buildVoteWidget），钉不住「预处理器真的替换了 /
// 请求真的发了 / 组件真的挂进了正文」—— 这条链路上任何一环断了，页面照样 200、
// 标题照样正确，只有真跑浏览器才看得见。
//
// 【回归的正是这么一断】blog-markdown.ts 里只实现了「结果行」那一支：没有标题、
// 没有投票入口、也没有详情页链接，且最外层少了 .vote-embed-widget（卡片样式全挂在
// 它上面）。原站（vote-embed.js）本是可投的。

import { test, expect } from '@playwright/test';
import { registerFreshUser } from './helpers';

const VOTE_TITLE = 'E2E 嵌入投票';
const OPTIONS = ['选项甲', '选项乙'];

/** 建一个投票 + 一篇正文里嵌了它的博客，返回两者的 ID。 */
async function seedVoteAndBlog(page: import('@playwright/test').Page) {
  const voteRes = await page.request.post('/api/votes', {
    data: { title: VOTE_TITLE, options: OPTIONS },
  });
  expect(voteRes.status(), await voteRes.text()).toBe(200);
  const voteId: string = (await voteRes.json()).data.id;
  // 嵌入靠 ID **长度**识别类型（9 位投票 / 8 位剪贴板 / 10 位图片），长度变了就不处理
  expect(voteId, '投票 ID 应为 9 位，否则 [@id] 不会被识别为投票').toHaveLength(9);

  const blogRes = await page.request.post('/api/blogs', {
    data: {
      title: 'E2E 投票嵌入文章',
      description: '验证正文里的投票箱',
      content: `投票在下面：\n\n[@${voteId}]\n`,
    },
  });
  expect(blogRes.status(), await blogRes.text()).toBe(200);

  return { voteId, blogId: (await blogRes.json()).blog_id as string };
}

// 用一次性用户而不是种子号：创建投票 10/小时、投票 30/小时都是**按用户**计的额度，
// 借种子号会让 desktop / mobile 两轮（以及将来别的用例）互相吃配额。
test.beforeEach(async ({ page }) => {
  await registerFreshUser(page, { core: true });
});

test('博客正文里的投票箱：有标题、能直接投票、能跳详情', async ({ page }) => {
  const { voteId, blogId } = await seedVoteAndBlog(page);

  await page.goto(`/blog/${blogId}`);

  const widget = page.locator('.vote-embed-widget');
  await expect(widget, '正文里没有渲染出投票小组件').toBeVisible();

  // ① 标题
  await expect(widget.locator('.vote-embed-title')).toHaveText(VOTE_TITLE);

  // ② 还没投票 → 可投票态：选项 + 投票按钮（此时不剧透票数）
  await expect(widget.locator('.vote-embed-option')).toHaveCount(OPTIONS.length);
  await expect(widget.locator('.vote-embed-submit')).toBeVisible();
  await expect(widget.locator('.vote-embed-total')).toHaveCount(0);

  // ③ 详情页入口
  await expect(widget.locator('.vote-embed-link')).toHaveAttribute('href', `/vote/${voteId}`);

  // ④ 样式回归的探针：选项是 <button>，必须撑满卡片宽度。
  //    浏览器默认给按钮 inline-block（收缩到文字宽度），不修就会渲染成一枚窄条。
  const cardBox = (await widget.boundingBox())!;
  const optBox = (await widget.locator('.vote-embed-option').first().boundingBox())!;
  expect(
    optBox.width,
    `选项宽度 ${optBox.width} 远小于卡片宽度 ${cardBox.width} —— 按钮没撑满（inline-block 默认）`
  ).toBeGreaterThan(cardBox.width * 0.8);

  // ⑤ 在正文里直接投票
  await widget.locator('.vote-embed-option', { hasText: OPTIONS[0] }).click();
  await widget.locator('.vote-embed-submit').click();

  // 投票后就地变成结果视图：共 1 票 + 自己投的那项高亮 + 投票按钮消失
  await expect(widget.locator('.vote-embed-total')).toHaveText('共 1 票');
  await expect(widget.locator('.vote-embed-option--voted')).toContainText(OPTIONS[0]);
  await expect(widget.locator('.vote-embed-submit')).toHaveCount(0);
  await expect(widget.locator('.vote-embed-link'), '投票后仍应保留详情入口').toBeVisible();

  // 服务端确实记下了这一票（不是本地乐观更新的假象）
  const detail = await (await page.request.get(`/api/votes/${voteId}`)).json();
  expect(detail.data.total_votes).toBe(1);
  expect(detail.data.user_voted).not.toBeNull();
});

test('刷新后仍是结果视图（状态来自服务端，不是本地记的）', async ({ page }) => {
  const { blogId } = await seedVoteAndBlog(page);

  await page.goto(`/blog/${blogId}`);
  const widget = page.locator('.vote-embed-widget');
  await widget.locator('.vote-embed-option').first().click();
  await widget.locator('.vote-embed-submit').click();
  await expect(widget.locator('.vote-embed-total')).toHaveText('共 1 票');

  await page.reload();

  await expect(page.locator('.vote-embed-total')).toHaveText('共 1 票');
  await expect(page.locator('.vote-embed-option--voted')).toBeVisible();
  await expect(page.locator('.vote-embed-submit')).toHaveCount(0);
});

test('已锁定的投票在正文里只出结果，不出投票按钮', async ({ page }) => {
  const { voteId, blogId } = await seedVoteAndBlog(page);

  // 发起者就是当前用户：走详情页的锁定动作（server action 之外的接口没有锁定路由，
  // 这里直接用页面上的按钮，顺带把那条链路也跑到）
  await page.goto(`/vote/${voteId}`);
  page.once('dialog', (d) => d.accept());
  await page.getByRole('button', { name: '锁定投票' }).click();
  // 徽章**只能有一个**：meta 行里那个是原站的口径，组件自己再画一个就成了并排两个
  await expect(page.locator('.vote-embed-badge.badge-locked')).toHaveCount(1);

  await page.goto(`/blog/${blogId}`);
  const widget = page.locator('.vote-embed-widget');
  await expect(widget.locator('.badge-locked')).toHaveText('已锁定');
  await expect(widget.locator('.vote-embed-total')).toHaveText('共 0 票');
  await expect(widget.locator('.vote-embed-submit')).toHaveCount(0);
  await expect(widget.locator('.vote-embed-link')).toBeVisible();
});
