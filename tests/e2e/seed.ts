// E2E 种子数据的**唯一**事实来源：global-setup 按此建库，各 spec 按此断言。
// 常量集中在这里，避免用例里散落魔法字符串（改个用户名要翻六个文件）。

/** 所有种子用户共用的明文密码。哈希由 src/lib/password.ts 的 hashPassword 现算，
 *  不写死密文 —— 写死就等于把 werkzeug scrypt 的参数复制成了第二份真相。 */
export const SEED_PASSWORD = 'e2e-Password-123';

export const SEED_USERS = {
  /** core：博客列表/详情等 requireCoreUser 页面的通行证 */
  core: { id: 'e2e-user-core', username: 'e2e_core', email: 'core@e2e.local', role: 'core' },
  /** admin：/admin 段的正向用例（非站长专属页）+ 站长专属页的反向用例 */
  admin: { id: 'e2e-user-admin', username: 'e2e_admin', email: 'admin@e2e.local', role: 'admin' },
  /** owner：栏目管理/群发/申诉等站长专属页的通行证 */
  owner: { id: 'e2e-user-owner', username: 'e2e_owner', email: 'owner@e2e.local', role: 'owner' },
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
  content:
    `# E2E 标题\n\n${BLOG_BODY_MARKER}\n\n- 列表项一\n- 列表项二\n\n` +
    `行内公式 $\\int_0^1 x^2 \\, dx = 1/3$ 与化学式 $\\ce{H2O}$ 验证 MathJax 模块化加载。\n`,
};

/**
 * 第二篇种子文章 —— 排序用例的参照系。
 * 时间在 global-setup 里刻意错位：发布早于 SEED_BLOG、更新晚于 SEED_BLOG，
 * 使「按发布时间」与「按更新时间」两种排序结果正好相反。
 */
export const SEED_BLOG2 = {
  id: 'e2e-blog-0002',
  title: 'E2E 排序参照文章',
  description: 'E2E 列表排序用例用的第二篇摘要',
  content: '# E2E 排序参照\n\n第二篇种子文章，仅用于列表排序断言。\n',
};

/**
 * 公示的管理操作日志 —— /audit 列表与 /audit/[id] 详情页用例的锚点。
 *
 * 【为什么两条、且各自指定当事人】申诉只允许**当事人本人**提交
 * （createAppeal 校验 targetUserId === appellantId）。而 desktop / mobile 两个
 * project 共用一个库：同一条日志被两边各申诉一次，后跑的会撞上「同人同日志只允许
 * 一条 pending」。故每个 project 用各自的日志 + 各自的当事人。
 *
 * 当事人必须是 **core+**：提交申诉的接口要求 isCoreUser（plain 会 403）。
 */
export const SEED_LOGS = {
  desktop: {
    id: 90001,
    action: 'delete_comment',
    objectType: 'comment',
    objectId: 'e2e-comment-0001',
    reason: 'E2E 用的操作原因',
    targetUser: 'core',
  },
  mobile: {
    id: 90002,
    action: 'delete_comment',
    objectType: 'comment',
    objectId: 'e2e-comment-0002',
    reason: 'E2E 用的操作原因（mobile）',
    targetUser: 'owner',
  },
} as const;

/** 兼容只读用例的既有引用（列表/详情页只认这条）。 */
export const SEED_LOG = SEED_LOGS.desktop;
