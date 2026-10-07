import { test, expect, type Page } from '@playwright/test';
import { registerFreshUser } from './helpers';

// 「插入引用」资源面板（图床 / 音频 / 剪贴板 / 投票 / 收藏夹）的真跑链路。
//
// 【为什么要 E2E】这一层全是「接口 200、页面上什么都看不出来」的错法：
//   · 读口串错 → 列表永远是空的，看着像「我一个资源都没有」；
//   · 插入语法错一个字符（`[@id]` 的长度分流、`[@音频/<id>]` 的合集名）→
//     正文里留一段方括号原文，谁也不报错；
//   · 解析写松 → 少一列只是副标题空着；
//   · 私有收藏夹被当成可插入 → 得到一个谁的读口都不认的 token。
// 单测（tests/unit/md-editor-resources.test.ts）钉的是**解析与拼串**，钉不到
// 「真接口真返回来之后，预览里到底展开成了什么」—— 那一段只有真浏览器跑得出来。
//
// 【断言正文一律经预览】与 editor.spec / editor-upload.spec 同一条纪律：
// 读 `.md-editor__preview-body` 里的成品渲染，不读 CM6 的 `.cm-content` innerText
//（那是内部结构，换个小版本就可能变）。
//
// 【每个用例都用新号】面板列的是**自己的**五类资源，用种子号会随别的 spec 造过
// 什么而变；新号从零开始，空态与「插一条」都是确定的。顺带避开按用户计的限频桶
//（种子号的桶是两个 project 共用的）。

/** 1x1 透明 PNG。 */
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

/** 只有 ID3v2 头的最小「MP3」—— 服务端只嗅头几个字节（见 audio-upload.ts）。 */
const MP3_MIN = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(64)]);

const TAB_LABELS = ['图床', '音频', '剪贴板', '投票', '收藏夹'] as const;

/** 空列表时那一句 —— 与 src/lib/md-editor/resources.ts 的 spec.empty 同源。 */
const EMPTY_TEXT: Record<(typeof TAB_LABELS)[number], string> = {
  图床: '你还没有上传过图片',
  音频: '你还没有上传过音频',
  剪贴板: '你还没有发布过云剪贴板',
  投票: '你还没有创建过投票',
  收藏夹: '你还没有收藏夹',
};

/** 面板本身（.md-res-modal 是我们的对话框，页面别处不会有）。 */
function panel(page: Page) {
  return page.locator('.md-res-modal');
}

/** 点工具条的「插入引用」并等面板出来。 */
async function openPanel(page: Page, editor: string) {
  await page.locator(editor).getByRole('button', { name: '插入引用', exact: true }).click();
  await expect(panel(page)).toBeVisible();
  return panel(page);
}

async function pickTab(page: Page, label: string) {
  await page.getByRole('tab', { name: label, exact: true }).click();
}

/** 在某一类里挑第 index 条（默认第一条）可插入的条目。 */
async function pickItem(page: Page, index = 0) {
  await page.locator('.md-res-item:not([disabled])').nth(index).click();
  // 插完面板自动收起 —— 留着的话用户会以为还要再点一次
  await expect(panel(page)).toHaveCount(0);
}

async function showPreview(page: Page, editor: string) {
  await page.locator(editor).getByRole('button', { name: '预览', exact: true }).click();
  return page.locator(`${editor} .md-editor__preview-body`);
}

// ── 造数（都走真实接口，借当前会话的 cookie）─────────────────────────────────

async function makeImage(page: Page, filename: string): Promise<string> {
  const res = await page.request.post('/api/images', {
    multipart: { file: { name: filename, mimeType: 'image/png', buffer: PNG_1X1 } },
  });
  const body = await res.json();
  expect(body.code, `上传图片失败：${JSON.stringify(body)}`).toBe(200);
  return body.items[0].id as string;
}

