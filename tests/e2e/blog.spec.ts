// 博客列表页与详情页的渲染。
//
// 【为什么详情页非 E2E 不可】正文是**客户端**渲染的（MarkdownRenderer = marked +
// DOMPurify + highlight.js，见 src/app/components/MarkdownRenderer.tsx）。
// 服务端只吐一个空壳 + 原始 Markdown，页面 200 且标题正确，但正文可能一个字都没渲染出来
// —— 只要 marked 加载失败、hydration 报错、或 DOMPurify 把内容清空了。
// 断言 HTTP 状态或服务端 HTML 都发现不了；必须真跑浏览器、等脚本执行完再看 DOM。

import { test, expect, type Page } from '@playwright/test';
import { SEED_USERS, SEED_BLOG, SEED_BLOG2, SEED_CATEGORY, BLOG_BODY_MARKER } from './seed';
import { loginViaApi, registerFreshUser } from './helpers';

/**
 * 两篇文章卡的相对顺序（按卡片在页面里的纵向位置）。
 * 按 id 定位而非枚举整列标题 —— 别的 spec 若在库里留下额外博客，整列断言会脆断，这个不会。
 * @returns 'ab' 表示 firstId 在 secondId 上面，'ba' 反之
 */
async function cardOrder(page: Page, firstId: string, secondId: string): Promise<'ab' | 'ba'> {
  const pos = await page.evaluate(
    ([a, b]) => {
      const top = (id: string) =>
        document.getElementById(`id${id}`)?.getBoundingClientRect().top ?? Infinity;
      return { a: top(a), b: top(b) };
    },
    [firstId, secondId]
  );
  return pos.a < pos.b ? 'ab' : 'ba';
}

// 列表/详情都在 requireCoreUser 之后，故每个用例先以 core 身份登录
test.beforeEach(async ({ page }) => {
  await loginViaApi(page, SEED_USERS.core.username);
});

test('博客列表页渲染文章卡片与栏目侧栏', async ({ page }) => {
  const res = await page.goto('/blog');
  expect(res?.status()).toBe(200);

  const card = page.locator(`#id${SEED_BLOG.id}`);
  await expect(card).toBeVisible();
  await expect(card.locator('.blog-title')).toHaveText(SEED_BLOG.title);
  await expect(card.locator('.blog-description')).toHaveText(SEED_BLOG.description);
  // 作者名来自 listBlogs 的关联查询 —— 关联断了这里会空，而卡片本身照常显示
  await expect(card.locator('.blog-author span').first()).toHaveText(SEED_USERS.core.username);

  // 侧栏分类（seed 的栏目 excludeFromAll=false，应当出现）
  await expect(page.locator('.blog-layout')).toContainText(SEED_CATEGORY.name);
});

test('按栏目筛选命中种子文章', async ({ page }) => {
  await page.goto(`/blog?category=${SEED_CATEGORY.slug}`);
  await expect(page.locator(`#id${SEED_BLOG.id}`)).toBeVisible();
});

test('搜索不匹配时列表为空（防「筛选条件被忽略」这类静默失效）', async ({ page }) => {
  await page.goto('/blog?search=绝不存在的关键词zzzqqq');
  await expect(page.locator(`#id${SEED_BLOG.id}`)).toHaveCount(0);
});

test('博客详情页把 Markdown 正文渲染成 HTML', async ({ page }) => {
  const res = await page.goto(`/blog/${SEED_BLOG.id}`);
  expect(res?.status()).toBe(200);

  // 服务端直出的部分
  await expect(page.locator('.read-hero h1')).toHaveText(SEED_BLOG.title);

  // 客户端渲染的部分：哨兵串出现 = marked 真的跑完了
  await expect(page.getByText(BLOG_BODY_MARKER)).toBeVisible({ timeout: 10_000 });

  // 断言 Markdown 结构真被转成了 HTML，而不是把源码当纯文本吐出来。
  // 只断言哨兵串是不够的 —— 渲染彻底失效、原样 innerText 输出时它照样在。
  await expect(page.locator('h1', { hasText: 'E2E 标题' })).toBeVisible();
  await expect(page.locator('li', { hasText: '列表项一' })).toBeVisible();
});

