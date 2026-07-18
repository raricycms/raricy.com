#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// check-secrets.mjs —— 密钥与生产数据有没有进版本库
//
// 【为什么要有】手册原先只让人「顺手确认一下」`git log -S "$SECRET_KEY"`。
// 但这类事一次性查过不等于以后不会犯 —— 下次谁手滑 `git add .` 把 .env 提交了，
// 没有任何东西会拦。而这个仓库里最贵的两样东西恰好都在版本库外面：
//   · SECRET_KEY —— 465 个用户的鱼干密钥由它派生
//   · data/     —— 465 个真实用户、6183 篇文章、986 张图
// 一旦进了历史，git 是不会忘的。
//
// 用法：npm run check:secrets
// 退出码：0 干净；1 发现问题。
// ─────────────────────────────────────────────────────────────────────────────

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const bold = (s) => `\x1b[1m${s}\x1b[0m`;

const git = (args) => {
  try {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  } catch {
    return '';
  }
};

let fail = 0;
const ok = (m) => console.log(`  ${green('✓')} ${m}`);
const bad = (m, fix) => {
  fail++;
  console.log(`  ${red('✗')} ${m}`);
  if (fix) console.log(`     \x1b[33m→ ${fix}\x1b[0m`);
};

console.log(bold('\n═══ 密钥 / 生产数据泄露检查 ═══\n'));

// ── 1. 敏感文件有没有进过历史 ───────────────────────────────────────────────
// 用 --all：只看当前分支不够，删掉的分支或旧提交里一样是泄露。
const everTracked = new Set(
  git(['log', '--all', '--pretty=format:', '--name-only']).split('\n').map((s) => s.trim()).filter(Boolean)
);

const LEAKS = [
  { re: /(^|\/)\.env$|(^|\/)\.env\.(local|production|prod)$/, what: '.env（含 SECRET_KEY）' },
  { re: /\.(db|sqlite|sqlite3)$/, what: '数据库文件' },
  { re: /^(data|instance)\//, what: '生产数据目录' },
];
for (const { re, what } of LEAKS) {
  const hits = [...everTracked].filter((f) => re.test(f));
  if (hits.length) {
    bad(
      `${what} 进过版本库：${hits.slice(0, 3).join(', ')}${hits.length > 3 ? ` 等 ${hits.length} 个` : ''}`,
      'git 不会忘 —— 从历史里彻底移除（git filter-repo），并把泄露的密钥全部轮换'
    );
  } else {
    ok(`${what} 从未进过版本库`);
  }
}

// ── 2. 现在的 .gitignore 盖住了吗 ───────────────────────────────────────────
// 历史干净只说明过去没犯；ignore 没盖住的话，下一次 `git add .` 就会犯。
const MUST_IGNORE = [
  'instance/database/db.db',
  '.env',
  '.env.production',
  'prisma/dev.db',
];
for (const p of MUST_IGNORE) {
  try {
    execFileSync('git', ['check-ignore', '-q', p], { cwd: ROOT });
    ok(`${p} 已被 .gitignore 盖住`);
  } catch {
    bad(`${p} 没被 .gitignore 盖住 —— 下次 git add . 就会提交它`, '加进 .gitignore');
  }
}

// ── 3. 代码里有没有硬编码的真密钥 ───────────────────────────────────────────
// 只扫**当前工作树**：历史那部分上面已经查过了。
const tracked = git(['ls-files']).split('\n').filter(Boolean);
// 测试文件天然充满假凭据（`SECRET_KEY = 'a-different-secret'` 之类），扫它们只会
// 产出噪音 —— 而一个总在误报的检查，下场就是被所有人忽略，等于没有。
// 真密钥藏在测试里属于极异常情况，且上面「历史 + gitignore」那两道才是主防线。
const SKIP = /(^|\/)(node_modules|\.next|dist|venv|tests?|__tests__)\/|\.(test|spec)\.[tj]sx?$/;
const ASSIGN = /\b(SECRET_KEY|INTERNAL_TOKEN|ACCOUNT_SYSTEM_KEY|FISH_ENCRYPTION_KEY|PRIVATE_KEY)\b\s*[:=]\s*['"]([^'"]{12,})['"]/g;
// 明显是占位/测试的值不算
const BENIGN = /example|placeholder|换成|xxx+|your[-_]|<.*>|^test|test-|dev-|e2e|not-?real|smoke|fake|dummy|生产的/i;

let hard = 0;
for (const f of tracked) {
  if (SKIP.test(f)) continue;
  if (!/\.(ts|tsx|js|mjs|cjs|py|json|ya?ml|env\.example)$/.test(f)) continue;
  const txt = git(['show', `HEAD:${f}`]);
  for (const m of txt.matchAll(ASSIGN)) {
    if (BENIGN.test(m[2])) continue;
    hard++;
    bad(`${f} 里疑似硬编码密钥：${m[1]} = "${m[2].slice(0, 8)}…"`, '挪进 .env，并轮换这个值');
  }
}
if (!hard) ok('代码里没有硬编码的真密钥（占位与测试值已排除）');

console.log(bold('\n═══ 结论 ═══'));
if (fail) {
  console.log(red(`  ❌ ${fail} 项有问题\n`));
  process.exit(1);
}
console.log(green('  ✅ 密钥与生产数据都没进版本库，且 .gitignore 盖得住\n'));
