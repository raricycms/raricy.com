// checkin-fortune-guard.test.ts —— 静态守卫：「运势值」这套措辞不准回到代码里。
//
// 【它守的是什么】2026-09 站长要求废除签到的抽卡机制、改成固定发 3 条小鱼干，并把站上
// 所有「运势值」相关表述删干净。机制本身有服务层 / 路由 / e2e 的用例盯着（删错了会红），
// 但**措辞没有任何东西会管**：注释、日志、错误文案、接口字段里悄悄写回一句「运势」，
// 构建不报、tsc 管不着、用例也不会红 —— 只会让下一个读代码的人以为那套机制还在。
//
// 【扫描面】`src/` + `scripts/` + `prisma/schema.prisma`。
//   · **不扫 `docs/`**：迁移头与历史注记里会正当提到它（说清「当年是什么、为什么删」），
//     那是历史记录，不是待清理的表述。
//   · **不扫 `prisma/migrations/`**：同理，且那些文件被 checksum 钉死，本就不能改。
//   · 跳过 `compiled/`（`npm run css:probe` 的离线产物，gitignore 的，别拿它当源码）。
//
// 【判据是文件文本，不跑代码】与 db-time-guard / blog-visibility-guard 同款。
// 这是一条**站长要求的措辞纪律**，不是正确性不变式 —— 它红了没有别的修法，删干净即可。

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');

/** 不该再出现的东西（不区分大小写）。 */
const BANNED = /运势|fortune/i;

/** 递归列出源码文件（跳过大目录与生成物）。 */
function sourceFiles(dir: string, exts: string[]): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (['node_modules', '.next', 'compiled', 'migrations'].includes(entry.name)) continue;
      out.push(...sourceFiles(rel, exts));
    } else if (exts.some((e) => entry.name.endsWith(e))) {
      out.push(rel);
    }
  }
  return out;
}

const FILES = [
  ...sourceFiles('src', ['.ts', '.tsx', '.scss']),
  ...sourceFiles('scripts', ['.ts', '.mjs']),
];

describe('「运势值」措辞的静态守卫', () => {
  it('扫描面非空（守卫本身没瞎）', () => {
    expect(FILES.length, '一个文件都没扫到 —— 目录改名了？').toBeGreaterThan(100);
  });

  it('src/ 与 scripts/ 里没有任何 运势 / fortune 字样', () => {
    const offenders: string[] = [];
    for (const f of FILES) {
      const lines = fs.readFileSync(path.join(ROOT, f), 'utf8').split('\n');
      lines.forEach((line, i) => {
        if (BANNED.test(line)) offenders.push(`${f}:${i + 1} — ${line.trim().slice(0, 90)}`);
      });
    }
    expect(
      offenders,
      '这些行又写回了签到抽卡那套措辞（机制已于 2026-09 下线，改成固定发鱼）：\n' +
        offenders.join('\n')
    ).toEqual([]);
  });

  it('prisma/schema.prisma 里没有那三列（列已由迁移 24 删掉）', () => {
    const src = fs.readFileSync(path.join(ROOT, 'prisma/schema.prisma'), 'utf8');
    expect(src).not.toMatch(BANNED);
  });
});
