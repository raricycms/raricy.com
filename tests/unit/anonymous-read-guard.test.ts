// ─────────────────────────────────────────────────────────────────────────────
// anonymous-read-guard.test.ts —— 静态检查：每条读接口都得有个说法
//
// 【为什么要有】2026-09 集中收口时发现，本站漏掉的读口有一个共同形状：
// **它们免认证，而没人知道**。写的时候都是「读公开数据不该先要账号」，
// 后来站点的档位整体收紧了，那几条没跟上 —— 于是 `GET /api/blogs/:id` 长期
// 匿名返回全文 Markdown，`GET /api/blogs` 匿名返回全站目录，而**文件里没有任何
// 痕迹**说明这是有意的。同一轮里 spider 那五条也一样（见 tests/route/spider-auth.test.ts）。
//
// 这类错的代价不是「多一个 401」，而是静默泄露：没有报错、没有日志、页面看起来
// 一切正常（因为页面自己那道 `requireCoreUser()` 还挡着），只有 curl 一下才知道。
// 所以它跟 db-time-guard 同属一类：tsc 管不着、构建不报、只有静态检查能钉住。
//
// 【判据】扫 `src/app/**/route.ts`，凡导出 `GET` / `HEAD` 的，必须满足其一：
//   · 文件里出现守卫符号（下表），或
//   · 在 PUBLIC_READ_ROUTES 里，**且写明为什么公开**。
// 都不是 → 测试失败，报错里给两条出路。
//
// 【它抓不到什么】只看符号**出现**，不证明真的**调用**了 —— 一个 import 了却没用
// 的文件照样能过。它是绊线，不是证明器：作用是在你新增一条匿名读口时当场变红，
// 逼你写下一句理由。真判档位对不对，靠 tests/route/ 下那些逐条断言 401/403 的用例。
// ─────────────────────────────────────────────────────────────────────────────

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');
const APP_DIR = path.join(ROOT, 'src/app');

/** 认得出来的守卫入口。新增鉴权工具函数时**要加到这里**，否则合法路由会被误报。 */
const GUARD_SYMBOLS = [
  // src/lib/auth.ts —— 取会话与角色判定
  'getCurrentUser',
  'isCoreUser',
  'hasAdminRights',
  'isOwner',
  // 会话本身的校验（有些路由直接读 cookie，不经 getCurrentUser）
  'verifySessionToken',
  'SESSION_COOKIE',
  // 各命名空间自己的入口守卫（与 src/lib/guard.ts 同名但分属不同文件）
  'requireChatUser', // src/app/api/chat/_auth.ts
  'requireCoreUser', // src/app/api/favorites/_shared.ts
  'requireMarketActor', // src/app/api/fish/market/_auth.ts
  // ── per-object 可见性守卫（**不是**会话档位）─────────────────────────────────
  //
  // 上面那些判的是「你有没有资格用这个区」；这一个判的是「**这一篇**是不是对外可见」——
  // 调用方拿不到会话也能读，但只读得到 link / public 档的文章，private / 已软删 /
  // 不存在三种情况同形（都是 null → 404）。判定收在 src/lib/blog-service.ts 的
  // EXTERNAL_VISIBLE_BLOG_WHERE 里，**别让调用方自己手写 where**：
  // 具名出口是这条台账唯一认得的形状，也是「这个调用点确实做了可见性判定」的凭证。
  //
  // 前例是 /api/images/[id]/raw（它靠 getCurrentUser 过线，形态不同、意图相同：
  // 都是「匿名可达，但逐条判该不该给你」）。
  'getExternallyVisibleBlog', // src/lib/blog-service.ts
];

const GUARD_RE = new RegExp(GUARD_SYMBOLS.join('|'));

/**
 * 刻意匿名的读接口 —— **每一条都要能说出为什么**。
 *
 * 写进来的门槛：调用方拿不到任何用户数据；一旦将来开始返回用户内容，
 * 就必须从这张表里挪走、改成档位判定。
 */
