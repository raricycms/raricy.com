// ─────────────────────────────────────────────────────────────────────────────
// seed-acceptance.mts — 隔离验收库的最小匿名数据（只写 tests/.tmp/acceptance-*）
//
// 用法（DATABASE_URL 相对 prisma/schema.prisma 解析）：
//   DB="file:../tests/.tmp/acceptance-20261101.db"
//   DATABASE_URL="$DB" npx prisma db push --skip-generate --accept-data-loss
//   DATABASE_URL="$DB" npx tsx ...? 用 vite-node:
//   DATABASE_URL="$DB" npm run acceptance:seed
//
// 禁止指向业务库：URL 必须包含 tests/.tmp/acceptance-。数据全部为合成内容，
// 不含真实用户 / 正文 / 图片。
//
// ── 两条硬约束（2026-11 修）─────────────────────────────────────────────────
// 1. 隔离闸必须在**任何会构造 PrismaClient 的 import 之前**执行。ESM 的 import 是
//    提升的：以前 `import { prisma } from '../src/lib/db'` 在闸门之前就跑完了
//    `new PrismaClient()`，并对 DATABASE_URL 指向的库发出持久化的 WAL PRAGMA ——
//    也就是说「拒绝在非验收库上运行」生效时，副作用可能已经发生。现在闸门之后才
//    动态 import（prisma / blog-service / clipboard-service 都会拖进 db.ts）。
// 2. 重跑幂等：按固定标题找已存在的剪贴板 / 博客并复用 id，不再每次新建。
//    旧实现第二次运行会再加 2 条剪贴板 + 3 篇博客，累计到 CLIP_PER_USER_MAX 后
//    表现为「种子脚本突然坏了」。
// ─────────────────────────────────────────────────────────────────────────────

const url = (process.env.DATABASE_URL ?? '').replace(/\\/g, '/');
if (!url.includes('/tests/.tmp/acceptance-') || !url.endsWith('.db')) {
  console.error(
    '拒绝在非 acceptance 隔离库上运行（DATABASE_URL 必须指向 tests/.tmp/acceptance-*.db）\n' +
      `  当前 DATABASE_URL：${process.env.DATABASE_URL ?? '(未设置)'}`
  );
  process.exit(1);
}

// 闸门通过之后才加载会构造 PrismaClient 的模块。
const { prisma } = await import('../src/lib/db');
const { hashPassword } = await import('../src/lib/password');
const { createBlog } = await import('../src/lib/blog-service');
const { createClip } = await import('../src/lib/clipboard-service');
const { nowForDb } = await import('../src/lib/db-time');
const sharp = (await import('sharp')).default;

const PASSWORD = 'Acceptance-2026!';
const DATA_IMAGE = `data:image/png;base64,${(
  await sharp(
    Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="120"><rect width="320" height="120" fill="#dbeafe"/><text x="20" y="70" font-size="28" fill="#1d4ed8">历史 data 位图</text></svg>'
    )
  )
    .png()
    .toBuffer()
).toString('base64')}`;

const passwordHash = await hashPassword(PASSWORD);
const user = await prisma.user.upsert({
  where: { username: 'accept_core' },
  update: { passwordHash, role: 'core' },
  create: {
    id: 'acceptance-core-user',
    username: 'accept_core',
    email: 'accept@example.invalid',
    passwordHash,
    role: 'core',
    createdAt: nowForDb(),
  },
});
/** 按标题复用已存在的剪贴板（顺带恢复被软删的那条），否则新建。 */
async function ensureClipId(title: string, content: string, format: 'markdown' | 'reactive'): Promise<string> {
  const existing = await prisma.clipBoard.findFirst({
    where: { authorId: user.id, title },
    orderBy: { createdAt: 'desc' },
  });
  if (existing) {
    if (existing.ignore) {
      await prisma.clipBoard.update({ where: { id: existing.id }, data: { ignore: false } });
    }
    return existing.id;
  }
  const created = await createClip(user.id, { title, content, publicity: true, format });
  if (!created.ok) throw new Error(`${title}：剪贴板种子失败（${created.reason}）`);
  return created.id;
}

