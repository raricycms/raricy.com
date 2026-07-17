#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// check-permissions.mjs —— 比对 Flask 与 Next 的端点权限档位
//
// 【为什么需要】迁移中已经因此漏掉三处，全是权限被放宽：
//   · 群发通知      Flask 站长 → Next 只判管理员（任何管理员能给全站 465 人发通知）
//   · 申诉审批      Flask 站长 → Next 只判管理员（管理员能裁决针对自己的申诉）
//   · 角色变更      Flask 站长且只做 user→core → Next 管理员就能 curl 出新管理员
//
// 三处的共同点：功能全都正常工作，构建绿、单测绿、页面看起来也对 —— 只有把
// 两边的装饰器逐条摆在一起才看得出来。这个脚本把「摆在一起」自动化。
//
// 用法：npm run check:perms
//
// 【它怎么判】
//   Flask：读 @xxx_bp.route 上方的装饰器栈 → owner_required > admin_required
//          > authenticated_required > login_required > 公开
//   Next ：读 route.ts 里出现的判权函数 → isOwner/requireOwner > hasAdminRights
//          > isCoreUser > getCurrentUser > 公开
//
// 【它不判什么】
//   · 路径映射是人工维护的（下面的 MAP）—— Next 重构了 URL 结构
//     （/auth/login → /login、log_id 进了 URL 路径…），没法可靠地自动对上。
//     新增站长/管理员端点时，请顺手往 MAP 里加一行 —— 漏加会被覆盖率那段揪出来。
//   · **函数体内的判权**。Flask 有 8 处的实际权限高于装饰器所示，例如 feeders/likers
//     写着 @login_required，体内却是 `id != author_id and not has_admin_rights → abort(403)`。
//     这里只读装饰器，所以 Flask 侧的档位可能被**低估**。
//   · Next 侧取的是「文件里出现过的最高档判权函数」。若某路由是
//     `isCoreUser` 兜底 + `hasAdminRights` 只管某个分支（如仅管理员可发的栏目），
//     这里会报成 admin —— 档位被**高估**。两个方向的误差都只会让比对更宽松，
//     所以本脚本只适合当廉价的绊线；真正可靠的是 e2e 里那组「用 role=user 真打接口」的用例
//     （tests/e2e/access-control.spec.ts「核心用户门槛（接口层）」）。
//
// 【已知的有意偏离】记在 EXPECTED_DEVIATIONS 里，附原因。它们不报错，
// 但会打印出来 —— 这样「有意的偏离」和「忘了改」不会混为一谈。
// ─────────────────────────────────────────────────────────────────────────────

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const NEXT_ROOT = path.resolve(HERE, '..');
const FLASK_ROOT = path.resolve(NEXT_ROOT, '..', 'app');

