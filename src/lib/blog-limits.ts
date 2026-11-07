// ─────────────────────────────────────────────────────────────────────────────
// blog-limits.ts — 博客“标题 / 描述 / 正文”长度上限的**唯一定义**
//
// 为什么单独一个零依赖文件：同一组数字被两端使用 —— 服务端 `validateBlogData`
// （blog-service.ts，拖着 prisma）与客户端发布表单 `BlogForm.tsx`。客户端不能
// import blog-service（会把 prisma/next-headers 打进浏览器包），于是过去两边各写
// 一份（前端 30/100/250000，改一处不报错、只在超限时静默分叉）。
//
// 本文件**禁止 import 任何 service / prisma / node 内置**：它是纯常量模块，客户端
// 与服务端共享。服务端从 blog-service 再导出同名常量，保持既有 import 路径不变。
// ─────────────────────────────────────────────────────────────────────────────

/** 标题上限（字符数，按 UTF-16 code unit 计数，与服务端 `title.length` 同口径）。 */
export const BLOG_TITLE_MAX = 30;

/** 描述上限（字符数，同口径）。 */
export const BLOG_DESCRIPTION_MAX = 100;

/** 正文上限（字符数；2026 年从 200000 放宽到 250000，别在别处再写死）。 */
export const BLOG_CONTENT_MAX = 250000;
