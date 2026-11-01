// ─────────────────────────────────────────────────────────────────────────────
// reactive-migrate-data.ts —— `npm run migrate -- up` 的结构后数据阶段
//
// 由 scripts/migrate.mjs 在 SQL 结构迁移完成后以子进程启动；命令行入口是给迁移器
// 用的，通常不需要手工调用。独立诊断 / 修复仍用：
//   npm run reactive:migrate-v07 [-- --apply]
//   npm run reactive:backfill [-- --apply]
//   npm run search:rebuild
//
// 阶段顺序固定，前一阶段失败就停，绝不打印整体成功：
//   1. 旧 Reactive 正文升级（先预检；blockers 在写库前拦截）
//   2. 历史编译快照回填（Markdown 与当前版本 Reactive）
//   3. 公开正文索引重建（只在正文被升级或索引覆盖不足时执行）
//
// 这些阶段**不是一个跨阶段事务**：v07 的「原文 + 快照 + 一次性标记」仍在它自己的
// 事务里；回填与索引重建都是幂等的，所以中途失败后重跑 `migrate -- up` 可以接续。
// 报告只输出 ID / 类别 / 诊断码，不含正文 / 标题 / 作者。
// ─────────────────────────────────────────────────────────────────────────────

import { Prisma } from '@prisma/client';
import { prisma } from '../src/lib/db';
import { INDEXABLE_VISIBILITIES } from '../src/lib/blog-visibility';
import {
  PUBLIC_SEARCH_VERSION,
  rebuildPublicBlogSearch,
} from '../src/lib/public-blog-search';
import { backfillSnapshots } from '../src/lib/reactive/backfill';
import {
  applyReactiveV07Migration,
  planReactiveV07Migration,
} from '../src/lib/reactive/migrate-v07';

const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;

interface ReportBlocker {
  kind: string;
  id: string;
  codes: string[];
}

function printBlockers(title: string, blockers: ReportBlocker[]): void {
  console.error(red(`[reactive] ${title}（${blockers.length} 项）：`));
  const limit = 100;
  for (const blocker of blockers.slice(0, limit)) {
    console.error(red(`  - ${blocker.kind}:${blocker.id} [${blocker.codes.join(', ')}]`));
  }
  if (blockers.length > limit) {
    console.error(red(`  … 其余 ${blockers.length - limit} 项省略。`));
  }
}

/**
 * 只查「公开正文索引是否有缺口」，不重建。
 *
 * 缺口判据：应有索引的公开文章缺少 state 行、state 版本不是当前版本，或 state 在但
 * FTS 行不在。`body_status='missing'` 不算缺口 —— 它是编译后确实没有可见正文的合法
 * 结果，把它算进来会让每次 up 都重建一遍。
 *
 * ⚠️ 必须把归档作者排除在外：`rebuildPublicBlogSearch` 走的是带归档作用域的 Prisma
 * 客户端，归档作者的博客不会被索引，搜索查询也不返回。这里若把她们算成缺口，
 * 每次 up 都会误判为「索引缺失」并全量重建，永远不收敛。
 */
async function publicSearchNeedsRebuild(): Promise<boolean> {
  const rows = await prisma.$queryRaw<Array<{ missing: bigint | number }>>`
    SELECT COUNT(*) AS missing
    FROM blogs b
    JOIN users u ON u.id = b.author_id
    LEFT JOIN public_blog_search_state s ON s.blog_id = b.id
    WHERE b.ignore = 0
      AND u.archived_at IS NULL
      AND b.visibility IN (${Prisma.join([...INDEXABLE_VISIBILITIES])})
      AND (
        s.blog_id IS NULL
        OR s.version <> ${PUBLIC_SEARCH_VERSION}
        OR NOT EXISTS (SELECT 1 FROM public_blog_search p WHERE p.blog_id = b.id)
      )
  `;
  return Number(rows[0]?.missing ?? 0) > 0;
}

