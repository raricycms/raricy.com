// DELETE /api/images/:id 与 /api/images/admin/:id —— 软删 / 硬删的职责划分。
//
// 【为什么单独测这个】Flask 把两件事放在**两条独立路径**上：
//   · 图床蓝图 `/image/<id>` DELETE      → ImageService.soft_delete_image（任何有权者）
//   · admin 蓝图 `/image/admin/<id>` DELETE → 站长专属硬删（删盘 + 删行）
//
// 迁移时我把它们揉进了同一个路由，并写成 `if (isOwner(user)) hardDelete(...)` ——
// 后果是**站长永远无法软删**：连删自己的图都是物理删除、不可恢复，与原站行为不符。
// 这类「权限越高、行为越危险且无法选择」的分叉，测试不打就发现不了。
//
// 本文件打的是真实 route handler（不 mock Prisma），只 mock 登录态。

import { describe, it, expect, beforeEach, beforeAll, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// 上传目录必须在任何 storagePathFor 之前指向临时目录，绝不能碰 instance/images/ 里的真实图片
const TEST_UPLOAD_DIR = path.resolve(import.meta.dirname, '../.tmp/images-route-test');
process.env.IMAGE_UPLOAD_FOLDER = TEST_UPLOAD_DIR;

// 只替换 getCurrentUser，保留真实的 isOwner / hasAdminRights —— 权限判定本身是被测语义
const mockUser = vi.hoisted(() => ({ current: null as unknown }));
vi.mock('@/lib/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth')>();
  return { ...actual, getCurrentUser: async () => mockUser.current };
});

import { resetDb, makeUser, prisma } from '../helpers/db';
import { storagePathFor } from '@/lib/image-upload';
import { DELETE as deleteImage } from '@/app/api/images/[id]/route';
import { DELETE as adminDeleteImage } from '@/app/api/images/admin/[id]/route';

beforeAll(() => {
  fs.mkdirSync(TEST_UPLOAD_DIR, { recursive: true });
  // 兜底：确认没指到真实目录
  if (!TEST_UPLOAD_DIR.includes('/tests/.tmp/')) {
    throw new Error(`拒绝在非临时目录上跑：${TEST_UPLOAD_DIR}`);
  }
});

beforeEach(async () => {
  await resetDb();
  mockUser.current = null;
});

let seq = 0;

/** 造一条图床记录 + 真实磁盘文件。 */
async function makeImageWithFile(authorId: string) {
  const id = `rt${String(++seq).padStart(8, '0')}`;
  const mimeType = 'image/png';
  const row = await prisma.imageHosting.create({
    data: {
      id,
      authorId,
      filename: 'x.png',
      fileSize: 4,
      mimeType,
      isPublic: true,
      ignore: false,
      createdAt: new Date(),
    },
  });
  const p = storagePathFor(id, mimeType);
  fs.writeFileSync(p, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  return { row, diskPath: p, mimeType };
}

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

describe('DELETE /api/images/:id —— 一律软删（站长也不例外）', () => {
  it('站长删自己的图 → 软删：行还在、磁盘文件还在', async () => {
    const owner = await makeUser({ role: 'owner' });
    const { row, diskPath } = await makeImageWithFile(owner.id);
    expect(fs.existsSync(diskPath), '前置：磁盘文件应存在').toBe(true);

    mockUser.current = owner;
    const res = await deleteImage(new Request('http://x'), ctx(row.id));
    expect(res.status).toBe(200);

    const after = await prisma.imageHosting.findUnique({ where: { id: row.id } });
    expect(after, '站长删自己的图被物理删除了 —— 应为软删，不可恢复是 bug').not.toBeNull();
    expect(after!.ignore, '应标记为软删除').toBe(true);
    expect(fs.existsSync(diskPath), '软删不该删磁盘文件').toBe(true);
  });

  it('站长删他人的图 → 同样是软删', async () => {
    const owner = await makeUser({ role: 'owner' });
    const other = await makeUser({ role: 'core' });
    const { row, diskPath } = await makeImageWithFile(other.id);

    mockUser.current = owner;
    expect((await deleteImage(new Request('http://x'), ctx(row.id))).status).toBe(200);

    const after = await prisma.imageHosting.findUnique({ where: { id: row.id } });
    expect(after).not.toBeNull();
    expect(after!.ignore).toBe(true);
    expect(fs.existsSync(diskPath)).toBe(true);
  });

  it('作者删自己的图 → 软删', async () => {
    const u = await makeUser({ role: 'core' });
    const { row } = await makeImageWithFile(u.id);

    mockUser.current = u;
    expect((await deleteImage(new Request('http://x'), ctx(row.id))).status).toBe(200);
    expect((await prisma.imageHosting.findUnique({ where: { id: row.id } }))!.ignore).toBe(true);
  });

  it('非作者且非管理员 → 403，图不动', async () => {
    const author = await makeUser({ role: 'core' });
    const stranger = await makeUser({ role: 'core' });
    const { row } = await makeImageWithFile(author.id);

    mockUser.current = stranger;
    expect((await deleteImage(new Request('http://x'), ctx(row.id))).status).toBe(403);
    expect((await prisma.imageHosting.findUnique({ where: { id: row.id } }))!.ignore).toBe(false);
  });

  it('未登录 → 401', async () => {
    const u = await makeUser({ role: 'core' });
    const { row } = await makeImageWithFile(u.id);
    mockUser.current = null;
    expect((await deleteImage(new Request('http://x'), ctx(row.id))).status).toBe(401);
  });

  it('重复删除 → 400「图片已被删除」', async () => {
    const u = await makeUser({ role: 'core' });
    const { row } = await makeImageWithFile(u.id);

    mockUser.current = u;
    await deleteImage(new Request('http://x'), ctx(row.id));
    const res = await deleteImage(new Request('http://x'), ctx(row.id));
    expect(res.status).toBe(400);
    expect((await res.json()).message).toBe('图片已被删除');
  });
});

describe('DELETE /api/images/admin/:id —— 硬删（站长专属）', () => {
  it('站长 → 硬删：删库行 + 删磁盘文件', async () => {
    const owner = await makeUser({ role: 'owner' });
    const { row, diskPath } = await makeImageWithFile(owner.id);

    mockUser.current = owner;
    expect((await adminDeleteImage(new Request('http://x'), ctx(row.id))).status).toBe(200);

    expect(await prisma.imageHosting.findUnique({ where: { id: row.id } }), '硬删应删库行').toBeNull();
    expect(fs.existsSync(diskPath), '硬删应删磁盘文件').toBe(false);
  });

  it('管理员（非站长）→ 403（对齐 Flask @owner_required）', async () => {
    const admin = await makeUser({ role: 'admin' });
    const { row } = await makeImageWithFile(admin.id);

    mockUser.current = admin;
    expect((await adminDeleteImage(new Request('http://x'), ctx(row.id))).status).toBe(403);
    expect(await prisma.imageHosting.findUnique({ where: { id: row.id } })).not.toBeNull();
  });
});
