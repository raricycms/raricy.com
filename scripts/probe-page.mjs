#!/usr/bin/env node
// 临时页面探针 —— 别再手写内联 `chromium.launch()` heredoc。
//
// 【为什么有这个脚本】历史会话里这类一次性脚本写了 **126 段**（分散在 19 个会话），
// 每段都是「起浏览器 → 打开一个页面 → 看某个选择器在不在 / 截个图 → 关掉」，
// 各写各的，没人复用。代价有两层：
//   1. 每段都要重新踩一遍同样的坑（等水合、登录态、`next start` 有没有起、CDP 泄漏）；
//   2. 它们散落在 pwsh heredoc 里，事后谁也不知道「上月是怎么验的」。
//
// 【用法】需要 e2e 的 webServer 已经在跑（`npm run e2e:ci` 那套端口）：
//
//   npx tsx scripts/probe-page.mjs /blog
//   npx tsx scripts/probe-page.mjs /blog --as core          # 用种子账号登录后再看
//   npx tsx scripts/probe-page.mjs /blog --wait .blog-card  # 等某个选择器出现
//   npx tsx scripts/probe-page.mjs /blog --shot blog.png    # 截图到 %TEMP%
//   npx tsx scripts/probe-page.mjs /blog --html             # 打印渲染后的 HTML
//   npx tsx scripts/probe-page.mjs /blog --console          # 打印 console 报错
//
// 【为什么是 tsx 而不是 node】种子账号与密码直接从 tests/e2e/seed.ts 读（不另抄一份，
// 抄了会在密码改动时静默失效）。seed.ts 是 TypeScript，裸 node 会 ERR_UNKNOWN_FILE_EXTENSION。
// 仓库里 scripts/diagnose-deploy.mjs、reactive-corpus-report.mjs 都是同一做法。
//
// 【和 e2e 的分工】这个脚本**不做断言、不进 CI、不算测试**。它只是「我想看一眼」。
// 要断言的行为写成 `tests/e2e/*.spec.ts`（跑 `npx playwright test <那个文件>`）。

import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const root = fileURLToPath(new URL('../', import.meta.url));
const DEFAULT_PORT = 3100;

// 种子账号与密码**从 tests/e2e/seed.ts 读**，不在这里另抄一份 ——
// 抄一份就会在密码改动时静默失效（探针登不上，报的却是「HTTP 401」）。
// 注意：这个脚本要用 `npx tsx` 跑（不是裸 node），因为 seed.ts 是 TypeScript ——
// 同 scripts/diagnose-deploy.mjs / reactive-corpus-report.mjs 的既有做法。
const { SEED_PASSWORD, SEED_USERS } = await import('../tests/e2e/seed.ts');

function parseArgs(argv) {
  const opts = { url: '/', wait: null, shot: null, as: null, html: false, console: false, port: DEFAULT_PORT, timeout: 30_000, width: null, height: null, actions: [], typeText: null, typeFile: null, thenWait: null, assertNo: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--wait') opts.wait = next();
    else if (a === '--shot') opts.shot = next();
    else if (a === '--as') opts.as = next();
    else if (a === '--port') opts.port = Number(next());
    else if (a === '--width') opts.width = Number(next());
    else if (a === '--height') opts.height = Number(next());
    else if (a === '--click') opts.actions.push({ kind: 'selector', value: next() });
    else if (a === '--click-name') opts.actions.push({ kind: 'name', value: next() });
    else if (a === '--type') opts.typeText = next();
    else if (a === '--type-file') opts.typeFile = next();
    else if (a === '--then-wait') opts.thenWait = next();
    else if (a === '--assert-no') opts.assertNo = next();
    else if (a === '--timeout') opts.timeout = Number(next());
    else if (a === '--html') opts.html = true;
    else if (a === '--console') opts.console = true;
    else if (a === '-h' || a === '--help') opts.help = true;
    else if (!a.startsWith('--')) opts.url = a;
  }
  return opts;
}