test('不存在的文章 ID 返回 404', async ({ page }) => {
  const res = await page.goto('/blog/definitely-not-a-real-blog-id');
  expect(res?.status()).toBe(404);
});

test('博客详情页里的数学公式被 MathJax 渲染', async ({ page }) => {
  await page.goto(`/blog/${SEED_BLOG.id}`);
  // CHTML 输出会以 <mjx-container jax="CHTML"> 包裹每个公式。
  await expect(page.locator('mjx-container[jax="CHTML"]').first()).toBeVisible({ timeout: 15_000 });

  // 跨行块级公式必须是 display 模式（历史 bug：$$ 被替换串语义吞成 $，
  // 跨行时连 MathJax 都不会启动，公式以原始文本显示）。
  await expect(page.locator('mjx-container[jax="CHTML"][display="true"]').first()).toBeVisible({
    timeout: 15_000,
  });
  // 公式里的 `<` 必须完整：未转义会被 HTML 解析器当成标签起始、公式只剩半截，
  // 残句喂给 MathJax 必然报错。CSS 生成的字形不在 textContent 里，所以按
  // MathJax 的错误节点断言（截断 → mjx-merror），而不是比对文字。
  await expect(page.locator('mjx-merror')).toHaveCount(0);

  // CHTML 的 @font-face 必须指向同源静态目录：默认的相对路径在 /blog/xxx 下
  // 会解析成 /blog/js/… 而 404，公式只能用回退字体渲染。
  // 用 textContent 取值：<style> 在 head 里不参与渲染，toContainText 走
  // innerText 会拿到空串。
  await expect
    .poll(() => page.locator('#MJX-CHTML-styles').textContent(), { timeout: 15_000 })
    .toContain('/static/mathjax/woff-v2/');
});

// ── 排序（发布时间 / 更新时间）+ 前端记忆 ──────────────────────────────────────
// 种子时间刻意错位：按发布时间 → [SEED_BLOG, SEED_BLOG2]；按更新时间 → 正好相反。

test('排序切换：默认按发布时间，切更新时间后 URL/记忆/顺序同步变化', async ({ page }) => {
  await page.goto('/blog');
  const c1 = page.locator(`#id${SEED_BLOG.id}`);
  const c2 = page.locator(`#id${SEED_BLOG2.id}`);
  await expect(c1).toBeVisible();
  await expect(c2).toBeVisible();

  // 默认（URL 无 sort）：发布新的 SEED_BLOG 在前
  expect(await cardOrder(page, SEED_BLOG.id, SEED_BLOG2.id)).toBe('ab');

  // 切「更新时间」→ URL 带 sort=updated、顺序翻转、localStorage 已记住
  await page.getByRole('button', { name: '更新时间' }).click();
  await expect(page).toHaveURL(/sort=updated/, { timeout: 10_000 });
  await expect(c2).toBeVisible();
  expect(await cardOrder(page, SEED_BLOG.id, SEED_BLOG2.id)).toBe('ba');
  expect(await page.evaluate(() => localStorage.getItem('blog.sort'))).toBe('updated');

  // reload 后保持（URL 参数驱动，服务端直出就是 updated 序）
  await page.reload();
  await expect(c2).toBeVisible();
  expect(await cardOrder(page, SEED_BLOG.id, SEED_BLOG2.id)).toBe('ba');

  // 切回「发布时间」→ sort 参数移除（默认态无参）、回到默认序、记忆同步为 created
  await page.getByRole('button', { name: '发布时间' }).click();
  await expect(page).not.toHaveURL(/sort=/, { timeout: 10_000 });
  await expect(c1).toBeVisible();
  expect(await cardOrder(page, SEED_BLOG.id, SEED_BLOG2.id)).toBe('ab');
  expect(await page.evaluate(() => localStorage.getItem('blog.sort'))).toBe('created');
});