const red = (s) => `\x1b[31m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;
const bold = (s) => `\x1b[1m${s}\x1b[0m`;

const LEVELS = ['public', 'login', 'core', 'admin', 'owner'];
const rank = (l) => LEVELS.indexOf(l);

/**
 * Flask 函数名 → Next 路由。人工维护，见文件头说明。
 *
 * 值的两种写法：
 *   'admin/broadcast'        → API 路由，相对 src/app/api
 *   { page: '/admin/broadcast' } → 页面路由，相对 src/app（守卫可能在 layout 链上，见 scanNextPage）
 */
const MAP = {
  // ── API ──
  send_notification_to_all: 'admin/broadcast',
  send_notification_to_user: 'admin/notify-user',
  decide_appeal: 'admin/appeals/[id]',
  admin_delete_image: 'images/admin/[id]',
  promote: 'admin/users/[id]',
  demote: 'admin/users/[id]',
  ban_user: 'admin/users/[id]',
  unban_user: 'admin/users/[id]',
  admin_delete_blog: 'admin/blogs/[id]',
  update_article_category: 'admin/blogs/[id]',
  update_article_featured: 'admin/blogs/[id]',
  batch_update_category: 'admin/blogs',
  batch_update_featured: 'admin/blogs',

  // ── 页面 ──
  admin_notifications: { page: '/admin/broadcast' },
  send_notification_modal: { page: '/admin/broadcast' },
  admin: { page: '/image/admin' }, // image_hosting 的站长图床管理页
  admin_dashboard: { page: '/admin' },
  manage_articles: { page: '/admin/blogs' },

  // ── core（@authenticated_required）──
  // 这一档整体漏过一次：12 个接口只判了「登录」没判「核心用户」，role=user
  // （注册了但从没用邀请码认证的人）用不了界面却 curl 得动 —— 点赞/建剪贴板/
  // 投票/照片墙/投喂/申诉实测全 200。邀请码体系等于失效。故把它们钉进比对。
  like_toggle: 'blogs/[id]/like',
  feed_fish_api: 'blogs/[id]/feed',
  create_appeal: 'audit/[id]/appeal',
  api_place: 'photowall',
  api_items: 'photowall',
  api_update: 'photowall/[id]',
  create_api: 'votes',
  cast_vote: 'votes/[id]/vote',
  api_quota: 'images/quota',
  delete_image: 'images/[id]',
  user_ban_history: 'users/[id]/ban-history',
};

/**
 * 无需比对的 Flask 端点，附原因。
 * 放这里而不是任其「未覆盖」—— 未覆盖会被当成漏网报错（这正是本脚本的意义）。
 */
const NOT_APPLICABLE = {
  zhh: '智慧河的外链跳转页，Next 侧没有对应实现（首页页脚直接外链 zhh.raricy.com）',
};

/** 已知且有意的偏离：Flask 档位 → Next 档位，附原因。 */
const EXPECTED_DEVIATIONS = {
  'promote|demote': {
    reason:
      'user↔core（页面上的「认证/取消认证」）刻意保留给管理员 —— 日常工作，收到站长会堵死。' +
      '「谁能任命管理员」这条底线仍与 Flask 一致：admin/owner 档位仅站长（见 setRole）。',
  },
};

function walk(dir, ext, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, ext, out);
    else if (p.endsWith(ext)) out.push(p);
  }
  return out;
}

/**
 * 剥掉 Python 的三引号块。
 *
 * ★ 不剥会误报 ★ —— app/web/auth/user_management.py 里整个 delete_user（含
 * @auth_bp.route 和 @owner_required）被 ''' ... ''' 包着注释掉了。裸正则不认字符串
 * 字面量，会把它当成一个活的站长端点，然后报「Next 缺了它 / 权限被放宽」——
 * 而 Flask 压根就没这个路由。本脚本真的这么误报过一次。
 *
 * 剥掉函数体内的合法 docstring 不影响判断：我们只关心 @route 装饰器栈和 def。
 */
function stripPyStrings(txt) {
  return txt.replace(/'''[\s\S]*?'''/g, '').replace(/"""[\s\S]*?"""/g, '');
}

/**
 * 扫 Flask：函数名 → { level, file, ambiguous }
 *
 * ★ 函数名不是唯一的 ★ —— menu 在 vote / image_hosting / game / blog / tool / clipboard
 * 六个蓝图里各有一个，upload 在 blog / clipboard / image_hosting 三处且档位各不相同。
 * 此前这里直接 out[fn] = {...}，后扫到的文件会**静默覆盖**先扫到的：谁映射 upload
 * 都可能拿到另一个模块的档位，然后得出一个看起来很正常的结论。
 * 现在重名的标记成 ambiguous，MAP 引用到它们时直接报错并要求用 '文件::函数名' 消歧。
 */
function scanFlask() {
  const out = {};
  for (const f of walk(FLASK_ROOT, '.py')) {
    const txt = stripPyStrings(fs.readFileSync(f, 'utf8'));
    // 装饰器栈：@bp.route(...) 之后、def 之前的所有 @xxx
    const re = /@\w+\.route\([^)]*\)((?:\s*@[\w.]+(?:\([^)]*\))?)*)\s*def\s+(\w+)/g;
    for (const m of txt.matchAll(re)) {
      const [, decos, fn] = m;
      const level = decos.includes('owner_required')
        ? 'owner'
        : decos.includes('admin_required')
          ? 'admin'
          : decos.includes('authenticated_required')
            ? 'core'
            : decos.includes('login_required')
              ? 'login'
              : 'public';
      const file = path.relative(path.dirname(FLASK_ROOT), f);
      const entry = { level, file };
      // 带文件名的全限定键，用于消歧：'app/web/blog/views.py::upload'
      out[`${file}::${fn}`] = entry;
      if (out[fn] && out[fn].file !== file) out[fn] = { ...out[fn], ambiguous: true };
      else if (!out[fn]) out[fn] = entry;
    }
  }
  return out;
}

/** 扫 Next：路由目录 → level */
function scanNext() {
  const out = {};
  const apiRoot = path.join(NEXT_ROOT, 'src', 'app', 'api');
  for (const f of walk(apiRoot, 'route.ts')) {
    const txt = fs.readFileSync(f, 'utf8');
    // 只看代码，不看注释 —— 注释里常提到 isOwner 之类的词
    const code = txt.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    const level = /\b(isOwner|requireOwner)\s*\(/.test(code)
      ? 'owner'
      : /\b(hasAdminRights|requireAdmin)\s*\(/.test(code)
        ? 'admin'
        : /\b(isCoreUser|requireCoreUser)\s*\(/.test(code)
          ? 'core'
          : /\bgetCurrentUser\s*\(/.test(code)
            ? 'login'
            : 'public';
    out[path.relative(apiRoot, path.dirname(f))] = level;
  }
  return out;
}

/** 从一段源码里判出权限档位。 */
function levelOf(txt) {
  // 只看代码，不看注释 —— 注释里常提到 isOwner 之类的词
  const code = txt.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  if (/\b(isOwner|requireOwner)\s*\(/.test(code)) return 'owner';
  if (/\b(hasAdminRights|requireAdmin)\s*\(/.test(code)) return 'admin';
  if (/\b(isCoreUser|requireCoreUser)\s*\(/.test(code)) return 'core';
  if (/\bgetCurrentUser\s*\(/.test(code)) return 'login';
  return 'public';
}

/**
 * 扫 Next 页面路由：取 page.tsx **及其 layout 链**上的最高档位。
 *
 * ★ 必须走整条 layout 链 ★ —— /admin/broadcast/page.tsx 自己一行守卫都没有，
 * 真正的 requireOwner() 在同目录的 layout.tsx 里；父级 /admin/layout.tsx 又只判到
 * admin。只看 page.tsx 会得出「站长页面只挡了管理员」的错误结论（本人亲测踩过）。
 * 取链上最严的一档，与 Next 的实际行为一致：任一层 layout 拒绝，页面就进不去。
 */
function scanNextPage(routePath) {
  const appRoot = path.join(NEXT_ROOT, 'src', 'app');
  const dir = path.join(appRoot, routePath);
  const page = path.join(dir, 'page.tsx');
  if (!fs.existsSync(page)) return undefined;

  let best = levelOf(fs.readFileSync(page, 'utf8'));
  // 从页面所在目录一路向上找 layout.tsx，直到 src/app
  let cur = dir;
  for (;;) {
    const lay = path.join(cur, 'layout.tsx');
    if (fs.existsSync(lay)) {
      const l = levelOf(fs.readFileSync(lay, 'utf8'));
      if (rank(l) > rank(best)) best = l;
    }
    if (path.resolve(cur) === path.resolve(appRoot)) break;
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return best;
}

const flask = scanFlask();
const nxt = scanNext();

console.log(bold('\n═══ Flask ↔ Next 权限档位比对 ═══\n'));

const problems = [];
const deviations = [];

for (const [fn, route] of Object.entries(MAP)) {
  const f = flask[fn];
  if (!f) {
    console.log(`  ${yellow('?')} Flask 里找不到 ${fn}（可能已删/改名，请更新 MAP）`);
    continue;
  }
  if (f.ambiguous) {
    problems.push(
      `${bold('MAP 键有歧义')}：${fn} 在多个蓝图里都有（如 menu / upload），` +
        `按函数名取到的档位可能是别的模块的。请改用 '文件::函数名'，例如 ` +
        `'app/web/blog/views.py::${fn}'。`
    );
    continue;
  }
  const isPage = typeof route === 'object' && route.page;
  const nLevel = isPage ? scanNextPage(route.page) : nxt[route];
  const shown = isPage ? route.page : `/api/${route}`;
  if (nLevel === undefined) {
    console.log(`  ${yellow('?')} Next 里找不到路由 ${shown}（请更新 MAP）`);
    continue;
  }

  const devKey = Object.keys(EXPECTED_DEVIATIONS).find((k) => k.split('|').includes(fn));
  const line = `${fn} (${f.level}) → ${shown} (${nLevel})`;

  if (rank(nLevel) < rank(f.level)) {
    if (devKey) deviations.push({ line, reason: EXPECTED_DEVIATIONS[devKey].reason });
    else problems.push(`${bold('权限被放宽')}：${line}  —— Flask 要 ${f.level}，Next 只要 ${nLevel}`);
  } else {
    console.log(`  ${green('✓')} ${line}`);
  }
}

// ── 覆盖率：MAP 没提到的高权限端点 ────────────────────────────────────────────
//
// ★ 这段是本脚本最重要的部分 ★
// 在此之前 MAP 只覆盖了 20 个 owner/admin 端点里的 6 个，另外 14 个从没被查过，
// 而脚本照样打印「✅ 没有意料之外的权限放宽」—— 一个只查了三成的检查，报出来的
// 绿比没有检查更危险：它让人以为这块已经看过了。
//
// 所以：任何 owner/admin 档的 Flask 端点，要么在 MAP 里有对应，要么在
// NOT_APPLICABLE 里写明为什么不用比。没交代的一律算失败。
const HIGH = ['owner', 'admin'];
// 只遍历全限定键（file::fn）—— 它对每条路由唯一；短名那份是给 MAP 用的别名，
// 一起遍历会把每个端点数两遍。
const uncovered = Object.entries(flask)
  .filter(([k]) => k.includes('::'))
  .filter(([k, f]) => {
    const fn = k.split('::')[1];
    return (
      HIGH.includes(f.level) &&
      !(fn in MAP) && !(k in MAP) &&
      !(fn in NOT_APPLICABLE) && !(k in NOT_APPLICABLE)
    );
  })
  .map(([k, f]) => `${k.split('::')[1]} (${f.level})  ${f.file}`);

if (uncovered.length) {
  problems.push(
    `${bold('未覆盖的高权限端点')}（${uncovered.length} 个）—— 它们的档位从没被比对过，` +
      `请在 MAP 里补上映射，或在 NOT_APPLICABLE 里写明原因：\n     ` +
      uncovered.join('\n     ')
  );
}

const highTotal = Object.entries(flask).filter(
  ([k, f]) => k.includes('::') && HIGH.includes(f.level)
).length;
const naCount = Object.keys(NOT_APPLICABLE).filter((fn) => flask[fn]).length;
console.log(
  `\n  覆盖：${highTotal - uncovered.length}/${highTotal} 个 owner/admin 端点` +
    `（其中 ${naCount} 个记为无需比对）`
);

if (deviations.length) {
  console.log(bold('\n── 已知的有意偏离 ──'));
  for (const d of deviations) {
    console.log(`  ${yellow('~')} ${d.line}`);
    console.log(`     ${d.reason}`);
  }
}

if (problems.length === 0) {
  console.log(green('\n  ✅ 没有意料之外的权限放宽\n'));
  process.exit(0);
}
console.log(bold('\n── 问题 ──'));
for (const p of problems) console.log(`  ${red('✗')} ${p}`);
console.log(red(`\n  ${problems.length} 处\n`));
process.exit(1);
