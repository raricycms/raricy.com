// ─────────────────────────────────────────────────────────────────────────────
// cli-docs.test.ts —— 静态检查：docs/cli.md 必须覆盖注册表里的每条命令
//
// 【为什么要有】这正是这套 CLI 重构前的老毛病：docs/cli.md 里有一整节讲
// `RULES.fishAdmin` 限频，而那个规则**早就不存在了**；还提到一个从来没实现过的
// `--batch-id`；反过来 `fish sync-retry` 实现了却没写进文档。
//
// 文档漂移是静默的 —— 没有人会因为文档过时而收到报错，只会在照着敲的时候发现
// 命令不对。所以把它钉成会红的东西：注册表加了命令而文档没跟上，这里直接失败。
//
// 这条守卫**只管「有没有提到」**，不管内容对不对（那要靠人）。名字一律是
// 「域 + 子命令」的形式，在文档里以子串出现即可（例如表里的 `blog search [关键词]`）。
// ─────────────────────────────────────────────────────────────────────────────

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { COMMANDS } from '../../scripts/cli/registry';

const ROOT = path.resolve(import.meta.dirname, '../..');
const DOC = path.join(ROOT, 'docs', 'cli.md');

const doc = fs.readFileSync(DOC, 'utf8');

describe('docs/cli.md 覆盖度', () => {
  it('★ 注册表里每条命令都在文档里出现过', () => {
    const missing = COMMANDS.map((c) => c.name).filter((name) => !doc.includes(name));
    expect(
      missing,
      `这些命令没有写进 docs/cli.md：\n  ${missing.join('\n  ')}\n加了命令就补文档，否则运维照着文档敲会踩空。`
    ).toEqual([]);
  });

  it('文档里提到的每个 CLI 命令都能在注册表里找到（反向检查，防手写残留）', () => {
    // 只认形如 `域 子命令` 的代码内联写法，避免把正文里的普通词当成命令
    const mentioned = new Set(
      [...doc.matchAll(/`([a-z][a-z-]+ [a-z][a-z-]+)/g)].map((m) => m[1])
    );
    const names = new Set(COMMANDS.map((c) => c.name));
    // 文档里会提到别的多词概念（`npm run`、`role set` 之类），只挑出看起来像命令域的
    const domains = new Set(COMMANDS.map((c) => c.name.split(' ')[0]));
    const unknown = [...mentioned].filter(
      (m) => domains.has(m.split(' ')[0]) && !names.has(m)
    );
    expect(unknown, `文档提到了不存在的命令：\n  ${unknown.join('\n  ')}`).toEqual([]);
  });
});
