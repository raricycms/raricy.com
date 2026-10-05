// ─────────────────────────────────────────────────────────────────────────────
// audit-action-guard.test.ts —— 静态检查：写进 `AdminActionLog.action` 的码，
// 必须登记在 `src/lib/audit-actions.ts` 的 `AUDIT_ACTIONS` 里。
//
// 【为什么要有】动作码永远是裸字符串，散在 8 个 service + CLI 命令里。漏登记一个的
// 后果**全是静默的**：那一类在 `/audit` 上退回英文机器码、在筛选下拉里选不到、
// 在 `/admin/logs` 的 chip 上没颜色。构建不失败、tsc 管不着（字符串）、e2e 只钉它
// 自己那几个选择器 —— 没有任何东西会报警。改版前界面上的映射有 4 份手工副本、
// 覆盖 4~5 个码，正是这么来的。这条守卫把它变成一次编译期性质的红。
//
// 【判据】扫 `src/**` 与 `scripts/cli/commands/**`（后者是 `frame_*` 两个码的家），
// 取 `action: '<ascii>'` 形式的字面量，跳过注释行。取值限定 ASCII snake_case，
// 于是 `sendNotification({ action: '禁言通知' })` 那 11 个中文通知标签天然不入围 ——
// 它们与动作共用了 `action` 这个键名，是这条守卫最容易误伤的地方。
//
// 【台账纪律】`AdminUserActions.tsx` 里的 `action: 'ban' / 'unban'` 是
// `POST /api/admin/users/:id` 的**载荷码**（前端告诉路由「干哪件事」），
// 不是 `AdminActionLog.action`。它们必须留在 `NON_AUDIT_LITERALS` 里并写明理由；
// 台账行一旦在扫描面里找不到对应字面量就转红（提醒删掉过期的一行）。
// ─────────────────────────────────────────────────────────────────────────────

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import { AUDIT_ACTIONS } from '@/lib/audit-actions';

const ROOT = path.resolve(import.meta.dirname, '../..');
const SCAN_ROOTS = [path.join(ROOT, 'src'), path.join(ROOT, 'scripts', 'cli', 'commands')];

const AUDIT_SET = new Set<string>(AUDIT_ACTIONS);

/** 用了 `action:` 键、但不是审计动作码的 ASCII 字面量。每条都要写明为什么。 */
const NON_AUDIT_LITERALS = new Map<string, string>([
  ['ban', 'POST /api/admin/users/:id 的载荷码（前端 → 路由的动作名），不是 AdminActionLog.action'],
  ['unban', '同上'],
]);

/**
 * 有意退役、但为历史日志仍留在 `AUDIT_ACTIONS` 白名单里的码 —— 它们不再有任何写入方。
 * 今天为空。加进来时请连同「为什么退役」写一行。
 */
const RETIRED_ACTIONS: readonly string[] = [];

function isCommentLine(line: string): boolean {
  const t = line.trim();
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*');
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) sourceFiles(full, out);
    else if (/\.tsx?$/.test(e.name)) out.push(full);
  }
  return out;
}

