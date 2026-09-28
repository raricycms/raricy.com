// https-guard.ts —— 练手盘协议闸的判据，外加「闸门覆盖面」的对账。
//
// 【为什么值得单独一个文件】这套判据里有三处**刻意选的方向**，都不是读代码能看出来
// 的（读出来的只是「行为」，读不出「为什么不是另一种」）：
//   · **回环地址豁免** —— 这是 `npm run dev` 与全部 e2e 的唯一活路。别以为「不要它就
//     更安全」：Next 自己会按 socket 把 X-Forwarded-Proto 填成 http（实测），
//     所以明文 + localhost 是本地与测试的**常态**，少了豁免整块功能当场 403；
//   · 取的是那个头的**第一段** —— 写成 `.includes('http')` 之类会把 `https, http`
//     误判成明文；
//   · 私网 / 缺 Host 时宁可回 403，也不拼一个跳转 Location —— 308 是永久重定向，
//     会被浏览器长期缓存，跳错了只能清缓存。
// 每一条都在下面有点名它的用例。改动上面任何一处，红的正是这些用例。

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  guardedKind,
  isConfirmedHttp,
  isLocalHost,
  isLoopbackHost,
  outwardHost,
  plaintextVerdict,
  GUARDED_APIS,
} from '@/lib/https-guard';
import { config } from '@/middleware';

/** 只带指定头的 Headers（不传就是「一个头都没有」）。 */
function h(init: Record<string, string> = {}): Headers {
  const headers = new Headers();
  for (const [k, v] of Object.entries(init)) headers.set(k, v);
  return headers;
}

describe('isConfirmedHttp —— 只在**确证**是 http 时返回 true', () => {
  it('http / 大小写 / 两侧空白 → true', () => {
    for (const v of ['http', 'HTTP', ' http ', 'Http']) {
      expect(isConfirmedHttp(h({ 'x-forwarded-proto': v })), `XFP=${JSON.stringify(v)}`).toBe(true);
    }
  });

  it('多值取**第一段**：`http, https` 是明文，`https, http` 不是', () => {
    expect(isConfirmedHttp(h({ 'x-forwarded-proto': 'http, https' }))).toBe(true);
    // ⚠️ 这一条是判据的核心：`https, http` 是「先过 https 再过一层 http」的链，
    // 对外协议取的是第一跳。写成 includes('http') 就会把它误判成明文。
    expect(isConfirmedHttp(h({ 'x-forwarded-proto': 'https, http' }))).toBe(false);
  });

  it('https → false', () => {
    expect(isConfirmedHttp(h({ 'x-forwarded-proto': 'https' }))).toBe(false);
  });

  it('★ 头缺失 → false（放行）—— 这是刻意的 fail-open，不是漏判', () => {
    // 反过来的话：`npm run dev`（http://localhost:3000）与全部 e2e
    //（http://127.0.0.1:3100，playwright.config.ts 显式设了 COOKIE_SECURE=false）
    // 会在练手盘上当场 403。真要收紧就得同时给两边造出 https 的样子，代价见
    // src/lib/https-guard.ts 文件头。代价是 nginx 漏配时这道闸静默失效 ——
    // 那件事由 scripts/smoke.mjs 的 §1 报警兜。
    expect(isConfirmedHttp(h())).toBe(false);
  });

  it('空串 / 畸形值 → false（当没有信号处理）', () => {
    for (const v of ['', '   ', 'ftp', 'HTTP/1.1']) {
      expect(isConfirmedHttp(h({ 'x-forwarded-proto': v })), `XFP=${JSON.stringify(v)}`).toBe(false);
    }
  });
});

