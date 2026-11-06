// DELETE /api/images/:id 与 /api/images/admin/:id —— 软删 / 硬删的职责划分。
//
// 【为什么单独测这个】软删与硬删本该各走一条**独立路径**：
//   · `/api/images/<id>` DELETE       → 软删（任何有权者）
//   · `/api/images/admin/<id>` DELETE → 站长专属硬删（删盘 + 删行）
//
// 此前把两件事揉进了同一个路由，并写成 `if (isOwner(user)) hardDelete(...)` ——
// 后果是**站长永远无法软删**：连删自己的图都是物理删除、不可恢复。
// 这类「权限越高、行为越危险且无法选择」的分叉，测试不打就发现不了。
//
// 本文件打的是真实 route handler（不 mock Prisma），只 mock 登录态。

import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
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

// 通知是**删除之后的尽力动作**：这里可注入失败，验证它不会把已完成的硬删变成 500。
const notifyState = vi.hoisted(() => ({ fail: false }));
vi.mock('@/lib/notification-service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/notification-service')>();
  return {
    ...actual,
    sendNotification: async (...args: Parameters<typeof actual.sendNotification>) => {
      if (notifyState.fail) throw new Error('通知写入失败（注入）');
      return actual.sendNotification(...args);
    },
  };
});

import { resetDb, makeUser, prisma } from '../helpers/db';
import { storagePathFor } from '@/lib/image-upload';
import { DELETE as deleteImage } from '@/app/api/images/[id]/route';
import { DELETE as adminDeleteImage } from '@/app/api/images/admin/[id]/route';

/** 兜底：确认没指到真实目录（Windows 路径是反斜杠，归一化后校验，
 *  与 tests/helpers/db.ts 的 assertTestDb 同一处理）。 */
function assertTempDir() {
  if (!TEST_UPLOAD_DIR.replace(/\\/g, '/').includes('/tests/.tmp/')) {
    throw new Error(`拒绝在非临时目录上跑：${TEST_UPLOAD_DIR}`);
  }
}

beforeAll(() => {
  fs.mkdirSync(TEST_UPLOAD_DIR, { recursive: true });
  assertTempDir();
});

// 与 tests/service/image-service.test.ts 同款：跑完删掉自己造的 png。
// 此前没有这段，每次运行留下 8 个文件。
afterAll(() => {
  assertTempDir();
  fs.rmSync(TEST_UPLOAD_DIR, { recursive: true, force: true });
});

beforeEach(async () => {
  await resetDb();
  mockUser.current = null;
  notifyState.fail = false;
});

afterEach(() => {
  vi.restoreAllMocks();
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

  it('管理员（非站长）→ 403（硬删仅限站长）', async () => {
    const admin = await makeUser({ role: 'admin' });
    const { row } = await makeImageWithFile(admin.id);

    mockUser.current = admin;
    expect((await adminDeleteImage(new Request('http://x'), ctx(row.id))).status).toBe(403);
    expect(await prisma.imageHosting.findUnique({ where: { id: row.id } })).not.toBeNull();
  });

  it('★ 通知失败不影响删除结果 → 仍 200，行与文件都已删', async () => {
    const owner = await makeUser({ role: 'owner' });
    const other = await makeUser({ role: 'core' });
    const { row, diskPath } = await makeImageWithFile(other.id);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    mockUser.current = owner;
    notifyState.fail = true;
    const res = await adminDeleteImage(new Request('http://x'), ctx(row.id));

    expect(res.status, '一次已完成的硬删不能因为通知失败报 500').toBe(200);
    expect(await prisma.imageHosting.findUnique({ where: { id: row.id } })).toBeNull();
    expect(fs.existsSync(diskPath)).toBe(false);
    expect(warn).toHaveBeenCalled();
  });

  it('★ 磁盘文件删不掉（unlink 抛错）→ 仍 200，只留下孤儿文件', async () => {
    const owner = await makeUser({ role: 'owner' });
    const { row, diskPath } = await makeImageWithFile(owner.id);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(fsp, 'unlink').mockRejectedValueOnce(
      Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
    );

    mockUser.current = owner;
    const res = await adminDeleteImage(new Request('http://x'), ctx(row.id));

    expect(res.status, '文件删不掉不该让接口报「删除失败」').toBe(200);
    expect(await prisma.imageHosting.findUnique({ where: { id: row.id } })).toBeNull();
    expect(fs.existsSync(diskPath), '删行已成功，留下孤儿文件是可接受的一侧').toBe(true);
    expect(warn, '孤儿文件必须留一条可排查的日志').toHaveBeenCalled();
  });

  it('★ 删行失败 → 异常上抛，磁盘文件原样保留（绝不出现「行在、文件没了」）', async () => {
    const owner = await makeUser({ role: 'owner' });
    const { row, diskPath } = await makeImageWithFile(owner.id);
    vi.spyOn(prisma.imageHosting, 'delete').mockRejectedValueOnce(new Error('db down'));

    mockUser.current = owner;
    await expect(adminDeleteImage(new Request('http://x'), ctx(row.id))).rejects.toThrow('db down');

    expect(fs.existsSync(diskPath), '删行失败时文件不能被提前删掉').toBe(true);
    expect(await prisma.imageHosting.findUnique({ where: { id: row.id } }), '行仍然在').not.toBeNull();
  });
});