/** 按标题复用已存在的博客（顺带恢复被软删的那条），否则新建。 */
async function ensureBlogId(
  title: string,
  build: () => Promise<string>
): Promise<string> {
  const existing = await prisma.blog.findFirst({
    where: { authorId: user.id, title },
    orderBy: { createdAt: 'desc' },
  });
  if (existing) {
    if (existing.ignore) {
      await prisma.blog.update({ where: { id: existing.id }, data: { ignore: false } });
    }
    return existing.id;
  }
  return build();
}

async function main(): Promise<void> {
  const clipMarkdownId = await ensureClipId(
    '验收：Markdown 剪贴板',
    '剪贴板里的 **Markdown 正文**。\n\n第二行\n第三行',
    'markdown'
  );
  const clipReactiveId = await ensureClipId(
    '验收：Reactive 剪贴板',
    '<panel title="子组件">\n<slider bind="v" label="子滑块" initial="2" min="1" max="5">\n</panel>\n\n子值 {{ v }}。',
    'reactive'
  );

  const mixed = [
    '# 统一渲染验收',
    '',
    '第一行',
    '第二行（单换行应显示为换行）',
    '',
    '公式 $x^2 + y^2$ 与行内展示。',
    '',
    `Markdown 剪贴板引用：[@${clipMarkdownId}]`,
    '',
    '历史 HTML：<font color="red" style="color:red">这段字应保留</font>。',
    '',
    `<img src="${DATA_IMAGE}" alt="历史 data 位图">`,
    '',
    '```js',
    'console.log("code");',
    '```',
  ].join('\n');
  const blogMarkdownId = await ensureBlogId('验收：Markdown 混写', async () =>
    createBlog(user.id, {
      title: '验收：Markdown 混写',
      description: '统一渲染与兼容',
      content: mixed,
      categoryId: null,
      visibility: 'public',
      format: 'markdown',
    })
  );

  const reactive = [
    '<panel title="交互示例">',
    '<slider bind="n" label="人数" initial="2" min="1" max="5">',
    '</panel>',
    '',
    '人数 {{ n }} 人。',
    '',
    '第一行',
    '第二行',
    '',
    `Reactive 剪贴板（应为链接卡片）：[@${clipReactiveId}]`,
  ].join('\n');
  const blogReactiveId = await ensureBlogId('验收：Reactive 交互', async () =>
    createBlog(user.id, {
      title: '验收：Reactive 交互',
      description: '正常阅读可交互',
      content: reactive,
      categoryId: null,
      visibility: 'public',
      format: 'reactive',
    })
  );

  const longPoem = [
    '# 验收：长文',
    '',
    ...Array.from({ length: 1200 }, (_, index) => [
      `## 第 ${index + 1} 节`,
      '',
      '夜色落在旧屋檐上，山风吹过石阶，一盏灯晃了又晃。',
      '第二行紧接上一行，应保留换行。',
      '',
      `**加粗**、_斜体_ 与 $x_{${index}}$ 公式。`,
      '',
    ].join('\n')),
    '结尾：长文最后一段必须还在。',
  ].join('\n');
  const blogLongId = await ensureBlogId('验收：长文与公式', async () =>
    createBlog(user.id, {
      title: '验收：长文与公式',
      description: '长文尾段与换行',
      content: longPoem,
      categoryId: null,
      visibility: 'public',
      format: 'markdown',
    })
  );

  console.log(JSON.stringify({
    account: { username: 'accept_core', password: PASSWORD },
    blogs: { mixed: blogMarkdownId, reactive: blogReactiveId, long: blogLongId },
    clips: { markdown: clipMarkdownId, reactive: clipReactiveId },
  }, null, 2));
}

try {
  await main();
} finally {
  await prisma.$disconnect();
}