async function run(): Promise<number> {
  // 1) 旧 Reactive 正文升级 ---------------------------------------------------
  const plan = await planReactiveV07Migration();
  if (plan.blockers.length > 0) {
    printBlockers('旧语法升级被阻塞，未写入任何正文；后续阶段不执行', plan.blockers);
    return 1;
  }
  let migratedBlogs = 0;
  if (plan.alreadyApplied) {
    console.log(yellow('[reactive] 旧语法升级：已完成（跳过）'));
  } else {
    migratedBlogs = plan.rows.filter((row) => row.kind === 'blog').length;
    try {
      await applyReactiveV07Migration(plan);
    } catch (error) {
      console.error(red(`[reactive] 旧语法升级提交失败：${error instanceof Error ? error.message : String(error)}`));
      console.error(yellow('[reactive] 该阶段自带事务；失败时正文 / 快照 / 标记均未提交。后续阶段不执行。'));
      return 2;
    }
    console.log(green(`[reactive] 旧语法升级：${plan.rows.length} 篇正文（原文 + 快照 + 标记同一事务）`));
  }

  // 2) 历史编译快照回填 -------------------------------------------------------
  let backfill;
  try {
    backfill = await backfillSnapshots(prisma, { apply: true });
  } catch (error) {
    console.error(red(`[reactive] 快照回填意外失败：${error instanceof Error ? error.message : String(error)}`));
    return 3;
  }
  const summary = backfill.summary;
  console.log(
    `[reactive] 快照回填：scanned=${summary.scanned} skipped=${summary.skipped} ` +
      `refreshed=${summary.refreshed} written=${summary.written} ` +
      `blocked=${summary.blocked} failed=${summary.failed}`
  );
  if (summary.blocked > 0 || summary.failed > 0 || backfill.blockers.length > 0) {
    printBlockers('快照回填存在阻塞 / 失败，后续索引重建不执行', backfill.blockers);
    return 3;
  }

  // 3) 公开正文索引：只在必要时重建 ------------------------------------------
  // **跨运行恢复靠 PUBLIC_SEARCH_VERSION 里持久化的编译签名**：一次运行刷新了快照
  // 却在索引阶段失败时，state 仍是旧签名，下一次 up 即使 refreshed=0 也会按版本不等
  // 重建。下面的 refreshed 只是同一次运行的附加触发（覆盖人工篡改快照等边缘情况），
  // 不是恢复依据。
  const compileSignatureChanged = summary.refreshed > 0;
  let needsRebuild: boolean;
  try {
    needsRebuild = await publicSearchNeedsRebuild();
  } catch (error) {
    console.error(red(`[search] 无法检查公开索引覆盖：${error instanceof Error ? error.message : String(error)}`));
    return 4;
  }
  if (!needsRebuild && migratedBlogs === 0 && !compileSignatureChanged) {
    console.log(yellow('[search] 公开索引：已是最新（跳过）'));
    return 0;
  }
  const reasons = [
    migratedBlogs > 0 ? '正文已升级' : null,
    compileSignatureChanged ? '快照编译签名已变化' : null,
    needsRebuild ? '索引缺失或版本不一致' : null,
  ].filter(Boolean).join('；');
  try {
    const count = await rebuildPublicBlogSearch(prisma);
    console.log(green(`[search] 公开索引：已重建 ${count} 篇（${reasons}）`));
  } catch (error) {
    console.error(red(`[search] 公开索引重建失败：${error instanceof Error ? error.message : String(error)}`));
    return 4;
  }

  return 0;
}

// 【必须 top-level await】vite-node 在模块同步求值结束后就会关闭 Vite server；
// 若把 run() 当浮动 Promise，阶段 3 的 `await import('reactive-md')` 可能落在
// server 关闭之后。失败还可能被 publicBodyText 吞成 body_status='missing'，
// 数据阶段却以 0 退出。等它真正结束再让模块完成求值。
try {
  const code = await run();
  if (code !== 0) {
    console.error(red(`[reactive] 数据阶段未完成（退出码 ${code}）。`));
    process.exitCode = code;
  } else {
    console.log(green('[reactive] 数据阶段完成。'));
  }
} catch (error) {
  console.error(red('[reactive] 数据阶段未捕获异常：'), error);
  process.exitCode = 9;
} finally {
  await prisma.$disconnect().catch(() => {});
}
