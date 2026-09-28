// 练手盘的协议闸（src/middleware.ts §A）在真实 HTTP 下的行为。
//
// 【为什么单测不够，非要在 E2E 层再打一遍】tests/unit/middleware-https.test.ts 是拿手搓的
// NextRequest 直接喂给 middleware() 的 —— 它证明不了 **config.matcher 真的把这些路径
// 交给了中间件**。matcher 漏一条时中间件根本不会被调用，而所有单测与其余 e2e 照常全绿
//（页面在 http 下照常可达）。这与 csrf.spec.ts 头部记的那条教训同源。
//
// 【为什么这一层能测到】闸的判据挂在 X-Forwarded-Proto 上。那个头在真实部署里由 nginx
// 写；而**没有反代时 Next 自己会按 socket 填**（实测：直连明文时中间件读到 http）——
// 所以浏览器流量本身就是「明文」那一档，测不到「拦」的效果。Playwright 的 `request`
// fixture 是纯 HTTP 客户端，可以注入任意头（包括把 Host 装成公网域名），
// 于是这一层能把**要拦的那一路**真打一遍。
//
// 反过来，本机那一路（明文 + 127.0.0.1）必须用真浏览器走一遍：那正是
// `npm run dev` 与全部 e2e 自己走的路，也是回环豁免存在的全部理由。
// 拦了它，练手盘在本机与整个 e2e 里会整体打不开。

import { test, expect } from '@playwright/test';
import { SEED_USERS } from './seed';
import { loginViaApi } from './helpers';

/** 装成「nginx 确证这次请求走的是明文 http」。 */
const AS_PLAINTEXT = { 'x-forwarded-proto': 'http', 'x-forwarded-host': 'example.com' };

test.describe('练手盘协议闸', () => {
  test('页面：确证 http → 308 跳到 https，查询串保留', async ({ request }) => {
    for (const p of ['/fish/trade', '/fish/trade/stats']) {
      // maxRedirects: 0 —— 不跟走，否则 Playwright 会去连 example.com（一个不存在的站）。
      const res = await request.get(`${p}?a=1`, { headers: AS_PLAINTEXT, maxRedirects: 0 });
      expect(res.status(), p).toBe(308);
      expect(res.headers()['location'], p).toBe(`https://example.com${p}?a=1`);
    }
  });

  test('接口：确证 http → 403 JSON（不是跳转）', async ({ request }) => {
    const cases = [
      ['quote', () => request.get('/api/fish/trade/quote', { headers: AS_PLAINTEXT, maxRedirects: 0 })],
      [
        'candles',
        () =>
          request.get('/api/fish/trade/candles?symbol=BTCUSDT&interval=1h', {
            headers: AS_PLAINTEXT,
            maxRedirects: 0,
          }),
      ],
      // 写接口用 POST：闸必须挡在**解析 body 之前**，所以空 body 也算数。
      // 真到了路由那一层，未登录会回 401 —— 这里断文案，正是为了把它与鉴权层的
      // 403/401 区分开：只看状态码的话，「闸没生效、只是被鉴权顺手挡住」也会绿。
      ['buy', () => request.post('/api/fish/trade/buy', { headers: AS_PLAINTEXT, data: {}, maxRedirects: 0 })],
      ['sell', () => request.post('/api/fish/trade/sell', { headers: AS_PLAINTEXT, data: {}, maxRedirects: 0 })],
    ] as const;

    for (const [name, run] of cases) {
      const res = await run();
      expect(res.status(), name).toBe(403);
      expect(res.headers()['location'], `${name} 不该是跳转`).toBeUndefined();
      expect(((await res.json()) as { message: string }).message, name).toContain('HTTPS');
    }
  });

  test('★ 反面：明文 + 回环 Host → 不拦（dev 与 e2e 走的就是这条路）', async ({ page }) => {
    // 这一趟是真浏览器打的 127.0.0.1:3100、且 Next 会把 X-Forwarded-Proto 填成 http
    // —— 也就是说它是**确证的明文**，唯一的免死金牌是「Host 是回环」。
    // 把回环豁免去掉（或改成按档位/用户判），练手盘在本机与整个 e2e 里会整体 403，
    // 而这条用例就是当场抓住它的地方。
    await loginViaApi(page, SEED_USERS.core.username);
    const res = await page.goto('/fish/trade');
    expect(
      res?.status(),
      '闸把回环地址也拦了 —— 那会让 npm run dev 与全部 e2e 的练手盘整体打不开'
    ).toBe(200);
    // 没有跑到别的域上去（308 会把人送走）
    expect(page.url()).toContain('127.0.0.1');
    await expect(page.locator('body')).toContainText('练手盘');
  });
});
