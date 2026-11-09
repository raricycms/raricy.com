import { expect, type APIRequestContext, type Page } from '@playwright/test';
import { PrismaClient } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import { SEED_PASSWORD, SEED_USERS } from './seed';

/** 唯一后缀：注册类用例每次都要新用户名，且 desktop / mobile 两个 project 会把同一个
 *  用例跑两遍 —— 写死用户名第二遍必撞「用户名已存在」。 */
export function uniqueTag(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * 等评论区**水合完成且首次拉取落定**。
 *
 * 【为什么必须等】评论区是客户端组件：SSR 只给出骨架，`loading` 初值为 true。在水合
 * 完成之前对受控 `<textarea>` 调 `fill()`，React 首次渲染会把它的 value 重置回空 state ——
 * 页面上看着字没了，但没有任何报错；随后点「发表评论」提交的是空正文，于是一条评论
 * 都没发出去。作者在慢网 / 慢机器上也可能撞上，所以这里不靠 `waitForTimeout` 猜。
 *
 * 计数徽标从「—」变成数字 = `loading=false`（首次 GET 已返回），是水合完成 + 数据到达
 * 的确定性信号；比「等 .comment-item」更通用（空评论区也成立）。
 */
export async function waitCommentSectionReady(page: Page): Promise<void> {
  await expect(page.locator('.comment-section__count')).not.toHaveText('—');
}

/**
 * 等某个客户端组件**真的水合完成**：React 接管 DOM 后会把内部 fiber/props 挂到节点上。
 *
 * 【什么时候需要】`page.goto` 等到的是 `load`，不是水合；紧接着对受控输入框 `fill` 时，
 * 若 React 还没接管，首次渲染会把 value 重置回空 —— 页面不报错，提交的是空表单。
 * 评论区有 `waitCommentSectionReady` 的专属判据；这个是不依赖业务数据的通用版本
 * （注册表单这类没有「加载完成」信号的页面用）。
 */
export async function waitForHydrated(page: Page, selector: string): Promise<void> {
  await page.waitForFunction((sel) => {
    const el = document.querySelector(sel);
    if (!el) return false;
    return Object.keys(el).some(
      (key) => key.startsWith('__reactFiber$') || key.startsWith('__reactProps$')
    );
  }, selector);
}

/**
 * 在自定义下拉（`ExpandSelect`）里选中一项。
 *
 * 站内那些「选择栏目 / 全部动作」已经从原生 <select> 换成带展开动画的自定义控件，
 * `page.selectOption()` 不再适用。`triggerId` 是触发钮的 id（与 `<label htmlFor>`
 * 同一个），选项按可见文字精确定位。
 */
export async function chooseExpandSelect(
  page: Page,
  triggerId: string,
  optionLabel: string
): Promise<void> {
  const host = page.locator('.expand-select', { has: page.locator(`#${triggerId}`) });
  await host.locator('.expand-select__toggle').click();
  await host.getByRole('option', { name: optionLabel, exact: true }).click();
}

/**
 * 服务端认为「当前是谁」。
 *
 * 读的是 root layout 直出的 <meta name="user-authenticated">：它由服务端在渲染每个
 * 页面时按 cookie 现算，因此**只有 cookie 真的随导航发回了服务端**它才会是 true。
 * 这正是线上那个 bug 的探针 —— 当时 Secure cookie 被浏览器丢弃，登录接口回 200、
 * 前端 toast「登录成功」，但任何一次导航后服务端都认不出人。断言接口返回值看不见它，
 * 断言前端状态也看不见它，只有真浏览器 + 真导航才看得见。
 */
export async function serverSeesAuthenticated(page: Page): Promise<boolean> {
  const content = await page
    .locator('meta[name="user-authenticated"]')
    .getAttribute('content');
  return content === 'true';
}

/** 走真实登录页（填表 + 提交），而不是直接种 cookie —— 要测的就是这条链路本身。 */
/**
 * 走真实表单登录。
 *
 * @param next 登录前想去的页面；传了就带 ?next= 进登录页，并等着落到那儿。
 *             不传则等落到首页（登录页 next 为空时回首页）。
 */
export async function loginViaUI(
  page: Page,
  username: string,
  password = SEED_PASSWORD,
  next?: string
) {
  await page.goto(next ? `/login?next=${encodeURIComponent(next)}` : '/login');
  await page.fill('#username', username);
  await page.fill('#password', password);
  await Promise.all([
    // 登录成功后前端 router.push(safeNextPath(next))，等这次跳转落地再继续。
    // 传了不安全的 next（外站 URL）时会落到 '/' —— 那种用例请直接自己断言 URL，
    // 别用这个参数，否则这里会一直等一个永远不来的跳转。
    page.waitForURL(next ?? '/', { timeout: 15_000 }),
    page.click('#submitBtn'),
  ]);
}

/**
 * 用 API 快速登录（把登录当**前置条件**而非被测目标时用它，省掉一次表单往返）。
 *
 * 必须用 page.request 而不是顶层的 `request` fixture：后者是独立的
 * APIRequestContext，它拿到的 Set-Cookie 进不了浏览器的 cookie jar，
 * 随后的 page.goto 依然是未登录 —— 用例会以「跳转到登录页」的假象挂掉，
 * 而且看起来像被测代码的鉴权有问题。page.request 与页面共用同一个 context 的 cookie。
 *
 * 【进程内会话缓存】登录接口按**用户名**限频（`RULES.passwordPerUser`，20 次/分钟）：
 * 全量 e2e 里同一个种子号会被几十条用例各自登录一次（blog.spec 一个文件就 21 次），
 * 30 秒内必然撞 429，而失败信息却指向业务用例。所以首个 200 登录的会话 cookie 按
 * username 缓存在本 worker 进程，后续调用直接 `context.addCookies` 种回去。
 *
 * ⚠️ 缓存命中前必须用一次 `GET /api/auth/me` **校验会话仍认人**：会话会在别处被
 * 作废（改密 / 登出 / 归档都会自增 sessionVersion，见 src/lib/session.ts）——
 * 盲目复用旧 cookie 会让那些用例以 401 收场。校验只读会话、不消耗登录限频。
 *
 * ⚠️ 只缓存**成功**的登录：密码错误一类用例走自己的 request / loginViaUI，
 * 永远不会拿缓存冒充「登录成功」。
 */
const SESSION_COOKIE = 'raricy_session'; // 与 src/lib/session.ts 的 SESSION_COOKIE 同值
type StoredCookie = Awaited<ReturnType<APIRequestContext['storageState']>>['cookies'][number];
/** username → 首次真实登录后浏览器 context 里那条会话 cookie。 */
const loginCache = new Map<string, StoredCookie[]>();

export async function loginViaApi(page: Page, username: string) {
  const cached = loginCache.get(username);
  if (cached && cached.length > 0) {
    await page.context().addCookies(cached);
    // 缓存可能已被作废（上一条用例改过密码 / 登出 / 归档）：以「服务端还认不认」为准。
    const probe = await page.request.get('/api/auth/me').catch(() => null);
    const probeBody = probe ? await probe.json().catch(() => null) : null;
    if (probe?.ok() && probeBody?.user?.username === username) return;
    loginCache.delete(username);
  }

  const res = await page.request.post('/api/auth/login', {
    data: { username, password: SEED_PASSWORD },
  });
  expect(res.status()).toBe(200);
  expect((await res.json()).code).toBe(200);

  // 缓存浏览器 context 收到的**真实 Set-Cookie**（storageState 里那条）：domain /
  // path / secure / sameSite / httpOnly 与服务端 sessionCookieOptions 完全一致，
  // 不自己拼一个「看起来差不多」的 cookie。
  const state = await page.context().storageState();
  const session = state.cookies.filter((c) => c.name === SESSION_COOKIE);
  if (session.length > 0) loginCache.set(username, session);
}

/**
 * 注册一个全新用户并让浏览器 context 处于其登录态。返回用户信息。
 *
 * 【什么时候必须用它而不是种子号】凡是**按用户计限频**的写操作，发言者/操作者
 * 都该用一次性用户，别借种子号。种子号（e2e_core / e2e_admin）是两个 project
 * 共用的，desktop 和 mobile 各跑一轮 —— 前一轮的配额还没滑出窗口，后一轮接着
 * 消耗同一个桶，用例就会在**首条**操作上吃 429。
 *
 * 已踩过（见 4282a55）：chat-avatar-menu 与 chat-features 两条用例里，admin 在
 * 60 秒内把当时的发言额度（30/分钟）顶满，`chat:m:e2e-user-admin` 达到 30/30 ——
 * 当时是 desktop 那轮的发言还没过期。（该额度 2026-09-15 已放宽到 120/分钟，
 * 但结论不变：种子号的桶是两个 project 共用的，写操作密集的用例一律新号。）
 *
 * 相关的按用户限频额度**以 src/lib/rate-limit.ts 的 RULES 为准**，别抄数字 ——
 * 这里曾经漂过（写着「800/天」时实际已是 2000）。发言 / 投票 / 图床上传 / 点赞
 * 都按用户计桶。
 *
 * @param opts.core 保留新注册的 core 资格；默认 false 会通过管理接口撤销为历史账号夹具。
 *   需要 core 的场景：点赞/剪贴板/投票/申诉/讨论这些 **core+ 档**的接口 ——
 *   光注册是用不了的，得先过邀请码认证。用例若忘了提权，会拿到 403，
 *   看起来像鉴权坏了，其实是没认证。
 */
/**
 * 邀请注册使用一次性邀请码。
 *
 * 【2026-11-07 P01 起不再走网页 /zhh】网页发码入口已关闭（410），邀请码只由运维 CLI
 * 签发。e2e 作为测试夹具需要真实的一次性码，因此**直连本轮 E2E 库**插一枚：
 * 码的形状与 `src/lib/invite-code.ts` 完全一致（64 位随机 → base62 右填到 12 位），
 * 注册接口仍走真实 HTTP（这才是被测链路）。生产路径不经过这里。
 * 注意：**不能 import `src/lib/invite-code`** —— 它拖着 `@/lib/db`，而在 Playwright
 * worker 里那个单例会连到 .env 指向的真实库，绝不能为了发一枚测试码去碰它。
 */
const INVITE_CHARSET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
let inviteDb: PrismaClient | null = null;

function inviteClient(): PrismaClient {
  const file = process.env.E2E_DB;
  if (!file) throw new Error('缺少 E2E_DB —— 无法为 e2e 生成邀请码夹具');
  inviteDb ??= new PrismaClient({ datasources: { db: { url: `file:${file}` } } });
  return inviteDb;
}

function newInviteCodeValue(): string {
  const buf = randomBytes(8); // 64 位，与 invite-code.ts 的取数方式一致
  let raw = 0n;
  for (const b of buf) raw = (raw << 8n) | BigInt(b);
  let out = '';
  while (raw > 0n) {
    out = INVITE_CHARSET[Number(raw % 62n)] + out;
    raw /= 62n;
  }
  return out.padEnd(12, '0').slice(0, 12);
}

/** `page` 参数保留仅为旧调用点兼容：取码不再依赖任何浏览器会话。 */
export async function freshInvite(page?: Page): Promise<string> {
  void page;
  const db = inviteClient();
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = newInviteCodeValue();
    try {
      await db.inviteCode.create({ data: { code, isUsed: false, createdAt: new Date() } });
      return code;
    } catch (e) {
      // 12 位 base62 撞码概率极低，但 @unique 仍是最终防线：重试一次即可。
      if ((e as { code?: string }).code !== 'P2002') throw e;
    }
  }
  throw new Error('生成 e2e 邀请码失败（连续 5 次唯一约束冲突）');
}

