// ─────────────────────────────────────────────────────────────────────────────
// broadcast-groups.ts — 群发通知的目标用户组（**单一真相源**）
//
// 三个消费者：broadcast-service 的 where 分支、POST /api/admin/broadcast 的参数
// 校验、/admin/broadcast 页面的「目标用户群」下拉。此前页面与路由各抄一份数组，
// 新增组名时漏改任一处都会表现为「路由把新组当非法值静默回落 all → 全站群发」
// （R3-417），所以只能有一份。
//
// 为什么单独一个零依赖模块：页面是 'use client' 组件，若从 broadcast-service 取，
// 会把 Prisma / notification-service 拖进浏览器包。本文件只含常量与纯函数。
// ─────────────────────────────────────────────────────────────────────────────

export const TARGET_GROUPS = [
  { value: 'all', label: '所有用户' },
  { value: 'authenticated', label: '认证用户' },
  { value: 'normal', label: '普通用户' },
] as const;

export type TargetGroup = (typeof TARGET_GROUPS)[number]['value'];

/** 运行时判定（路由收到的是未校验的 JSON，不能只靠类型）。 */
export function isTargetGroup(value: unknown): value is TargetGroup {
  return TARGET_GROUPS.some((g) => g.value === value);
}
