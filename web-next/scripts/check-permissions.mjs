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
// 【它不判什么】路径映射是人工维护的（下面的 MAP）—— Next 重构了 URL 结构
// （/auth/login → /login、log_id 进了 URL 路径…），没法可靠地自动对上。
// 新增站长/管理员端点时，请顺手往 MAP 里加一行。
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

/** Flask 函数名 → Next 路由目录（相对 src/app/api）。人工维护，见文件头说明。 */
const MAP = {
  send_notification_to_all: 'admin/broadcast',
  send_notification_to_user: 'admin/notify-user',
  decide_appeal: 'admin/appeals/[id]',
  admin_delete_image: 'images/admin/[id]',
  promote: 'admin/users/[id]',
  demote: 'admin/users/[id]',
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

/** 扫 Flask：函数名 → { level, file } */
function scanFlask() {
  const out = {};
  for (const f of walk(FLASK_ROOT, '.py')) {
    const txt = fs.readFileSync(f, 'utf8');
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
      out[fn] = { level, file: path.relative(path.dirname(FLASK_ROOT), f) };
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
  const nLevel = nxt[route];
  if (nLevel === undefined) {
    console.log(`  ${yellow('?')} Next 里找不到路由 ${route}（请更新 MAP）`);
    continue;
  }

  const devKey = Object.keys(EXPECTED_DEVIATIONS).find((k) => k.split('|').includes(fn));
  const line = `${fn} (${f.level}) → /api/${route} (${nLevel})`;

  if (rank(nLevel) < rank(f.level)) {
    if (devKey) deviations.push({ line, reason: EXPECTED_DEVIATIONS[devKey].reason });
    else problems.push(`${bold('权限被放宽')}：${line}  —— Flask 要 ${f.level}，Next 只要 ${nLevel}`);
  } else {
    console.log(`  ${green('✓')} ${line}`);
  }
}

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
