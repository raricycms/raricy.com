// ─────────────────────────────────────────────────────────────────────────────
// navigation-back.ts —— 文章页「返回上页」的落点判据（纯函数，**零依赖**）
//
// 【为什么要它】iOS「添加到主屏幕」后从主屏图标冷启（standalone）时，这个标签页里
// **没有上一页**：`window.history.length` 为 1，`history.back()` 是**静默的空操作**
// —— 按钮看着能点、点了没有任何反应，用户被困在文章页。同一件事在「把文章链接发到
// 别处、对方从外部点开」时也可能发生（对方那一页同样没有本站历史）：
// 此时 back() 要么无果，要么把人送出站。
//
// 【判据为什么只看 history.length】`document.referrer` 在 App Router 的**客户端
// 跳转里不会更新** —— 它记的是「本文档那次整页加载的来路」，之后在站内翻多少页都不
// 变。拿它判「上一页在不在站内」会在「外站进来 → 站内翻了几页」时误判，把正常的
// 「返回上一页」改成「跳列表」——那是对**普通浏览**的行为倒退，正是这条要避免的。
// 只用 `history.length` 就够：> 1 表示这个标签页里确实存在上一条记录，back() 有处可去。
//
// 【零依赖】FeedButton 是客户端组件，这条判据要被它 import，不能顺带拖进任何
// 服务端模块（同 `blog-visibility` / `market-leverage` 那条纪律 —— 拖着 prisma 的
// 模块进不了客户端包）。
// ─────────────────────────────────────────────────────────────────────────────

/** 站内兜底落点：core+ 回博客列表，其余回对外可见的 /explore（与顶栏「博客」入口同一条分流）。 */
export const BACK_FALLBACK_CORE = '/blog';
export const BACK_FALLBACK_GUEST = '/explore';

export type BackTarget =
  /** 历史记录多于一条：沿用 `history.back()`，不猜测上一条记录的来源。 */
  | { kind: 'history-back' }
  /** 没有上一页：跳到一个确定存在的站内页面。 */
  | { kind: 'navigate'; href: string };

/**
 * 决定「返回上页」是 back() 还是跳一个确定存在的站内页面。
 *
 * @param historyLength `window.history.length`（当前标签页的历史条数）
 * @param isCore        当前查看者是否 core+ —— 决定兜底落 `/blog` 还是 `/explore`
 */
export function decideBackTarget(input: {
  historyLength: number;
  isCore: boolean;
}): BackTarget {
  // > 1 才存在上一页。为 1（或异常地更小）时 back() 无处可去，落回站内列表 ——
  // 否则那个按钮在 A2HS 冷启 / 外链点开时就是个死按钮。
  if (input.historyLength > 1) return { kind: 'history-back' };
  return {
    kind: 'navigate',
    href: input.isCore ? BACK_FALLBACK_CORE : BACK_FALLBACK_GUEST,
  };
}
