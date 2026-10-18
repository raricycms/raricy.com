// ─────────────────────────────────────────────────────────────────────────────
// agent-instructions.test.ts —— 静态检查：AGENTS.md 仍是 CLAUDE.md 的软链接
//
// 【绊的是什么】仓库指引只有一份内容：`CLAUDE.md` 是真文件，`AGENTS.md` 是指向它的
// 软链接（Codex 等只认 `AGENTS.md` 的工具读同一份）。git 以 mode 120000 记录链接，
// blob 里就是 9 字节的目标路径 `CLAUDE.md`（没有换行）。
//
// ⚠️ **Windows 上这条链接会静默退化**：Git for Windows 的 system 级
// `core.symlinks=false`（安装默认值），检出时软链接被展开成一个普通文本文件 ——
// 内容恰好是 `CLAUDE.md` 这 9 个字符。`git status` 照旧干净（git 认为「内容就是
// 链接目标」），编辑器里只是个 9 字节文件，而**只有读 `AGENTS.md` 的 agent 会中招**：
// 它拿到的仓库指引变成一个词，没有任何报错、日志或 500。本机实测踩过一次
// （2026-10-18 拉取把 AGENTS.md 改成软链接的那个提交之后）。
//
// 修法是改检出配置、不是改代码：
//
//     git config --global core.symlinks true   # 覆盖 Git for Windows 的 system 默认
//     Remove-Item AGENTS.md                    # cmd: del AGENTS.md
//     git checkout -- AGENTS.md                # 重新检出成真正的软链接
//
// 【为什么值得一条守卫】这个退化不会让任何页面、构建或接口出错，除本测试外没有
// 任何东西能发现它；而它恰好打在「下一个 agent 读仓库约定」这条路上 —— 静默、
// 且后果是 agent 空手开工。判据两条：
//   1. `AGENTS.md` 的 lstat 是软链接、目标是 `CLAUDE.md`。退化（普通文件）与
//      「好心改成复制品」都会在这里红 —— 复制品会重新引入 drift，正是这条链接
//      要消灭的东西。
//   2. 两边读到的字节完全一致。软链接下这恒真，但一条显式断言能把「链接指向了
//      别处/坏了」与「内容真的不同」分开报。
//
// 【不检查什么】`CLAUDE.md` 的正文内容与章节（那是文档的事，互指由 docs-xref 管）。
// 这里只管「两份名字、一份内容」这个结构本身。
// ─────────────────────────────────────────────────────────────────────────────

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');
const CLAUDE = path.join(ROOT, 'CLAUDE.md');
const AGENTS = path.join(ROOT, 'AGENTS.md');

/** 失败信息里带上完整修复步骤：这条红只可能是检出配置问题，不是代码问题。 */
const FIX_HINT = [
  'AGENTS.md 必须是 CLAUDE.md 的软链接，但当前检出不满足（多半是 Windows 的 core.symlinks=false 把链接展开成了 9 字节文本文件）。',
  '',
  '这是检出配置问题，不是代码问题。修复：',
  '  git config --global core.symlinks true',
  '  Remove-Item AGENTS.md      # cmd: del AGENTS.md',
  '  git checkout -- AGENTS.md',
  '',
  '不要把它改成两份真文件（复制品会重新 drift）。',
].join('\n');

describe('AGENTS.md → CLAUDE.md 的软链接', () => {
  it('AGENTS.md 是指向 CLAUDE.md 的软链接，不是普通文件 / 复制品', () => {
    expect(fs.existsSync(AGENTS), FIX_HINT).toBe(true);
    const stat = fs.lstatSync(AGENTS);
    expect(stat.isSymbolicLink(), FIX_HINT).toBe(true);
    // git 存的是相对路径；Windows 上偶尔会回填反斜杠，统一成正斜杠再比。
    expect(fs.readlinkSync(AGENTS).replace(/\\/g, '/'), FIX_HINT).toBe('CLAUDE.md');
  });

  it('AGENTS.md 与 CLAUDE.md 读到的是同一份字节', () => {
    expect(fs.readFileSync(AGENTS).equals(fs.readFileSync(CLAUDE)), FIX_HINT).toBe(true);
  });

  it('CLAUDE.md 仍是真文件（指引本体不能反过来退化成链接，否则会成环）', () => {
    const stat = fs.lstatSync(CLAUDE);
    expect(stat.isSymbolicLink()).toBe(false);
    expect(stat.size, 'CLAUDE.md 不应是空文件 —— 指引本体不能空着').toBeGreaterThan(1024);
  });
});
