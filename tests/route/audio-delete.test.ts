// DELETE /api/audio/admin/:id —— 硬删（站长专属）的顺序与失败语义。
//
// 【为什么单独测】硬删跨数据库与文件系统，无法放进一个事务：
//   · 先删盘、后删行 → 删行失败会留下「行在、文件没了」（raw 永久 404、配额仍占用、
//     管理页仍显示这一行，且修不回来）；
//   · 删后通知失败 → 一次已完成的删除被报成 500，站长重试只会得到 400「不存在」。
// 本文件用失败注入把这两条钉住：通知失败、unlink 失败、删行失败。
//
// 【磁盘安全】只碰 tests/.tmp/audit-route-test/，绝不碰 ./instance/audio。

import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

const TEST_UPLOAD_DIR = path.resolve(import.meta.dirname, '../.tmp/audio-route-test');
process.env.AUDIO_UPLOAD_FOLDER = TEST_UPLOAD_DIR;

// 只替换 getCurrentUser，保留真实的 isOwner / hasAdminRights —— 权限判定是被测语义
const mockUser = vi.hoisted(() => ({ current: null as unknown }));
vi.mock('@/lib/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth')>();
  return { ...actual, getCurrentUser: async () => mockUser.current };
});

// 通知是**删除之后的尽力动作**：可注入失败，验证它不会把已完成的硬删变成 500。
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
import { audioStoragePathFor } from '@/lib/audio-upload';
import { DELETE as adminDeleteAudio } from '@/app/api/audio/admin/[id]/route';

/** 兜底：确认没指到真实目录（同 image-delete.test.ts）。 */
function assertTempDir() {
  if (!TEST_UPLOAD_DIR.replace(/\\/g, '/').includes('/tests/.tmp/')) {
    throw new Error(`拒绝在非临时目录上跑：${TEST_UPLOAD_DIR}`);
  }
}

beforeAll(() => {
  fs.mkdirSync(TEST_UPLOAD_DIR, { recursive: true });
  assertTempDir();
});

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

/** 造一条音频记录 + 真实磁盘文件。 */
async function makeAudioWithFile(authorId: string) {
  const id = `at${String(++seq).padStart(8, '0')}`;
  const mimeType = 'audio/mpeg';
  const row = await prisma.audioHosting.create({
    data: {
      id,
      authorId,
      filename: 'x.mp3',
      fileSize: 4,
      mimeType,
      isPublic: true,
      ignore: false,
      createdAt: new Date(),
    },
  });
  const diskPath = audioStoragePathFor(id, mimeType);
  fs.writeFileSync(diskPath, Buffer.from([0x49, 0x44, 0x33, 0x03]));
  return { row, diskPath };
}

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

describe('DELETE /api/audio/admin/:id —— 硬删（站长专属）', () => {
  it('站长 → 200：删库行 + 删磁盘文件', async () => {
    const owner = await makeUser({ role: 'owner' });
    const { row, diskPath } = await makeAudioWithFile(owner.id);

    mockUser.current = owner;
    expect((await adminDeleteAudio(new Request('http://x'), ctx(row.id))).status).toBe(200);

    expect(await prisma.audioHosting.findUnique({ where: { id: row.id } }), '硬删应删库行').toBeNull();
    expect(fs.existsSync(diskPath), '硬删应删磁盘文件').toBe(false);
  });

  it('非站长 → 403（硬删仅限站长）', async () => {
    const admin = await makeUser({ role: 'admin' });
    const { row } = await makeAudioWithFile(admin.id);

    mockUser.current = admin;
    expect((await adminDeleteAudio(new Request('http://x'), ctx(row.id))).status).toBe(403);
    expect(await prisma.audioHosting.findUnique({ where: { id: row.id } })).not.toBeNull();
  });

  it('★ 通知失败不影响删除结果 → 仍 200，行与文件都已删', async () => {
    const owner = await makeUser({ role: 'owner' });
    const other = await makeUser({ role: 'core' });
    const { row, diskPath } = await makeAudioWithFile(other.id);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    mockUser.current = owner;
    notifyState.fail = true;
    const res = await adminDeleteAudio(new Request('http://x'), ctx(row.id));

    expect(res.status, '一次已完成的硬删不能因为通知失败报 500').toBe(200);
    expect(await prisma.audioHosting.findUnique({ where: { id: row.id } })).toBeNull();
    expect(fs.existsSync(diskPath)).toBe(false);
    expect(warn).toHaveBeenCalled();
  });

  it('★ 磁盘文件删不掉（unlink 抛错）→ 仍 200，只留下孤儿文件', async () => {
    const owner = await makeUser({ role: 'owner' });
    const { row, diskPath } = await makeAudioWithFile(owner.id);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(fsp, 'unlink').mockRejectedValueOnce(
      Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
    );

    mockUser.current = owner;
    const res = await adminDeleteAudio(new Request('http://x'), ctx(row.id));

    expect(res.status, '文件删不掉不该让接口报「删除失败」').toBe(200);
    expect(await prisma.audioHosting.findUnique({ where: { id: row.id } })).toBeNull();
    expect(fs.existsSync(diskPath), '删行已成功，留下孤儿文件是可接受的一侧').toBe(true);
    expect(warn, '孤儿文件必须留一条可排查的日志').toHaveBeenCalled();
  });

  it('★ 删行失败 → 异常上抛，磁盘文件原样保留（绝不出现「行在、文件没了」）', async () => {
    const owner = await makeUser({ role: 'owner' });
    const { row, diskPath } = await makeAudioWithFile(owner.id);
    vi.spyOn(prisma.audioHosting, 'delete').mockRejectedValueOnce(new Error('db down'));

    mockUser.current = owner;
    await expect(adminDeleteAudio(new Request('http://x'), ctx(row.id))).rejects.toThrow('db down');

    expect(fs.existsSync(diskPath), '删行失败时文件不能被提前删掉').toBe(true);
    expect(await prisma.audioHosting.findUnique({ where: { id: row.id } }), '行仍然在').not.toBeNull();
  });
});
