// 玩具区（`/game`）协议闸（src/middleware.ts §A）在真实 HTTP 下的行为。
//
// 【为什么单测不够，非要在 E2E 层再打一遍】tests/unit/middleware-https.test.ts 是拿手搓的
// NextRequest 直接喂给 middleware() 的 —— 它证明不了 **config.matcher 真的把这些路径
// 交给了中间件**。这次新增的 `/game/:path*` 在 matcher 里是一条字面量：漏了它，中间件
// 根本不会被这些页面调用，而所有单测与其余 e2e 照常全绿（页面在 http 下照常可达）。
// 这套理由与 csrf.spec.ts / fish-trade-https.spec.ts 头部记的是同一条。
//
// 判据挂在 X-Forwarded-Proto 上：没有反代时 Next 自己会按 socket 填成 http，
// 所以浏览器流量就是「明文」那一档，测不到「拦」；Playwright 的 `request` fixture
// 是纯 HTTP 客户端，能注入任意头，于是这一层把**要拦的那一路**真打一遍。
// 反过来，本机那一路（明文 + 127.0.0.1）必须用真浏览器走一遍 —— 那正是全部 e2e
// 自己走的路，练手盘与玩具区的回环豁免就活在那里。

import { test, expect } from '@playwright/test';

/** 装成「nginx 确证这次请求走的是明文 http」。 */
const AS_PLAINTEXT = { 'x-forwarded-proto': 'http', 'x-forwarded-host': 'example.com' };

test.describe('玩具区协议闸', () => {
  test('页面：确证 http → 308 跳到 https，查询串保留', async ({ request }) => {
    // /game/quandi/play 是 iframe 的文档路由（route handler），它落在页面前缀下，
    // 按页面走 308 —— 它只有 GET，跟过去没有任何损失（见 https-guard.ts 文件头）。
    for (const p of ['/game', '/game/atamas', '/game/collections/test', '/game/quandi/play']) {
      // maxRedirects: 0 —— 不跟走，否则 Playwright 会去连 example.com（一个不存在的站）。
      const res = await request.get(`${p}?a=1`, { headers: AS_PLAINTEXT, maxRedirects: 0 });
      expect(res.status(), p).toBe(308);
      expect(res.headers()['location'], p).toBe(`https://example.com${p}?a=1`);
    }
  });

  test('接口：确证 http → 403 JSON（不是跳转，文案点名玩具）', async ({ request }) => {
    // 四个启动接口都是 POST：闸必须挡在**解析 body 之前**，所以空 body 也算数。
    // 真到了路由那一层，未登录会回 401 —— 这里断文案，正是为了把它与鉴权层的
    // 403/401 区分开：只看状态码的话，「闸没生效、只是被鉴权顺手挡住」也会绿。
    for (const name of ['wand', 'wand2', 'quandi', 'public-space']) {
      const res = await request.post(`/api/game/${name}/launch`, {
        headers: AS_PLAINTEXT,
        data: {},
        maxRedirects: 0,
      });
      expect(res.status(), name).toBe(403);
      expect(res.headers()['location'], `${name} 不该是跳转`).toBeUndefined();
      const body = (await res.json()) as { message: string };
      expect(body.message, name).toContain('HTTPS');
      expect(body.message, name).toContain('玩具');
    }
  });

  test('★ 反面：明文 + 回环 Host → 不拦（dev 与 e2e 走的就是这条路）', async ({ page }) => {
    // 这一趟是真浏览器打的 127.0.0.1:3100、且 Next 会把 X-Forwarded-Proto 填成 http
    // —— 也就是说它是**确证的明文**，唯一的免死金牌是「Host 是回环」。
    // 把回环豁免去掉（或改成按档位/用户判），玩具区在本机与整个 e2e 里会整体 403，
    // 而这条用例就是当场抓住它的地方。
    const res = await page.goto('/game');
    expect(
      res?.status(),
      '闸把回环地址也拦了 —— 那会让 npm run dev 与全部 e2e 的玩具区整体打不开'
    ).toBe(200);
    // 没有跑到别的域上去（308 会把人送走）
    expect(page.url()).toContain('127.0.0.1');
    await expect(page.locator('body')).toContainText('玩具');
  });
});
