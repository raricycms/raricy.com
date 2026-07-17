// E2E 种子数据的**唯一**事实来源：global-setup 按此建库，各 spec 按此断言。
// 常量集中在这里，避免用例里散落魔法字符串（改个用户名要翻六个文件）。

/** 所有种子用户共用的明文密码。哈希由 src/lib/password.ts 的 hashPassword 现算，
 *  不写死密文 —— 写死就等于把 werkzeug scrypt 的参数复制成了第二份真相。 */
export const SEED_PASSWORD = 'e2e-Password-123';

export const SEED_USERS = {
  /** core：博客列表/详情等 requireCoreUser 页面的通行证 */
  core: { id: 'e2e-user-core', username: 'e2e_core', email: 'core@e2e.local', role: 'core' },
  /** admin：/admin 段的正向用例 */
  admin: { id: 'e2e-user-admin', username: 'e2e_admin', email: 'admin@e2e.local', role: 'admin' },
  /** 普通 user：角色门控的反向用例（被 /blog 403、被 /admin 踢回登录页） */
  plain: { id: 'e2e-user-plain', username: 'e2e_plain', email: 'plain@e2e.local', role: 'user' },
} as const;

export const SEED_CATEGORY = { name: 'E2E 栏目', slug: 'e2e-cat' };

/** 正文里的哨兵串：只有客户端 marked 真的跑完才会出现在 DOM 里，
 *  用它断言「详情页正文渲染成功」比断言标题（服务端直出）更有意义。 */
export const BLOG_BODY_MARKER = 'E2E-BODY-MARKER-7f3a';

export const SEED_BLOG = {
  id: 'e2e-blog-0001',
  title: 'E2E 测试文章',
  description: 'E2E 列表页用的摘要',
  content: `# E2E 标题\n\n${BLOG_BODY_MARKER}\n\n- 列表项一\n- 列表项二\n`,
};