describe('guardedKind —— 哪条路径过闸、过哪一档', () => {
  it('页面：/fish/trade 与它下面的一切（含尾斜杠）', () => {
    for (const p of ['/fish/trade', '/fish/trade/', '/fish/trade/stats', '/fish/trade/stats/']) {
      expect(guardedKind(p), p).toBe('page');
    }
  });

  it('接口：GUARDED_APIS 里四条都认（含尾斜杠）', () => {
    for (const p of GUARDED_APIS) {
      expect(guardedKind(p), p).toBe('api');
      expect(guardedKind(`${p}/`), `${p}/`).toBe('api');
    }
  });

  it('前缀不得误伤：/fish/trades 与 /fish/tradex 不在闸内', () => {
    // 少一条这样的用例，`startsWith('/fish/trade')` 这种写法就会把 /fish/trades
    // 一起拦下（而它将来可能是个真页面）—— 症状是一个无关页面在 http 下 308。
    for (const p of ['/fish/trades', '/fish/tradex', '/fish', '/fish/market']) {
      expect(guardedKind(p), p).toBeNull();
    }
  });

  it('其余接口一律不在闸内', () => {
    for (const p of ['/api/auth/login', '/api/fish/market/transfer', '/api/fish/trade', '/api/blogs']) {
      expect(guardedKind(p), p).toBeNull();
    }
  });
});

describe('outwardHost —— 308 跳到哪个域名', () => {
  it('X-Forwarded-Host 优先，多值取第一段', () => {
    expect(outwardHost(h({ 'x-forwarded-host': 'a.com, b.com', host: 'up:3000' }))).toBe('a.com');
  });

  it('没有 X-Forwarded-Host 时回落到 Host', () => {
    expect(outwardHost(h({ host: 'raricy.com' }))).toBe('raricy.com');
  });

  it('空的 X-Forwarded-Host 不能顶掉 Host', () => {
    // 反代配了头但值为空是常见的（$host 取不到时），别因此把能拿到的 Host 丢掉。
    expect(outwardHost(h({ 'x-forwarded-host': '  ', host: 'raricy.com' }))).toBe('raricy.com');
  });

  it('★ 两个来源都缺 → null（调用方据此回 403，绝不拼半截 Location）', () => {
    expect(outwardHost(h())).toBeNull();
    expect(outwardHost(h({ host: '' }))).toBeNull();
  });

  it('容错：反代把 scheme 或路径一起塞进来时剥掉', () => {
    expect(outwardHost(h({ 'x-forwarded-host': 'https://raricy.com' }))).toBe('raricy.com');
    expect(outwardHost(h({ 'x-forwarded-host': 'https://raricy.com/foo' }))).toBe('raricy.com');
  });
});

describe('isLoopbackHost —— 只有它豁免（dev 与 e2e 的 Host 就是它）', () => {
  it('localhost / 127.x / ::1 算回环', () => {
    for (const host of ['localhost', 'localhost:3000', '127.0.0.1', '127.0.0.1:3100', '[::1]:3000', 'a.localhost']) {
      expect(isLoopbackHost(host), host).toBe(true);
    }
  });

  it('★ 私网段**不算**回环（豁免面只收到「没离开这台机器」）', () => {
    // 把 192.168.x / 10.x 也豁免掉，等于让「nginx 上游在同一局域网」的多机部署
    // 也免检 —— 而那恰恰是最需要这道闸的形态。
    for (const host of ['192.168.1.5', '10.0.0.7:3000', '172.16.3.4', 'raricy.com']) {
      expect(isLoopbackHost(host), host).toBe(false);
    }
  });
});

describe('isLocalHost —— 只用来否决 308 的跳转目标', () => {
  it('回环与私网都算（都不能拿来当跳转目标）', () => {
    for (const host of ['127.0.0.1:3000', 'localhost', '192.168.1.5', '10.0.0.7:3000', '172.31.0.1', 'box.local']) {
      expect(isLocalHost(host), host).toBe(true);
    }
  });

  it('公网域名不算', () => {
    for (const host of ['raricy.com', 'zk.raricy.com', 'example.com:8443']) {
      expect(isLocalHost(host), host).toBe(false);
    }
  });
});