/** 返回 hits（非白名单码）与 codes（扫描面里出现过的全部 ASCII 动作码，含台账项）。 */
function scan(text: string, rel: string): { hits: string[]; codes: Set<string> } {
  const hits: string[] = [];
  const codes = new Set<string>();
  const re = /action\s*:\s*['"]([a-z][a-z0-9_]*)['"]/g; // 每次新建，避免 /g 的 lastIndex 串味
  text.split(/\r?\n/).forEach((line, i) => {
    if (isCommentLine(line)) return;
    for (const m of line.matchAll(re)) {
      const code = m[1];
      codes.add(code);
      if (!AUDIT_SET.has(code) && !NON_AUDIT_LITERALS.has(code)) {
        hits.push(`${rel}:${i + 1}: ${line.trim()}`);
      }
    }
  });
  return { hits, codes };
}

function scanSurface(): { hits: string[]; codes: Set<string>; files: string[] } {
  const files = SCAN_ROOTS.flatMap((d) => sourceFiles(d));
  const hits: string[] = [];
  const codes = new Set<string>();
  for (const f of files) {
    const rel = path.relative(ROOT, f).split(path.sep).join('/');
    const r = scan(fs.readFileSync(f, 'utf8'), rel);
    hits.push(...r.hits);
    for (const c of r.codes) codes.add(c);
  }
  return { hits, codes, files };
}

describe('audit-action-guard', () => {
  it('全仓扫描：没有未登记的动作码', () => {
    const { hits } = scanSurface();
    expect(
      hits,
      '写进 AdminActionLog.action 的码必须登记进 src/lib/audit-actions.ts 的 AUDIT_ACTIONS。\n' +
        '若它其实不是审计动作（如 API 载荷码），登记进本文件的 NON_AUDIT_LITERALS 并写明理由：\n  ' +
        (hits.join('\n  ') || '（无）')
    ).toEqual([]);
  });

  it('双向对账：表里的码都有写入方，扫描面的码都进了表', () => {
    const { codes } = scanSurface();
    const missingWriter = AUDIT_ACTIONS.filter(
      (a) => !codes.has(a) && !RETIRED_ACTIONS.includes(a)
    );
    expect(
      missingWriter,
      '这些码在 AUDIT_ACTIONS 里，但扫描面里找不到任何写入方 —— 多半是拼错了。\n' +
        '若是有意退役（为历史日志保留白名单），登记进 RETIRED_ACTIONS：\n  ' +
        (missingWriter.join('\n  ') || '（无）')
    ).toEqual([]);

    // 台账新鲜度：退役项与豁免项都必须真的「不再/从未」以动作字面量出现。
    for (const r of RETIRED_ACTIONS) {
      expect(AUDIT_SET.has(r), `RETIRED_ACTIONS 的 ${r} 不在 AUDIT_ACTIONS 里`).toBe(true);
      expect(codes.has(r), `RETIRED_ACTIONS 的 ${r} 仍有写入方 —— 该从退役名单里删掉`).toBe(false);
    }
    for (const [lit] of NON_AUDIT_LITERALS) {
      expect(codes.has(lit), `NON_AUDIT_LITERALS 的 ${lit} 在扫描面里找不到了 —— 删掉这行台账`).toBe(
        true
      );
    }
  });

  it('★ 产出自检 ★ 扫描面非空，且覆盖两个必到的文件', () => {
    const { files } = scanSurface();
    expect(files.length, '扫描面太小，守卫等于没开').toBeGreaterThan(100);
    const rels = files.map((f) => path.relative(ROOT, f).split(path.sep).join('/'));
    expect(rels).toContain('src/lib/admin-user-service.ts');
    expect(rels).toContain('scripts/cli/commands/frames.ts');
  });

  it('★ 产出自检 ★ 合成样本里未登记的码会被抓出来', () => {
    const sample = [
      `const a = { action: 'not_a_real_code' };`,
      `logAdminAction({ action: 'frame_grant' });`,
    ].join('\n');
    const { hits, codes } = scan(sample, 'sample.ts');
    expect(hits).toHaveLength(1);
    expect(hits[0]).toContain('not_a_real_code');
    expect(codes.has('frame_grant')).toBe(true);
  });

  it('★ 产出自检 ★ 注释 / 中文标签 / 白名单 / 台账都不产出 hit', () => {
    const ok = [
      `// action: 'not_a_real_code'`,
      `* action: 'not_a_real_code'`,
      `/* action: 'not_a_real_code' */`,
      `sendNotification({ action: '禁言通知' });`, // 中文 → 不匹配 [a-z]
      `sendNotification({ action: '文章点赞' });`,
      `logAdminAction({ action: 'ban_user' });`, // 白名单
      `api.post({ action: 'ban' });`, // 台账项
    ].join('\n');
    expect(scan(ok, 'ok.ts').hits).toEqual([]);
  });
});