const PUBLIC_READ_ROUTES: Record<string, string> = {
  // 头像字节。没有头像时回落生成 identicon（永远 200），本就不构成访问控制。
  '/api/avatar/[id]': '头像字节：无头像时返回 identicon，无访问控制语义',
  // 表情素材字节。表情是站点素材不是用户数据；隐藏合集由 resolveSticker
  // 拦成 404，那是「不出现在面板里」，不是访问控制。
  '/api/stickers/[collection]/[name]': '表情素材字节：站点素材，非用户数据',
  // 账目查询：站外项目（如银行类对接）要能直接查余额与排行榜，凭据不随请求走。
  // ⚠️ 只暴露余额与榜位，不暴露流水（流水是 /api/fish/transactions，需登录）。
  '/api/fish/balance/[id]': '鱼干余额：站外只读查询，不含流水',
  '/api/fish/leaderboard': '鱼干排行榜：站外只读',
  // ⚠️ 这条**不是**匿名，是**另一套凭据**：鉴权走 Authorization: Bearer <access_token>，
  // 由 OAuth 客户端持有，与会话 cookie 无关（见 docs/oauth.md）。放这里只是因为
  // 判据按「有没有会话守卫符号」扫，它的凭据不来自会话。
  '/api/oauth/userinfo': '鉴权走 Bearer token（OAuth access_token），非会话',
};

/** 递归找出所有 route.ts。 */
function findRouteFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) findRouteFiles(full, out);
    else if (entry.name === 'route.ts') out.push(full);
  }
  return out;
}

/** `src/app/api/blogs/[id]/route.ts` → `/api/blogs/[id]`。 */
function routePathOf(file: string): string {
  const rel = path.relative(APP_DIR, file).split(path.sep).join('/');
  return '/' + rel.replace(/\/route\.ts$/, '');
}

/** 该文件是否导出 GET / HEAD（只看导出形式，不解析 AST）。 */
function exportsReadHandler(src: string): boolean {
  return (
    /\bexport\s+(async\s+)?function\s+(GET|HEAD)\b/.test(src) ||
    /\bexport\s+const\s+(GET|HEAD)\b/.test(src)
  );
}

describe('免认证读口台账', () => {
  const routeFiles = findRouteFiles(APP_DIR);
  const readRoutes = routeFiles
    .map((f) => ({ file: f, route: routePathOf(f), src: fs.readFileSync(f, 'utf8') }))
    .filter((r) => exportsReadHandler(r.src));

  it('扫描本身要有产出（别因为路径写错而悄悄扫了个空）', () => {
    expect(routeFiles.length, '找不到任何 route.ts，APP_DIR 是不是写错了').toBeGreaterThan(10);
    expect(readRoutes.length, '没有任何 GET 路由，导出检测的正则是不是失效了').toBeGreaterThan(10);
  });

  it('每条 GET / HEAD 接口要么有守卫，要么在白名单里写明理由', () => {
    const unguarded = readRoutes
      .filter((r) => !GUARD_RE.test(r.src))
      .filter((r) => !(r.route in PUBLIC_READ_ROUTES))
      .map((r) => r.route);

    expect(
      unguarded,
      '这些读接口既没有会话守卫、也不在 PUBLIC_READ_ROUTES 里。\n' +
        '两条出路，挑一条：\n' +
        '  · 本来就该登录才能读 → 加档位判定（见 src/app/api/spider/blogs/[id]/route.ts 的写法）；\n' +
        '  · 确实要匿名可读 → 写进本文件顶部的 PUBLIC_READ_ROUTES，并**写清为什么**。\n' +
        '⚠️ 别为了让它变绿而随手加白名单：这张表是「有意匿名」的清单，' +
        '把它当橡皮擦用，这个守卫就退化成了摆设。'
    ).toEqual([]);
  });

  it('白名单里没有已经不存在的路由（腐化会留下永久免检的口子）', () => {
    const known = new Set(readRoutes.map((r) => r.route));
    const stale = Object.keys(PUBLIC_READ_ROUTES).filter((r) => !known.has(r));
    expect(
      stale,
      '这些白名单条目已经对不上任何 GET 路由了 —— 路由改名或删掉后忘了同步。\n' +
        '留着它们不会报错，但下次有人新建同名路由时会**直接继承这条豁免**。'
    ).toEqual([]);
  });

  it('白名单的每条都得写出理由（空字符串不算）', () => {
    const undocumented = Object.entries(PUBLIC_READ_ROUTES)
      .filter(([, why]) => why.trim().length < 8)
      .map(([route]) => route);
    expect(undocumented, '白名单条目必须带一句能说服下一个人的理由').toEqual([]);
  });
});