describe('★ plaintextVerdict —— 拦 / 放 / 跳到哪，三种形态', () => {
  it('不是明文 → 放行（不管 Host 是什么）', () => {
    expect(plaintextVerdict(h({ 'x-forwarded-proto': 'https', host: 'raricy.com' }))).toEqual({
      block: false,
      redirectTo: null,
    });
    expect(plaintextVerdict(h({ host: 'raricy.com' }))).toEqual({ block: false, redirectTo: null });
  });

  it('★ 明文 + 回环 Host → **放行**（npm run dev 与全部 e2e 走的就是这条路）', () => {
    // Next 会自己把 x-forwarded-proto 填成 http（见 https-guard.ts 文件头），
    // 所以「明文 + localhost」正是本地开发与 e2e 的常态。这条一改，练手盘在本机
    // 与整个 e2e 里会整体 403 —— 而且只有真跑起来才看得见。
    for (const host of ['localhost:3000', '127.0.0.1:3100', '[::1]:3000']) {
      expect(plaintextVerdict(h({ 'x-forwarded-proto': 'http', host })), host).toEqual({
        block: false,
        redirectTo: null,
      });
    }
  });

  it('明文 + 公网域名 → 拦，并给出跳转目标', () => {
    expect(
      plaintextVerdict(h({ 'x-forwarded-proto': 'http', 'x-forwarded-host': 'raricy.com' }))
    ).toEqual({ block: true, redirectTo: 'raricy.com' });
  });

  it('★ 明文 + 私网 / 缺 Host → 拦，但**不给**跳转目标（宁 403 也不跳错地址）', () => {
    // 反代漏配 Host 时 Next 看到的就是上游地址。照它拼 308 会把浏览器永久送到
    // 那个地址上，而服务端每次都「正确地」返回 308、不报任何错 —— 只能清缓存。
    expect(plaintextVerdict(h({ 'x-forwarded-proto': 'http', host: '192.168.1.5:3000' }))).toEqual({
      block: true,
      redirectTo: null,
    });
    expect(plaintextVerdict(h({ 'x-forwarded-proto': 'http' }))).toEqual({
      block: true,
      redirectTo: null,
    });
  });
});

describe('闸门覆盖面：matcher 与文件系统双向对账', () => {
  it('matcher 必须同时含 /api/:path* 与 /fish/trade/:path*', () => {
    // ⚠️ 这一条是逐字断言，不是「包含」——改 matcher 必须是有意识的动作。
    // matcher 是构建期静态字符串，与运行期的 guardedKind 没有编译期关系：
    // 少了 /fish/trade/:path* 时中间件根本不会被这两个页面调用，而所有单测与
    // 绝大多数 e2e 照常全绿（页面在 http 下照常可达）。
    expect(
      config.matcher,
      'matcher 与 guardedKind 是一对必须同时改的东西：matcher 决定中间件会不会被调用，' +
        'guardedKind 决定被调用时管不管这条路径。改了一边没改另一边 = 闸静默失效。'
    ).toEqual(['/api/:path*', '/fish/trade/:path*']);
  });

  it('★ 每个 /api/fish/trade/<x>/route.ts 都必须在 GUARDED_APIS 里', () => {
    const dir = path.join(import.meta.dirname, '..', '..', 'src', 'app', 'api', 'fish', 'trade');
    expect(fs.existsSync(dir), `扫描面不存在（路径写错了？）：${dir}`).toBe(true);

    const onDisk = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .filter((d) => fs.existsSync(path.join(dir, d.name, 'route.ts')))
      .map((d) => `/api/fish/trade/${d.name}`)
      .sort();

    // 两边都排过序：新增一个路由而忘了进闸 → 这里红；GUARDED_APIS 里写了个已经
    // 删掉的路由 → 这里也红。漏进闸的症状是那个接口在 http 下照常可用，
    // 而页面本身是 308 —— 从界面上完全看不出来。
    expect(
      onDisk,
      'src/app/api/fish/trade/ 下新增了路由但没进 src/lib/https-guard.ts 的 GUARDED_APIS —— ' +
        '那个接口会在明文 http 下照常可用（页面已跳走，所以从界面上看不出来）'
    ).toEqual([...GUARDED_APIS].sort());
  });
});