async function makeAudio(page: Page, filename: string): Promise<string> {
  const res = await page.request.post('/api/audio', {
    multipart: { file: { name: filename, mimeType: 'audio/mpeg', buffer: MP3_MIN } },
  });
  const body = await res.json();
  expect(body.code, `上传音频失败：${JSON.stringify(body)}`).toBe(200);
  return body.id as string;
}

async function makeClip(page: Page, title: string, content: string): Promise<string> {
  const res = await page.request.post('/api/clipboard', {
    data: { title, content, publicity: true },
  });
  const body = await res.json();
  expect(body.code, `建剪贴板失败：${JSON.stringify(body)}`).toBe(200);
  return body.id as string;
}

async function makeVote(page: Page, title: string): Promise<string> {
  const res = await page.request.post('/api/votes', {
    data: { title, options: ['甲', '乙'] },
  });
  const body = await res.json();
  expect(body.code, `建投票失败：${JSON.stringify(body)}`).toBe(200);
  return body.data.id as string;
}

/** 建一个收藏夹，返回 { id, publicId }（私有的 publicId 为 null）。 */
async function makeFavorite(
  page: Page,
  title: string,
  isPublic: boolean
): Promise<{ id: number; publicId: string | null }> {
  const res = await page.request.post('/api/favorites', { data: { title, isPublic } });
  const body = await res.json();
  expect(body.code, `建收藏夹失败：${JSON.stringify(body)}`).toBe(200);
  return { id: body.favorite.id, publicId: body.favorite.public_id };
}

