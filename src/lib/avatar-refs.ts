// ─────────────────────────────────────────────────────────────────────────────
// avatar-refs.ts — 头像地址的**唯一**出处（零依赖，浏览器侧也能 import）
//
// 【为什么单独一个文件，而不是塞进 avatar.ts】
// `avatar.ts` 顶部 `import { readFile } from 'node:fs/promises'` —— 它是 server-only 的
// 解析器（读 instance/avatars/**、兜底生成 identicon）。客户端组件 import 它的**任何**
// 运行时值都会炸构建，哪怕只要一个字符串。所以「URL 长什么样」这条纯知识必须住在
// 一个不碰 fs 的模块里。
//
// 【为什么值得一个文件】这条 `/api/avatar/<id>` 以前在 15 处各写各的模板串
// （DTO 里、页面里、内联 style 旁边）。模板串写错**不报错** —— 只是那张图 404，
// 而 404 在头像链路上是**静默**的：`/api/avatar/[id]` 永不 404（读不到文件就生成
// identicon），所以拼错了 id 只会得到一张「长得像但不是他」的 identicon，
// 没人会注意到。收敛到一处之后，全仓只有这里能拼这个串
//（tests/unit/avatar-sites-guard.test.ts 静态拦着）。
//
// ⚠️ 别名：`next.config.mjs` 的 rewrites 把老地址 `/auth/avatar/:id` 指到同一条路由
//    （存量正文里写死的旧直链，别删）。那个别名**不出现在这里** —— 它是历史兼容，
//    不是可以拿来生成新链接的写法。
// ─────────────────────────────────────────────────────────────────────────────

/** 头像字节路由的路由前缀。 */
export const AVATAR_URL_PREFIX = '/api/avatar/';

/**
 * 某个用户的头像地址。
 *
 * 不需要编码：id 是 UUID4（见 `docs/architecture.md` §8 的 ID 风格），
 * 字符集是 `[0-9a-f-]`，`encodeURIComponent` 恒等。
 *
 * 空 id 不抛也不返回空串 —— 调用方拿到的仍是一个合法 URL，只是那张 identicon
 * 不属于任何人。**这是刻意的**：抛异常会把「某个 DTO 少带了一个 id」这种数据问题
 * 升级成 500，而那类问题应该在那条 DTO 的测试里被抓住，不该炸整页。
 */
export function avatarUrl(id: string): string {
  return `${AVATAR_URL_PREFIX}${id}`;
}
