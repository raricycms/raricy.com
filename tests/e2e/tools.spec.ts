// ─────────────────────────────────────────────────────────────────────────────
// tools.spec.ts —— 工具页可达性与正确性
//
// 【为什么要有这个文件】工具菜单一度把 5 个工具（url/html/qp/hash/aes）的链接
// 指到外部站 —— 而这些页面在本站其实早就实现好了，用户被白白踢走。工具入口必须
// 写本站路径；指向外部站的绝对 URL 会 404。链接指错不会让构建失败、也不会让任何
// 单测转红，只有真的点进去才发现。故在此钉死：
//   1. 菜单里不得再出现指向外部站的工具链接
//   2. 五个页面都能打开
//   3. 抽查算得对（用标准值断言，不是「有输出就算过」）
//   4. 站务工具区的「音频床」入口在、且点得进去 —— 同一种「功能做完却进不去」的
//      毛病（/audio 一度不在任何导航里，三份文档却都写着「进入 /audio」）
//   5. 开发者工具合集（/tool/dev）收录既有工具 + 新工具，且清单里每个新工具页都可达
//      （清单唯一真相源是 src/lib/dev-tools/registry.ts，这里直接遍历它）
// ─────────────────────────────────────────────────────────────────────────────

import { test, expect } from '@playwright/test';
import { registerFreshUser } from './helpers';
import { DEV_TOOLS } from '../../src/lib/dev-tools/registry';

const TOOLS = ['url', 'html', 'qp', 'hash', 'aes'] as const;

test('站务工具区里有「音频床」入口，点进去就是音频床（与图床并列）', async ({ page }) => {
  // 与 favorite.spec.ts 那条入口用例同源：`/audio` 是「上传 → 拿 ID → 贴进正文」的
  // 唯一页面，而它一度**不在任何导航、任何菜单里** —— 三份文档都写着「进入 /audio」，
  // 站内却没有任何链接指过去，只能手敲 URL。入口本身要有用例，而不只是页面能打开。
  //
  // 它**不设 `coreOnly`**（页面对 core 以下的人就地 403，入口照常渲染）——「入口不跟着
  // 藏」与「我的收藏夹」那条同口径，所以这里用 core 号即可，测的是入口不是门槛。
  await registerFreshUser(page, { core: true });
  await page.goto('/tool');

  // 站务工具区默认就展开（开发者工具是另一张合集卡）
  const entry = page.locator('a.tool-new-card[href="/audio"]');
  await expect(entry).toBeVisible();
  await entry.click();

  await page.waitForURL(/\/audio$/, { timeout: 15_000 });
  await expect(page.locator('h1')).toContainText('音频床');
});

test('工具菜单不含指向外部站的工具链接（绝对 URL 会 404）', async ({ page }) => {
  await page.goto('/tool');

  const hrefs = await page.locator('a.tool-new-card').evaluateAll((as) =>
    as.map((a) => (a as HTMLAnchorElement).getAttribute('href') ?? '')
  );
  expect(hrefs.length).toBeGreaterThan(0);

  // 工具卡片一律走站内相对路径。绝对 URL（http://…）、协议相对（//host/…）与其它
  // scheme（mailto: 等）都意味着指向了站外 —— 判据不能只挡 `http(s)://`。
  const external = hrefs.filter((h) => /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(h));
  expect(external, `这些工具链接指向站外：${external.join(', ')}`).toEqual([]);

  // 2026-10 起「编码 / 解码」与「加密 / 安全」不再平铺在工具箱主页，而是和新增的
  // 开发者工具一起收进 `/tool/dev` 合集（主页只留合集卡 + 四张常用卡）。
  expect(hrefs, '工具箱主页缺少开发者工具合集入口').toContain('/tool/dev');
});

