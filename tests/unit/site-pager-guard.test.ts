// 站内分页只有一处实现（静态守卫）。
//
// 【绊的是什么】同一段分页标记曾在六个页面各抄一遍，于是同一个设计漂成四种样子：
// `/blog` 与 `/notifications` 是箭头 + 窗口页码 + 跳页胶囊，`/explore` 少了跳页框，
// `/fish/transactions` 的前后页写成 `«` / `»` 文本，而 `/image/admin` 与
// `/audio/admin` 直接把 `Array.from({ length: pages })` 的**全部页码**平铺出来。
//
// 这类偏离**不会报错**：抄出来的那份自己看着也像分页，只有页数一多才现形
// （一排方块挤满整行、窄屏横向滚），或者只有对着设计稿才发现箭头不对。
// 所以判据必须是文件的**文本**，与 db-time-guard / fish-scale-guard 同款。
//
// 现在页面只提供「第 n 页的地址」，标记住 `src/app/components/SitePager.tsx`，
// 页码窗口的算术住 `src/lib/page-window.ts`。新增列表页时 import 它，别再抄一份。
//
// ⚠️ 管理端 `/admin/*` 用的是另一套 `AdminPager`（`.admin-pager`，无跳页框）——
// 它不在本守卫的判据里，两套并存是刻意的（见 `AdminPager.tsx` 文件头）。

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

/** 递归列出某目录下的源码文件（跳过 node_modules / .next / 迁移与测试产物）。 */
function sourceFiles(dir: string, exts: string[]): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (['node_modules', '.next', 'migrations'].includes(entry.name)) continue;
      out.push(...sourceFiles(rel, exts));
    } else if (exts.some((e) => entry.name.endsWith(e))) {
      out.push(rel);
    }
  }
  return out;
}

/** 唯一允许出现分页标记的两个文件：容器与它的跳页输入框。 */
const ALLOWED = new Set(
  ['src/app/components/SitePager.tsx', 'src/app/components/SitePageJump.tsx'].map((p) =>
    p.replace(/\\/g, '/')
  )
);

/** 手写分页会留下的类名 —— 页面里出现任何一个都说明它自己又画了一套。 */
const MARKERS: { re: RegExp; what: string }[] = [
  { re: /className="pagination"/, what: '<nav className="pagination">' },
  { re: /\bpage-link\b/, what: 'page-link' },
  { re: /\bpage-ellipsis\b/, what: 'page-ellipsis' },
  { re: /\bpage-jump\b/, what: 'page-jump' },
  { re: /\bpage-input\b/, what: 'page-input' },
];

/**
 * 判之前先剥掉注释。
 *
 * 【为什么必须剥】这些文件的注释里**故意**写着违规写法 —— 比如 `SitePager` 的
 * 「别改回去：别再 `Array.from({ length: pages })` 把全部页码铺出来」。
 * 不剥注释，讲规矩的那句话本身就会被判违规，而修它的唯一办法是把解释删掉，
 * 正好把最该留的那段话逼走。
 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '') // 块注释（含 JSX 的 {/* … */}）
    .replace(/^\s*\/\/.*$/gm, ''); // 整行行注释
}

describe('站内分页的唯一实现', () => {
  it('src/app 里没有第二份手写分页标记', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles('src/app', ['.tsx'])) {
      const rel = file.replace(/\\/g, '/');
      if (ALLOWED.has(rel)) continue;
      stripComments(read(file))
        .split('\n')
        .forEach((line, i) => {
          const hit = MARKERS.find((m) => m.re.test(line));
          if (hit) offenders.push(`${rel}:${i + 1}（${hit.what}）`);
        });
    }
    expect(
      offenders,
      `这些地方又手写了分页标记，改用 src/app/components/SitePager.tsx：\n${offenders.join('\n')}`
    ).toEqual([]);
  });

  it('SitePager 走 pageWindow 给窗口，不平铺全部页码', () => {
    const src = stripComments(read('src/app/components/SitePager.tsx'));
    expect(src).toContain('pageWindow');
    // 直接按总页数铺格子是这条守卫前缀下最容易写回来的那种「分页」——
    // 它的症状只有页数多时才可见，所以单独钉一句。
    expect(src, 'SitePager 不许 Array.from({ length: pages }) 平铺全部页码').not.toMatch(
      /Array\.from\(\s*\{\s*length:/
    );
  });
});