test.describe('插入引用面板', () => {
  test('新号的五类都是空态；Esc 关掉面板并把焦点还给编辑区', async ({ page }) => {
    await registerFreshUser(page, { core: true });
    await page.goto('/blog/upload');

    const box = await openPanel(page, '#editor');
    // ⚠️ 第一颗「图床」打开时**已经**是选中态，这一轮是有意再点它一次：点当前标签
    // 必须是无操作。若把它当成一次切换（状态打回 loading 但 kind 没变 → 取数不重跑），
    // 面板会停在「加载中…」—— 用户视角就是「点了一下自己所在的标签，列表没了」。
    for (const label of TAB_LABELS) {
      await pickTab(page, label);
      await expect(box.locator('.md-res-state')).toContainText(EMPTY_TEXT[label]);
      // 空态不是失败：不给「重试」，也不摆出一副出错的样子
      await expect(box.locator('.md-res-retry')).toHaveCount(0);
    }

    // 再切回去一次：从缓存拿结果，且不得卡在加载态
    await pickTab(page, '图床');
    await expect(box.locator('.md-res-state')).toContainText(EMPTY_TEXT['图床']);

    await page.keyboard.press('Escape');
    await expect(panel(page)).toHaveCount(0);

    // 焦点回到编辑区：Esc 之后应当能直接接着打字，不用再点一下正文
    expect(
      await page.evaluate(() => document.activeElement?.classList.contains('cm-content') ?? false),
      '关掉面板后焦点没有回到编辑区'
    ).toBe(true);
  });

  test('五类各插一条：正文得到标准语法，预览里各自展开', async ({ page }) => {
    // 造五类资源 + 插五条，比一条用例的默认 30 秒宽裕些
    test.setTimeout(90_000);

    await registerFreshUser(page, { core: true });
    const tag = Date.now().toString(36);

    const imageName = `面板图-${tag}.png`;
    const audioName = `面板音-${tag}.mp3`;
    const clipTitle = `面板剪贴板-${tag}`;
    const clipBody = `E2E-CLIP-BODY-${tag}`;
    const voteTitle = `面板投票-${tag}`;
    const favTitle = `面板收藏夹-${tag}`;

    await makeImage(page, imageName);
    await makeAudio(page, audioName);
    await makeClip(page, clipTitle, clipBody);
    await makeVote(page, voteTitle);
    await makeFavorite(page, favTitle, true);

    await page.goto('/blog/upload');
    await expect(page.locator('#editor .md-toolbar')).toBeVisible();

    // ① 图床 —— 插的是**标准 Markdown 图片语法**，与上传那条路逐字一致
    await openPanel(page, '#editor');
    await pickTab(page, '图床');
    await expect(page.locator('.md-res-item__title').first()).toHaveText(imageName);
    await pickItem(page);

    // ② 音频 / 剪贴板 / 投票 / 收藏夹 —— 各自具名的 token
    for (const label of ['音频', '剪贴板', '投票', '收藏夹'] as const) {
      await openPanel(page, '#editor');
      await pickTab(page, label);
      await expect(page.locator('.md-res-item:not([disabled])')).toHaveCount(1);
      await pickItem(page);
    }

    // 插入本身不说话（面板直接收起就是回声）；但**报错必须要是零** ——
    // 插入失败时正是这个形状：面板关了、正文里留一段方括号原文。
    await expect(page.locator('#toast-container .toast--error')).toHaveCount(0);

    const preview = await showPreview(page, '#editor');

    // 图：地址走 raw 路由（能显示出来），alt 是服务端回显的文件名
    const img = preview.locator('img[src^="/api/images/"]');
    await expect(img).toHaveCount(1);
    await expect(img).toHaveAttribute('src', /^\/api\/images\/[A-Za-z0-9]{10}\/raw$/);
    await expect(img).toHaveAttribute('alt', imageName);

    // 音频：展开成真播放器（同源字节），不是外链
    const audio = preview.locator('audio.rich-audio-ref');
    await expect(audio).toHaveCount(1);
    await expect(audio).toHaveAttribute('src', /^\/api\/audio\/[A-Za-z0-9]{10}\/raw$/);

    // 剪贴板：展开成它自己的正文
    await expect(preview).toContainText(clipBody);

    // 投票：留下小组件挂载点（票数由渲染后处理自己再拉）
    await expect(preview.locator('.vote-embed')).toHaveCount(1);

    // 收藏夹：成品卡片，标题是收藏夹的标题
    await expect(preview.locator('.favorite-embed__title')).toHaveText(favTitle);

    // ★ 一条 token 都不该以原文留在正文里 ★ —— 展开失败时正是这个形状：
    // 页面照常渲染，只是把方括号原文当普通文字显示出来
    await expect(preview).not.toContainText('[@');
  });

  test('列表加载失败给重试；重试真的重取一次并回到正常态', async ({ page }) => {
    await registerFreshUser(page, { core: true });

    let failImageList = true;
    const imageListGets: string[] = [];
    await page.route('**/api/images', async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      imageListGets.push(route.request().url());
      if (failImageList) return route.fulfill({ status: 500, body: '{"code":500}' });
      return route.continue();
    });

    await page.goto('/blog/upload');
    const box = await openPanel(page, '#editor');

    await expect(box.locator('.md-res-state')).toContainText('加载失败');
    await expect(box.locator('.md-res-retry')).toBeVisible();
    expect(imageListGets).toHaveLength(1);

    // 放行之后点「重试」—— 它必须**再发一次**请求，而不是就地重画一次
    failImageList = false;
    await box.locator('.md-res-retry').click();
    await expect(box.locator('.md-res-state')).toContainText(EMPTY_TEXT['图床']);
    expect(imageListGets, '点了重试却没有重新取数').toHaveLength(2);
  });

  test('会话在编辑途中失效（401）：只显示接口那句原因，不给重试', async ({ page }) => {
    await registerFreshUser(page, { core: true });

    await page.route('**/api/images', async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      return route.fulfill({
        status: 401,
        contentType: 'application/json',
        body: '{"code":401,"message":"请先登录"}',
      });
    });

    await page.goto('/blog/upload');
    const box = await openPanel(page, '#editor');

    const locked = box.locator('.md-res-state--locked');
    await expect(locked).toContainText('请先登录');
    // 「这一档你用不了」与「这次没加载出来」不是一回事 —— 前者重试多少次都一样，
    // 摆一颗按钮只会让人白点
    await expect(box.locator('.md-res-retry')).toHaveCount(0);
    await expect(box).not.toContainText('加载失败');
  });

  test('私有收藏夹列得出来、但插不进去，行内写清理由', async ({ page }) => {
    await registerFreshUser(page, { core: true });
    const tag = Date.now().toString(36);
    const privateTitle = `私有夹-${tag}`;
    const publicTitle = `公开夹-${tag}`;
    await makeFavorite(page, privateTitle, false);
    await makeFavorite(page, publicTitle, true);

    await page.goto('/blog/upload');
    const box = await openPanel(page, '#editor');
    await pickTab(page, '收藏夹');

    const rows = box.locator('.md-res-item');
    await expect(rows).toHaveCount(2);

    // 私有的那条**留着**（藏掉的话用户会以为自己的收藏夹丢了），但点不动
    const priv = rows.filter({ hasText: privateTitle });
    await expect(priv).toBeVisible();
    await expect(priv).toBeDisabled();
    await expect(priv.locator('.md-res-item__sub')).toContainText('没有对外 ID');

    const pub = rows.filter({ hasText: publicTitle });
    await expect(pub).toBeEnabled();
  });

  test('代码块里的 token 不展开 —— 别在代码示例里嵌出真播放器/真卡片', async ({ page }) => {
    await registerFreshUser(page, { core: true });

    await page.goto('/blog/upload');
    await page.locator('#editor .cm-content').click();

    // 逐行敲（键位表里没有 markdown 的自动续行，敲 ` ``` ` 不会被自动补一个闭合围栏）
    for (const line of [
      '```text',
      '[@abcdefgh]',
      '[@音频/abcdefghij]',
      '[@123456]',
      '```',
      '',
      '围栏外：[@abcdefgh]',
    ]) {
      await page.keyboard.type(line);
      await page.keyboard.press('Enter');
    }

    const preview = await showPreview(page, '#editor');
    const code = preview.locator('pre code');

    // 围栏里的三条原样留着
    await expect(code).toContainText('[@abcdefgh]');
    await expect(code).toContainText('[@音频/abcdefghij]');
    await expect(code).toContainText('[@123456]');
    // 且没有展开成任何东西
    await expect(preview.locator('audio')).toHaveCount(0);
    await expect(preview.locator('.favorite-embed')).toHaveCount(0);
  });

  test('窄屏：对话框不溢出视口，五类标签都在、都能切', async ({ page, isMobile }) => {
    await registerFreshUser(page, { core: true });
    await page.goto('/clipboard/upload');

    const box = await openPanel(page, '#clipboard-editor');

    const dialog = await box.boundingBox();
    const viewport = page.viewportSize();
    expect(dialog, '面板没有盒子').not.toBeNull();
    expect(viewport).not.toBeNull();
    // 面板比视口宽的话，右侧的条目与关闭钮就点不到了（而它是模态的，退无可退）
    expect(dialog!.x).toBeGreaterThanOrEqual(0);
    expect(dialog!.x + dialog!.width).toBeLessThanOrEqual(viewport!.width);
    expect(dialog!.y + dialog!.height).toBeLessThanOrEqual(viewport!.height);

    for (const label of TAB_LABELS) {
      const tab = page.getByRole('tab', { name: label, exact: true });
      await expect(tab, `窄屏上「${label}」标签不见了`).toBeVisible();
      await tab.click();
      await expect(box.locator('.md-res-state')).toContainText(EMPTY_TEXT[label]);
    }

    // 搜索框与刷新钮同样要在对话框里（窄屏最容易被挤出去的就是这一行）
    await expect(box.locator('.md-res-search input')).toBeVisible();
    await expect(box.locator('.md-res-refresh')).toBeVisible();

    if (isMobile) {
      // 触屏没有 hover 可依赖：按钮必须真的可点（这里用一个必然存在的关闭钮验）
      await expect(box.getByRole('button', { name: '关闭' })).toBeVisible();
    }
  });
});