test('记忆恢复：localStorage 偏好 updated 且无 cookie 时，补建 cookie 并补 sort=updated', async ({ page }) => {
  // 模拟「上次选了更新时间」的旧访客（存量只可能在 LS —— cookie 镜像此前不存在）：
  // 页面任何脚本执行前 LS 已就位
  await page.addInitScript(() => localStorage.setItem('blog.sort', 'updated'));
  await page.goto('/blog');

  // 迁移 effect：LS=updated + 无 cookie → 补建 cookie 镜像并 replace 补参数 → 服务端按 updated 直出
  await expect(page).toHaveURL(/sort=updated/, { timeout: 10_000 });
  const c2 = page.locator(`#id${SEED_BLOG2.id}`);
  await expect(c2).toBeVisible();
  expect(await cardOrder(page, SEED_BLOG.id, SEED_BLOG2.id)).toBe('ba');

  // 迁移已把偏好沉淀进 cookie：下次无参首访不再依赖客户端补参（SSR 直出）
  expect(
    (await page.context().cookies()).some((c) => c.name === 'blog_sort' && c.value === 'updated')
  ).toBe(true);
});

test('cookie 稳态：无参 /blog 首屏直出 updated 序、不 replace；点回发布时间删 cookie', async ({ page }) => {
  // 模拟「cookie 镜像已就位」的回头客（首屏就该是 updated 序，不允许先 created 后翻转）。
  // 先加载一帧拿到 origin 再补种 cookie（context 与页面共用 cookie jar），随后 reload。
  await page.goto('/blog');
  const origin = new URL(page.url()).origin;
  await page.context().addCookies([{ name: 'blog_sort', value: 'updated', url: origin }]);
  await page.reload();

  // SSR 直出 updated 序，URL 保持无 sort（不触发 replace 补参）
  const c2 = page.locator(`#id${SEED_BLOG2.id}`);
  await expect(c2).toBeVisible();
  expect(await cardOrder(page, SEED_BLOG.id, SEED_BLOG2.id)).toBe('ba');
  await page.waitForTimeout(600); // 给「不该发生的 replace」留出窗口
  expect(new URL(page.url()).searchParams.has('sort')).toBe(false);
  expect(await cardOrder(page, SEED_BLOG.id, SEED_BLOG2.id)).toBe('ba');

  // 稳态无参页上点「发布时间」：cookie 已删、URL 仍无参 → 走 router.refresh 由服务端重出 created 序
  await page.getByRole('button', { name: '发布时间' }).click();
  await expect
    .poll(async () => cardOrder(page, SEED_BLOG.id, SEED_BLOG2.id))
    .toBe('ab');
  expect(new URL(page.url()).searchParams.has('sort')).toBe(false);
  expect(
    (await page.context().cookies()).some((c) => c.name === 'blog_sort' && c.value === 'updated')
  ).toBe(false);
  expect(await page.evaluate(() => localStorage.getItem('blog.sort'))).toBe('created');
});

test('排序回显：updated 态下点侧栏分类，URL 保留 sort（不用二次跳转找回）', async ({ page }) => {
  await page.goto(`/blog?sort=updated`);
  await expect(page.locator(`#id${SEED_BLOG2.id}`)).toBeVisible();

  // 移动端（≤768px）侧栏分类默认折叠 —— 折叠时先点标题展开
  const catLink = page.getByRole('link', { name: SEED_CATEGORY.name, exact: true });
  if (!(await catLink.isVisible())) {
    await page.locator('.sidebar-title').click();
  }
  await catLink.click();
  await expect(page).toHaveURL(new RegExp(`category=${SEED_CATEGORY.slug}`));
  await expect(page).toHaveURL(/sort=updated/);

  // 分类下两篇都在，且仍按更新时间排
  await expect(page.locator(`#id${SEED_BLOG.id}`)).toBeVisible();
  expect(await cardOrder(page, SEED_BLOG.id, SEED_BLOG2.id)).toBe('ba');
});

// ── 详情页底部交互区：两行按钮 + 「管理文章」弹窗收拢 ───────────────────────
// 旧版把 点赞/投喂/返回 与 查看点赞者/查看投喂者/编辑/删除 平铺成两排共 6~7 个按钮；
// 现改为 4 个按钮两行（点赞/投喂｜返回上页/管理文章），管理类操作收进弹窗。
// 用例分别覆盖：作者（core 即 SEED_BLOG 作者）、管理员（非作者）、第三方核心用户。

