// ─────────────────────────────────────────────────────────────────────────────
// audit-context.ts —「这条审计日志是谁写下的」
//
// 【为什么需要区分】`npm run cli` 是**站长在后台自己动手**，与网页端的操作不是一回事：
// 网页端写下的是「管理员操作日志公示」（顶栏「日志」→ /audit），后台运维的批量操作
// 不该在那张公示页上刷屏 —— 所以后台写下的日志一律落 visibility='internal'。
//
// 【但绝不「干脆不记」】那等于把审计链自己剪断：谁也说不清某个角色是谁改的、
// 某个人是谁禁的言。内部日志仍然进库，`npm run cli -- audit log --visibility internal`
// （或 --visibility all）查得到，只是不进 /audit。
//
// 【为什么用 AsyncLocalStorage，而不是给每个 service 加入参】全站有近二十处
// logAdminAction 调用点，散在八个 service 里。逐个加一个 visibility 入参 = 把这条纪律
// 摊到每一条写路径上：将来新加一条命令忘了传，就**静默**变回公开日志，而且没有任何
// 报错。收在两个点上 —— 漏斗（admin-user-service 的 logAdminAction）与入口
// （scripts/cli.ts）—— 新增命令自动继承。
//
// 【为什么是这里而不是 CLI 自己写日志】CLI 调的就是网页端那一批 service
// （setRole / banUser / adjudicate / restoreBlog… 的审计都在 service 内部完成），
// CLI 这边根本没有「自己插一条日志」的位置。
//
// 用异步上下文而不是一个模块级布尔量：作用域跟着这一次命令执行走，跑完即失效，
// 不会因为谁忘了复位而把整个进程（或测试）带偏。
// ─────────────────────────────────────────────────────────────────────────────

import { AsyncLocalStorage } from 'node:async_hooks';

/** 当前是否在「后台运维」的上下文里。 */
const store = new AsyncLocalStorage<{ source: 'backend-ops' }>();

/**
 * 把一次后台运维的执行圈起来（入口：`scripts/cli.ts`）。
 *
 * 圈内所有写库路径留下的审计日志都是 `visibility='internal'`：命令式与交互式
 * 两个前端都从这一处进出，所以新增入口不会漏。
 */
export function runAsBackendOps<T>(fn: () => Promise<T>): Promise<T> {
  return store.run({ source: 'backend-ops' }, fn);
}

/**
 * 没显式传 visibility 时，这条审计日志该落成什么。
 *
 *   网页端 → 'public'（进 /audit 公示页，用户可以申诉）
 *   后台运维 → 'internal'（只进 `npm run cli -- audit log`）
 *
 * 调用方自己传了 `visibility` 就按调用方的来 —— 这里只提供缺省值。
 */
export function defaultLogVisibility(): 'public' | 'internal' {
  return store.getStore()?.source === 'backend-ops' ? 'internal' : 'public';
}
