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
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from '../src/lib/db';
import { hashPassword } from '../src/lib/password';
import { createBlog } from '../src/lib/blog-service';
import { createClip } from '../src/lib/clipboard-service';
import { nowForDb } from '../src/lib/db-time';
import sharp from 'sharp';

const url = (process.env.DATABASE_URL ?? '').replace(/\\/g, '/');
if (!url.includes('/tests/.tmp/acceptance-') || !url.endsWith('.db')) {
  throw new Error('拒绝在非 acceptance 隔离库上运行（DATABASE_URL 必须指向 tests/.tmp/acceptance-*.db）');
}

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

async function main(): Promise<void> {
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

  const clipMarkdown = await createClip(user.id, {
    title: '验收：Markdown 剪贴板',
    content: '剪贴板里的 **Markdown 正文**。\n\n第二行\n第三行',
    publicity: true,
    format: 'markdown',
  });
  if (!clipMarkdown.ok) throw new Error('markdown clip seed failed');

  const clipReactive = await createClip(user.id, {
    title: '验收：Reactive 剪贴板',
    content: '<panel title="子组件">\n<slider bind="v" label="子滑块" initial="2" min="1" max="5">\n</panel>\n\n子值 {{ v }}。',
    publicity: true,
    format: 'reactive',
  });
  if (!clipReactive.ok) throw new Error('reactive clip seed failed');

  const mixed = [
    '# 统一渲染验收',
    '',
    '第一行',
    '第二行（单换行应显示为换行）',
    '',
    '公式 $x^2 + y^2$ 与行内展示。',
    '',
    `Markdown 剪贴板引用：[@${clipMarkdown.id}]`,
    '',
    '历史 HTML：<font color="red" style="color:red">这段字应保留</font>。',
    '',
    `<img src="${DATA_IMAGE}" alt="历史 data 位图">`,
    '',
    '```js',
    'console.log("code");',
    '```',
  ].join('\n');
  const blogMarkdown = await createBlog(user.id, {
    title: '验收：Markdown 混写',
    description: '统一渲染与兼容',
    content: mixed,
    categoryId: null,
    visibility: 'public',
    format: 'markdown',
  });

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
    `Reactive 剪贴板（应为链接卡片）：[@${clipReactive.id}]`,
  ].join('\n');
  const blogReactive = await createBlog(user.id, {
    title: '验收：Reactive 交互',
    description: '正常阅读可交互',
    content: reactive,
    categoryId: null,
    visibility: 'public',
    format: 'reactive',
  });

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
  const blogLong = await createBlog(user.id, {
    title: '验收：长文与公式',
    description: '长文尾段与换行',
    content: longPoem,
    categoryId: null,
    visibility: 'public',
    format: 'markdown',
  });

  console.log(JSON.stringify({
    account: { username: 'accept_core', password: PASSWORD },
    blogs: { mixed: blogMarkdown, reactive: blogReactive, long: blogLong },
    clips: { markdown: clipMarkdown.id, reactive: clipReactive.id },
  }, null, 2));
}

try {
  await main();
} finally {
  await prisma.$disconnect();
}