test('详情页交互区：点赞/投喂一行、返回/管理一行（作者视角 2×2）', async ({ page }) => {
  await page.goto(`/blog/${SEED_BLOG.id}`);
  const controls = page.locator('#read-controls');
  await expect(controls).toBeVisible();

  const rows = controls.locator('.read-controls__row');
  await expect(rows).toHaveCount(2);

  // 第一行：点赞 + 投喂（标签后带计数徽标，用前缀匹配）
  const row0 = rows.nth(0);
  await expect(row0.getByRole('button', { name: /点赞/ })).toBeVisible();
  await expect(row0.getByRole('button', { name: /投喂/ })).toBeVisible();
  await expect(row0.getByRole('button')).toHaveCount(2);

  // 第二行：返回上页 + 管理文章；旧的管理按钮不再平铺在页面上
  const row1 = rows.nth(1);
  await expect(row1.getByRole('button', { name: '返回上页' })).toBeVisible();
  await expect(row1.getByRole('button', { name: '管理文章' })).toBeVisible();
  await expect(row1.getByRole('button')).toHaveCount(2);
  await expect(page.getByRole('button', { name: '查看点赞者' })).not.toBeVisible();
});

test('「管理文章」弹窗：作者四入口齐备，子视图（点赞者/删除）可切换流转', async ({ page }) => {
  await page.goto(`/blog/${SEED_BLOG.id}`);

  // 点「管理文章」打开目录
  await page.locator('#admin-manage-btn').click();
  const menu = page.locator('#manageMenuModal.is-open');
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('button', { name: '查看点赞者' })).toBeVisible();
  await expect(menu.getByRole('button', { name: '查看投喂者' })).toBeVisible();
  await expect(menu.getByRole('link', { name: '编辑文章' })).toBeVisible();
  await expect(menu.getByRole('button', { name: '删除文章' })).toBeVisible();

  // 查看点赞者 → 切到点赞者列表子视图（目录随之收起）
  await menu.getByRole('button', { name: '查看点赞者' }).click();
  await expect(page.locator('#likersModal.is-open')).toBeVisible();
  await expect(page.locator('#likersModal .modal-title')).toContainText('点赞者列表');
  await expect(page.locator('#manageMenuModal')).not.toHaveClass(/is-open/);

  // 关闭子视图 → 弹窗整体收起
  await page.locator('#likersModal .btn-close').click();
  await expect(page.locator('#likersModal')).not.toHaveClass(/is-open/);

  // 删除确认：取消回到「管理文章」目录（而非直接收起）
  await page.locator('#admin-manage-btn').click();
  await page
    .locator('#manageMenuModal.is-open')
    .getByRole('button', { name: '删除文章' })
    .click();
  await expect(page.locator('#deleteConfirmModal.is-open')).toBeVisible();
  await page.locator('#deleteConfirmModal').getByRole('button', { name: '取消' }).click();
  await expect(page.locator('#manageMenuModal.is-open')).toBeVisible();
});

test('管理员视角：管理弹窗无「编辑文章」入口（非作者）', async ({ page }) => {
  await loginViaApi(page, SEED_USERS.admin.username);
  await page.goto(`/blog/${SEED_BLOG.id}`);

  await page.locator('#admin-manage-btn').click();
  const menu = page.locator('#manageMenuModal.is-open');
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('button', { name: '查看点赞者' })).toBeVisible();
  await expect(menu.getByRole('button', { name: '查看投喂者' })).toBeVisible();
  await expect(menu.getByRole('link', { name: '编辑文章' })).toHaveCount(0);
  await expect(menu.getByRole('button', { name: '删除文章' })).toBeVisible();
});

test('第三方核心用户视角：无「管理文章」，第二行只有返回上页', async ({ page }) => {
  // 注册一个非作者、非管理员的核心用户 —— 站在纯读者视角验证布局降级
  await registerFreshUser(page, { core: true });
  await page.goto(`/blog/${SEED_BLOG.id}`);

  const rows = page.locator('#read-controls .read-controls__row');
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0).getByRole('button', { name: /点赞/ })).toBeVisible();
  await expect(rows.nth(0).getByRole('button', { name: /投喂/ })).toBeVisible();

  // 第二行只剩「返回上页」，没有管理入口、也没有管理弹窗
  await expect(rows.nth(1).getByRole('button', { name: '返回上页' })).toBeVisible();
  await expect(rows.nth(1).getByRole('button')).toHaveCount(1);
  await expect(page.locator('#admin-manage-btn')).toHaveCount(0);
  await expect(page.locator('#manageMenuModal')).toHaveCount(0);
});
