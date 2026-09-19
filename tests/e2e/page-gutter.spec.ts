// 页面檐沟端到端 —— 「抬头与首屏内容不许贴到屏幕边」
//
// 【为什么必须走 e2e】断言的是「元素的左边缘离视口左边缘有多少像素」——那是**真实
// 排版**的结果：元素自己的内边距、祖先容器（.container / .content-wrapper /
// .admin-container）的檐沟、以及两者叠加与否，都得让浏览器算一遍。读样式表只能看出
// 「这一条写没写」，看不出「这一页到底有没有被谁兜住」。
//
// 【为什么要盯着这件事】全站页边距归容器（见 docs/frontend-styles.md §5），而
// **整幅有底色的抬头带**（.story-hero / .admin-hero / .upload-hero）是唯一会漏的
// 地方：它们是铺满视口的色带，不能自己吃宽度阶梯（那会把色带一起掐断），于是内容
// 必须由页面再套一层 .container —— 漏掉时窄屏下标题与简介左右顶到屏幕边。而这件事
// **不报错、不警告、构建与单测都拦不住**，只有肉眼（或这条用例）看得出来。
//
// 2026-09-19 一次补了四处：故事区 / 后台七页 / 文章编辑器（标题 + 表单卡片）/
// 签到页两张卡片的檐沟；同一天又收了故事阅读页与互动小说页（檐沟原为写死的 20px）。
// 这几页此后由本文件盯着。
//
// 故事两页的素材由 global-setup 的 seedStories() 造、STORIES_DIR 指到 tests/.tmp ——
// 不这么兜住的话，故事页读的是站长自己的 instance/stories，用例会随机器时通时不通。
//
// 【本文件登记在 RESPONSIVE_SPECS 里】它验的就是窄屏排版，两个 project 都要跑；
// 视口在文件内显式钉死，不跟着 project 的 device 走。

import { test, expect } from '@playwright/test';
import { loginViaApi } from './helpers';
import { E2E_STORIES, SEED_USERS } from './seed';

/** 全站檐沟 = `.container` 的 container-padding。 */
const SITE_GUTTER = 16;

/**
 * 每页要量的元素（选择器取不到就判失败 —— 页面换结构时这条用例必须响）。
 *
 * `gutter` 是这一页的**期望值**，默认 16；只有 `/admin` 那一档是 20
 * （`.admin-container` 的值，抬头与它下面的内容列对齐）。
 * ⚠️ 断言的是**等于**而不是「不小于」：「这页 20px、别处 16px」正是本次要收掉的
 * 那类 4px 漂移（故事阅读页原样就是这么飘着的），用 ≥ 会把 4px 放过。
 */
const PAGES: { url: string; targets: string[]; gutter?: number }[] = [
  // 匿名也能进的
  { url: '/story', targets: ['main h1', '.story-hero p'] },
  {
    url: `/story/${E2E_STORIES.collection}`,
    targets: ['main h1', '.story-hero p'],
  },
  // 阅读页与互动小说页各自是一层 max-width 列（820 / 720），檐沟归 container-padding
  {
    url: `/story/${E2E_STORIES.collection}/${E2E_STORIES.markdown}`,
    targets: ['.story-reader__header h1', '.story-reader__content'],
  },
  {
    url: `/story/${E2E_STORIES.collection}/${E2E_STORIES.cattca}`,
    targets: ['.story-cattca__header h2', '.story-cattca__game'],
  },
  { url: '/explore', targets: ['main h1'] },
  { url: '/tool', targets: ['main h1'] },
  // 以下要 core+ / 管理员（登录用种子账号 e2e_admin）
  { url: '/admin', targets: ['main h1', '.admin-hero p'], gutter: 20 },
  { url: '/blog/upload', targets: ['main h1', '.blog-form-container'] },
  { url: '/checkin', targets: ['.checkin-card'] },
];

// 窄屏才看得出来：宽屏下这些元素本来就在居中的列里，即便没有檐沟也离屏幕边很远。
test.use({ viewport: { width: 390, height: 844 } });

test('抬头与首屏内容在窄屏左右都有檐沟（不贴屏幕边）', async ({ page }) => {
  await loginViaApi(page, SEED_USERS.admin.username);

  const bad: string[] = [];
  for (const { url, targets, gutter = SITE_GUTTER } of PAGES) {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    for (const sel of targets) {
      const el = page.locator(sel).first();
      try {
        await el.waitFor({ state: 'visible', timeout: 10_000 });
      } catch {
        bad.push(`${url} ${sel}：没渲染出来（页面结构变了？）`);
        continue;
      }
      const box = await el.boundingBox();
      if (!box) {
        bad.push(`${url} ${sel}：量不到位置`);
        continue;
      }
      // 亚像素容差：0.02rem 这类值在不同缩放比下会算出 15.99 之类的数
      const left = box.x;
      const right = page.viewportSize()!.width - (box.x + box.width);
      const off = (v: number) => Math.abs(v - gutter) > 0.5;
      if (off(left) || off(right)) {
        bad.push(
          `${url} ${sel}：left=${left.toFixed(1)} right=${right.toFixed(1)}（应各为 ${gutter}）`
        );
      }
    }
  }

  expect(
    bad,
    '檐沟对不上 —— 全站页边距归容器：抬头带里的内容要自己套一层 .container，' +
      '阅读列只收行宽（max-width）不另定檐沟；/admin 那一档与 .admin-container 同值'
  ).toEqual([]);
});