export async function registerFreshUser(
  page: Page,
  opts: { core?: boolean } = {}
): Promise<{ id: string; username: string }> {
  const tag = uniqueTag();
  const username = `e2e_${tag}`;
  const invite_code = await freshInvite(page);
  const res = await page.request.post('/api/auth/register', {
    data: { username, email: `${tag}@e2e.local`, password: SEED_PASSWORD, invite_code },
  });
  const body = await res.json();
  // 断言而非静默继续：注册失败时后续用例的报错会指向八竿子打不着的地方
  expect(body.code, `注册失败：${JSON.stringify(body)}`).toBe(200);

  // 默认夹具模拟历史未认证账号；新注册本身始终是 core。
  if (!opts.core) {
    // 借管理员走真实提权接口，而不是直连库改 role —— 顺带让这条链路本身也被跑到。
    // （user↔core 是管理员权限内的事，见 setRole；不必动用站长。）
    await loginViaApi(page, SEED_USERS.admin.username);
    const up = await page.request.patch(`/api/admin/users/${body.user.id}`, {
      data: { role: 'user' },
    });
    expect(up.status(), `提权失败：${await up.text()}`).toBe(200);
    // 换回这个新用户的登录态 —— 上一步把 cookie 换成管理员了
    await loginViaApi(page, username);
  }
  return { id: body.user.id, username };
}

/**
 * 以**当前会话身份**发布一篇最小文章，返回 blog_id。
 *
 * 【为什么需要】2026-10 起签到多了一道内容前置条件：名下至少一篇未软删的文章
 * （见 src/lib/checkin-service.ts 头部）。要签到的用例得先跨过它。
 *
 * ⚠️ **只给需要签到的用例调**：它会往库里多写一行博客 + 一行正文，
 * 给不关心签到的用例平添副作用（数文章数、数总条数的用例会被带偏）。
 */
export async function publishBlog(page: Page, visibility = 'internal'): Promise<string> {
  const res = await page.request.post('/api/blogs', {
    data: {
      title: `签到前置-${uniqueTag()}`,
      description: 'e2e：签到前置条件用的最小文章',
      content: '# e2e\n\n发布过文章才能签到。',
      visibility,
    },
  });
  const body = (await res.json()) as { code?: number; blog_id?: string; message?: string };
  expect(body.code, `发文失败：${JSON.stringify(body)}`).toBe(200);
  expect(body.blog_id, 'POST /api/blogs 必须回 blog_id').toBeTruthy();
  return body.blog_id!;
}