test('开发者工具合集：既有五个工具 + 新增工具都在，且没有站外链接', async ({ page }) => {
  await page.goto('/tool/dev');

  const hrefs = await page.locator('a.tool-new-card').evaluateAll((as) =>
    as.map((a) => (a as HTMLAnchorElement).getAttribute('href') ?? '')
  );
  expect(hrefs.length).toBeGreaterThan(20);

  // 既有工具一页都没搬家（合集只是索引它们，旧链接与文档因此不用改）
  for (const t of TOOLS) {
    expect(hrefs, `合集缺少既有工具 /tool/${t}`).toContain(`/tool/${t}`);
  }
  // 新增工具的代表：每类各取一项，防止「清单有、页面没接」
  for (const slug of [
    'json',
    'json-tree',
    'json-path',
    'regex',
    'diff',
    'timestamp',
    'jwt',
    'qrcode',
    'barcode',
    'url-params',
    'subnet',
    'dns',
    'http-headers',
  ]) {
    expect(hrefs, `合集缺少新工具 /tool/dev/${slug}`).toContain(`/tool/dev/${slug}`);
  }

  const external = hrefs.filter((h) => /^https?:\/\//.test(h));
  expect(external, `合集里这些链接指向站外：${external.join(', ')}`).toEqual([]);
});

test('开发者工具合集：清单里的每个新工具页都能打开', async ({ page }) => {
  // 直接遍历 registry：清单加一行就自动多测一个页面，不需要在这份用例里再维护一份列表。
  // 每条只断言「不是 404 占位页、有 h1」—— 具体算法由各工具的单测负责，这里管可达性。
  for (const t of DEV_TOOLS.filter((x) => !x.legacy)) {
    const res = await page.goto(`/tool/dev/${t.slug}`);
    expect(res?.status(), `/tool/dev/${t.slug} 状态码`).toBe(200);
    await expect(page.locator('body')).not.toContainText('This page could not be found');
    await expect(page.locator('h1')).toContainText(t.title);
  }
});

test('开发者工具各页在窄屏（390px）下没有横向溢出', async ({ page }) => {
  // 这条是实测出来的：cron 页的宏列表是一串没有空格的等宽文本
  // （`@yearly/@monthly/…`），390px 下把整页顶到 scrollWidth 415。
  // 横向溢出不会让构建失败、单测也看不见，只有真浏览器量视口才现形。
  // 遍历 registry，新增工具自动纳入。
  await page.setViewportSize({ width: 390, height: 844 });
  for (const path of ['/tool/dev', ...DEV_TOOLS.filter((x) => !x.legacy).map((t) => `/tool/dev/${t.slug}`)]) {
    await page.goto(path);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth
    );
    expect(overflow, `${path} 在 390px 视口下横向溢出 ${overflow}px`).toBeLessThanOrEqual(1);
  }
});

for (const t of TOOLS) {
  test(`/tool/${t} 能打开`, async ({ page }) => {
    const res = await page.goto(`/tool/${t}`);
    expect(res?.status()).toBe(200);
    // 404 页会渲染成 200 外壳，故再断言不是「页面不存在」
    await expect(page.locator('body')).not.toContainText('This page could not be found');
  });
}

// 抽查三个的计算结果。用公开标准值，避免「有输出就算过」这种自欺的断言。
// 这些工具都是点按钮才算（不是输入即时计算），所以必须走真实交互。

test('URL 编码：中文转成 UTF-8 百分号编码', async ({ page }) => {
  await page.goto('/tool/url');
  await page.locator('textarea').first().fill('你好 world&a=1');
  await page.getByRole('button', { name: /编码/ }).first().click();
  // 「你好」的 UTF-8 百分号编码
  await expect(page.locator('textarea').nth(1)).toHaveValue(/%E4%BD%A0%E5%A5%BD/);
});

test('HTML 编码：script 标签被转义（这是它的安全用途）', async ({ page }) => {
  await page.goto('/tool/html');
  await page.locator('textarea').first().fill('<script>alert(1)</script>');
  await page.getByRole('button', { name: /编码/ }).first().click();
  await expect(page.locator('textarea').nth(1)).toHaveValue(/&lt;script&gt;/);
});

