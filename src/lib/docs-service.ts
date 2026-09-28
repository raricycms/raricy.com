// ─────────────────────────────────────────────────────────────────────────────
// docs-service.ts —— 把一份登记在案的文档读出来、渲染成 HTML（服务端专用）
//
// 【谁在用】`/docs/<...>` 的正文页。索引页只读登记表，不碰磁盘。
//
// 【为什么请求时读盘，而不是构建期静态化】与那 6 个指南页同一口径：`docs/` 跟着
// git pull 走，改好文档重启即生效，不需要为了改一句话重新 build。代价是每次请求
// 读一次盘 —— 几十 KB 的文本，与既有的指南页同量级，不构成问题。
// （**但没有走 MarkdownGuide 那条路**：那条读的是 `docs/guide/` 且带着「读不到就
// 显示一句占位」的兜底。见下面 readDocSource 的注释，这里刻意不要那种兜底。）
//
// 【与前端的分工】`marked` 只在本文件里出现。**HTML 一律当作可信内容**：
// 来源是仓库里的 Markdown，不是用户输入（与 MarkdownGuide 同一条前提）——
// 所以这里不做净化，也不该被拿去渲染任何用户提交的文本。
// ─────────────────────────────────────────────────────────────────────────────

import fs from 'node:fs';
import path from 'node:path';
import { Marked } from 'marked';
import { rewriteDocHref, type DocEntry } from './docs-catalog';

/** 文档根目录。进程 cwd 即项目根（systemd 的 WorkingDirectory / `next start` 的起点）。 */
const DOCS_DIR = ['docs'];

/** 文档在仓库里的路径（`docs/bot/chat-bot.md`）—— 页脚要拿它拼 GitHub 地址。 */
export function docRepoPath(entry: DocEntry): string {
  return [...DOCS_DIR, ...entry.slug.split('/')].join('/') + '.md';
}

function docFilePath(entry: DocEntry): string {
  return path.join(process.cwd(), ...DOCS_DIR, ...entry.slug.split('/')) + '.md';
}

/**
 * 读一份文档的 Markdown 原文。
 *
 * 【刻意不 catch】指南页那边的 `loadGuideHtml` 读不到时返回一句「暂时无法加载」，
 * 那是因为「这份文档在不在」对它是个运行时未知量。这里不是：能走到这一步说明
 * `findDocEntry` 命中了登记表，**文件不在就说明工作区与登记表不一致**（漏了 rsync、
 * 少提交一次 git pull）。那种故障要响 —— 让它抛出去变成 500 并落进 journalctl，
 * 而不是渲染一张看起来正常的页面。守卫 `tests/unit/docs-catalog.test.ts` 会在
 * 部署之前就把它拦下来。
 */
export function readDocSource(entry: DocEntry): string {
  return fs.readFileSync(docFilePath(entry), 'utf-8');
}

/**
 * 渲染一份文档的正文 HTML。
 *
 * 链接改写（相对链接 → 站内页 / 仓库地址）走 `marked` 的 `walkTokens` 钩子：
 * 勾子在**渲染之前**遍历整棵 token 树（含表格单元格、列表项里的行内 token），
 * 改的是 token 本身，于是默认渲染器该做的那部分（href 转义、title、链接文字）
 * 一件不少 —— 比在渲染器里重新拼一遍 `<a>` 稳。
 */
export function renderDocHtml(entry: DocEntry): string {
  const parser = new Marked({
    walkTokens: (token) => {
      if (token.type === 'link') {
        token.href = rewriteDocHref(entry.slug, token.href);
      }
    },
  });
  return parser.parse(readDocSource(entry), { async: false });
}