const HELP = `用法: npx tsx scripts/probe-page.mjs <路径> [选项]

  --as <core|admin|owner|plain>   用种子账号登录后再访问
  --wait <选择器>                 等到该选择器出现（默认只等到 load）
  --shot <文件名>                 截图（写到 %TEMP%，不是仓库）
  --html                          打印渲染后的 HTML（超长会截断）
  --console                       打印浏览器 console 的 warning / error
  --port <端口>                   主站端口，默认 ${DEFAULT_PORT}
  --width <像素> / --height <像素>  视口（默认 Playwright 的 1280×720）
  --click <选择器>                等 --wait 之后依次点击（可重复；用于打开菜单）
  --click-name <文本>             按可访问名点击按钮（子串匹配，可重复）
  --type <文本>                   点击 .cm-content 后一次性输入（编辑器用例）
  --type-file <文件>              同上，从 UTF-8 文件读（避开 shell 引号 / 换行）
  --then-wait <选择器>            点击 / 输入之后再等一个选择器（如预览编译完成）
  --assert-no <选择器>            最后断言该选择器不存在（不存在=通过；出现了才失败退出）
  --timeout <毫秒>                总超时，默认 30000

注意：需要 e2e 的 webServer 已在跑（npm run e2e:ci 那套）。这个脚本不做断言、不算测试。
`;

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(HELP);
    return;
  }

  if (opts.as && !SEED_USERS[opts.as]) {
    throw new Error(`--as 只认 ${Object.keys(SEED_USERS).join(' / ')}`);
  }

  const base = `http://127.0.0.1:${opts.port}`;
  const browser = await chromium.launch();
  try {
    // 用 browser.newContext()：浏览器自己把临时 profile 放在系统临时目录，
    // 探针不在仓库里留任何东西。（早先这里还 mkdtempSync 了一个 userDataDir，
    // 但从没传给 newContext/launch —— 那是一段只创建、只删除空目录的死代码。）
    const context = await browser.newContext(
      opts.width ? { viewport: { width: opts.width, height: opts.height ?? 900 } } : undefined
    );
    const page = await context.newPage();

    if (opts.console) {
      page.on('console', (msg) => {
        if (msg.type() === 'error' || msg.type() === 'warning') {
          console.log(`  [console.${msg.type()}] ${msg.text()}`);
        }
      });
      page.on('pageerror', (err) => console.log(`  [pageerror] ${err.message}`));
    }

    if (opts.as) {
      const user = SEED_USERS[opts.as];
      const r = await page.request.post(`${base}/api/auth/login`, {
        data: { username: user.username, password: SEED_PASSWORD },
      });
      if (!r.ok()) throw new Error(`以 ${opts.as} 登录失败：HTTP ${r.status()}`);
      console.log(`已登录为 ${opts.as}（${user.username}）`);
    }

    const target = opts.url.startsWith('http') ? opts.url : `${base}${opts.url}`;
    const res = await page.goto(target, { waitUntil: 'load', timeout: opts.timeout });
    console.log(`GET ${target} → ${res ? res.status() : '(no response)'}`);

    if (opts.wait) {
      await page.waitForSelector(opts.wait, { timeout: opts.timeout });
      console.log(`选择器出现：${opts.wait}`);
      const count = await page.locator(opts.wait).count();
      console.log(`匹配数量：${count}`);
    }

    const typed = opts.typeFile ? fs.readFileSync(opts.typeFile, 'utf8') : opts.typeText;
    if (typed !== null) {
      await page.locator('.cm-content').first().click({ timeout: opts.timeout });
      await page.keyboard.insertText(typed);
      console.log(`输入了 ${typed.length} 个字符`);
    }

    for (const action of opts.actions) {
      if (action.kind === 'name') {
        // 以可访问名**开头**匹配：组件卡片的名字是「标题 + 说明」，
        // 前缀匹配能区分「锚点」与「跳转与锚点」这类包含关系。
        const escaped = action.value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        await page
          .getByRole('button', { name: new RegExp(`^${escaped}`) })
          .first()
          .click({ timeout: opts.timeout });
        console.log(`点击按钮：${action.value}`);
      } else {
        await page.locator(action.value).first().click({ timeout: opts.timeout });
        console.log(`点击：${action.value}`);
      }
      await page.waitForTimeout(200);
    }

    if (opts.thenWait) {
      await page.waitForSelector(opts.thenWait, { timeout: opts.timeout });
      console.log(`选择器出现：${opts.thenWait}`);
    }

    if (opts.assertNo) {
      const count = await page.locator(opts.assertNo).count();
      if (count > 0) throw new Error(`断言失败：${opts.assertNo} 出现了 ${count} 个`);
      console.log(`断言通过：${opts.assertNo} 不存在`);
    }

    console.log(`标题：${await page.title()}`);
    console.log(`最终 URL：${page.url()}`);

    if (opts.html) {
      const html = await page.content();
      console.log(`\n---- HTML（${html.length} 字节）----`);
      console.log(html.length > 6000 ? `${html.slice(0, 6000)}\n…（已截断）` : html);
    }

    if (opts.shot) {
      // 截图一律落系统临时目录：仓库里不该出现探针产物。
      const out = path.isAbsolute(opts.shot) ? opts.shot : path.join(os.tmpdir(), opts.shot);
      await page.screenshot({ path: out, fullPage: true });
      console.log(`截图：${out}`);
    }

    await context.close();
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error(`探针失败：${e.message}`);
  if (/ECONNREFUSED|net::ERR_CONNECTION_REFUSED/.test(e.message)) {
    console.error(`\n端口 ${DEFAULT_PORT} 上没有服务。e2e 的 webServer 没起时是这样的 ——`);
    console.error('先跑一次 `npm run e2e:ci`（或 `npm run build` 后手动 `node scripts/start.mjs start -p 3100`）。');
  }
  if (/Cannot use import statement|ERR_UNKNOWN_FILE_EXTENSION/.test(e.message)) {
    console.error('\n这是用裸 node 跑了 .mjs：本脚本要 `npx tsx scripts/probe-page.mjs …`（要读 seed.ts）。');
  }
  process.exitCode = 1;
});