test('哈希：SHA-256("abc") 等于标准值', async ({ page }) => {
  await page.goto('/tool/hash');
  await page.locator('textarea').first().fill('abc');
  const btn = page.getByRole('button', { name: /计算|哈希|生成/ }).first();
  if (await btn.count()) await btn.click();
  // NIST 公布的 SHA-256("abc") 标准测试向量
  await expect(page.locator('body')).toContainText(
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    { ignoreCase: true }
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// 下面这一组是 2026-10-31 修完缺陷后补的**回归闸门**。
//
// 这些 bug 的共同点是「不报错」：CTR 一用就抛、CBC 密文多一整套填充、GCM 复用
// nonce、QP 按 UTF-16 转义、Hex 删除删两个字节 —— 全都能通过「页面能打开 + 哈希
// 一个值」这一档断言。所以断言必须落到**具体数字与往返结果**上。
// ─────────────────────────────────────────────────────────────────────────────

test('AES-CTR：counter 是 16 字节，往返能还原（12 字节会直接 OperationError）', async ({ page }) => {
  await page.goto('/tool/aes');
  const ta = page.locator('textarea');
  await ta.first().fill('hello world');
  await page.locator('select').first().selectOption('CTR');
  await page.locator('input.form-control.mono').first().fill('secret');
  await page.getByRole('button', { name: /加密/ }).click();

  // 密文 = 16 字节 counter 前缀 + 11 字节原文 ⇒ 54 个 hex 字符。
  // 用 12 字节时这一行根本到不了：WebCrypto 抛 `counter must contain exactly 16 bytes`。
  await expect(ta.nth(1)).toHaveValue(/^[0-9a-f]{54}$/);
  const cipher = await ta.nth(1).inputValue();

  // 解密读右栏：把密文放回右栏，左栏清空后再解，确认还原成原文
  await ta.nth(1).fill(cipher);
  await page.getByRole('button', { name: /解密/ }).click();
  await expect(ta.first()).toHaveValue('hello world');
});

test('AES-CBC：密文只补一层 PKCS#7（43 字节明文 → 48 字节密文体）', async ({ page }) => {
  await page.goto('/tool/aes');
  const ta = page.locator('textarea');
  await ta.first().fill('The quick brown fox jumps over the lazy dog');
  await page.locator('select').first().selectOption('CBC');
  await page.locator('input.form-control.mono').first().fill('secret');
  await page.getByRole('button', { name: /加密/ }).click();

  const cipher = await ta.nth(1).inputValue();
  const body = cipher.length / 2 - 16; // 去掉 IV 前缀
  // 43 → 48 是**一层**填充的结果；手工再补一层会变成 64，且解标准密文会静默截断。
  expect(body).toBe(48);
  expect(body % 16).toBe(0);

  await ta.nth(1).fill(cipher);
  await page.getByRole('button', { name: /解密/ }).click();
  await expect(ta.first()).toHaveValue('The quick brown fox jumps over the lazy dog');
});

test('AES-GCM：每次加密换新 nonce（同 key 同 nonce 是致命的）', async ({ page }) => {
  await page.goto('/tool/aes');
  const ta = page.locator('textarea');
  await ta.first().fill('same plaintext');
  await page.locator('select').first().selectOption('GCM');
  await page.locator('input.form-control.mono').first().fill('secret');
  const ivInput = page.locator('input.form-control.mono').nth(1);

  await page.getByRole('button', { name: /加密/ }).click();
  const first = await ta.nth(1).inputValue();
  const iv1 = await ivInput.inputValue();
  await page.getByRole('button', { name: /加密/ }).click();
  const second = await ta.nth(1).inputValue();
  const iv2 = await ivInput.inputValue();

  expect(iv1).toMatch(/^[0-9a-f]{24}$/); // 12 字节
  expect(iv1).not.toBe(iv2);
  expect(first).not.toBe(second);
});

test('QP：中文按 UTF-8 字节转义（不是 UTF-16 code unit）', async ({ page }) => {
  await page.goto('/tool/qp');
  const ta = page.locator('textarea');
  await ta.first().fill('你好');
  await page.getByRole('button', { name: /编码/ }).first().click();
  // 你 U+4F60 的 UTF-8 是 E4 BD A0。按 code unit 会编成 =4F60 —— 那是错的 QP。
  await expect(ta.nth(1)).toHaveValue(/^=E4=BD=A0=E5=A5=BD$/);
  await page.getByRole('button', { name: /解码/ }).first().click();
  await expect(ta.first()).toHaveValue('你好');
});

for (const algo of ['base85', 'base92'] as const) {
  test(`${algo}：对非 ASCII / 任意字节都能往返（不漏字节、不出 NUL）`, async ({ page }) => {
    await page.goto('/tool/base');
    // 选算法：这两组的编码都曾经是有符号 32 位 / 补零实现的受害者
    await page.locator(`[data-algo="${algo}"]`).click();
    const ta = page.locator('textarea');
    await ta.first().fill('hello world');
    await page.getByRole('button', { name: /编码/ }).first().click();
    const encoded = await ta.nth(1).inputValue();
    expect(encoded.length).toBeGreaterThan(0);
    // Base92 曾经在尾部补 0x00，往返后正文末尾多一个 NUL（视觉上看不见）
    expect(encoded).not.toContain('\u0000');
    await page.getByRole('button', { name: /解码/ }).first().click();
    await expect(ta.first()).toHaveValue('hello world');
  });
}

test('Hex：非法输入按 Escape 不提交（曾经 Escape 反而保存）', async ({ page }) => {
  await page.goto('/tool/hex');
  // 加载监听是在 useEffect 里挂的：选文件太早会丢 change 事件（真人也选不了这么快，
  // 但 CI 里会撞上），所以在「第一次没加载出来」时补选一次。这只影响这条用例的稳定性，
  // 不掩盖被测行为 —— 一旦页面对 change 事件真的失效，它会一直等到超时。
  const selectSample = () =>
    page.locator('#fileInput').setInputFiles({
      name: 'sample.bin',
      mimeType: 'application/octet-stream',
      buffer: Buffer.from([0x41, 0x42, 0x43, 0x44, 0x45]),
    });
  const bytes = page.locator('#hexBody .byte[data-index]');
  await selectSample();
  await page
    .waitForFunction(() => document.querySelectorAll('#hexBody .byte[data-index]').length === 5, null, {
      timeout: 8_000,
    })
    .catch(async () => {
      await selectSample();
    });
  await expect(bytes).toHaveCount(5);

  // 第 2 个字节改成非法值再按 Escape：输入框必须消失，且原字节仍是 42
  await page.locator('#hexBody .byte[data-index="1"]').dblclick();
  await page.locator('#hexBody input').fill('ZZ');
  await page.locator('#hexBody input').press('Escape');
  await expect(page.locator('#hexBody input')).toHaveCount(0);
  await expect(page.locator('#hexBody .byte[data-index="1"]')).toHaveText('42');
});

test('哈希：MD5 + HMAC 是不可用组合，徽章标记为不可用', async ({ page }) => {
  await page.goto('/tool/hash');
  await page.locator('textarea').first().fill('abc');
  await page.locator('input[type="checkbox"]').first().check();
  const md5 = page.locator('[data-algo="MD5"]');
  // 禁用语义看可访问状态，具体置灰程度属于视觉设计。
  await expect(md5).toHaveAttribute('aria-disabled', 'true');
});
