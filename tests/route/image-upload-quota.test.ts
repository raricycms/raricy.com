// POST /api/images —— 配额预检必须按**压缩后**字节。
//
// 【为什么单独钉】图床页、编辑器、讨论选图默认都走压缩（compress 字段缺省为真），
// 而落库的 file_size 是压缩后的：如果预检用压缩前字节，一张 9.5MB 的原图在只剩
// 0.5MB 配额时会被 400「存储空间不足」，而它压缩后可能只有 300KB（R3-370）。
// 反过来也不能把预检删掉：超配额必须在落盘前被拒（配额仍是硬闸）。
//
// 【打法】mock 压缩结果（真实 sharp 压缩率随图片内容波动，做不出确定边界），
// 其余全走真实 route / saveUpload / SQLite；磁盘只碰 tests/.tmp/。

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { resetDb, makeUser, prisma } from '../helpers/db';
import { __resetRateLimitStore } from '@/lib/rate-limit';

const auth = vi.hoisted(() => ({ user: null as unknown }));
vi.mock('@/lib/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth')>();
  return { ...actual, getCurrentUser: async () => auth.user };
});

// 配额上限与压缩结果都可控：真实配额表是固定值（core=50MB），做不出「剩余 1KB」的边界。
const uploadMocks = vi.hoisted(() => ({
  quotaMb: 1,
  compressed: Buffer.alloc(0),
}));
vi.mock('@/lib/image-upload', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/image-upload')>();
  return {
    ...actual,
    getQuotaLimitMb: () => uploadMocks.quotaMb,
    compressImage: vi.fn(async () => uploadMocks.compressed),
  };
});

import { POST as uploadImage } from '@/app/api/images/route';

const tempRoot = path.resolve(import.meta.dirname, '../.tmp');
const uploadDir = path.join(tempRoot, `image-quota-precheck-${randomUUID()}`);

beforeEach(async () => {
  await resetDb();
  __resetRateLimitStore();
  fs.rmSync(uploadDir, { recursive: true, force: true });
  fs.mkdirSync(uploadDir, { recursive: true });
  vi.stubEnv('IMAGE_UPLOAD_FOLDER', uploadDir);
  auth.user = null;
  uploadMocks.quotaMb = 1; // 额度 1MB
  uploadMocks.compressed = Buffer.alloc(0);
});

afterAll(() => {
  if (!uploadDir.startsWith(tempRoot + path.sep)) throw new Error('拒绝清理测试目录以外的文件');
  fs.rmSync(uploadDir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

/** 一张「原图很大」的 GIF：只前 6 字节有意义，其余填充用来撑大压缩前体积。 */
const RAW_BYTES = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(200 * 1024)]);

function uploadReq(opts: { compress?: boolean } = {}) {
  const form = new FormData();
  form.append('file', new File([RAW_BYTES], 'big.gif', { type: 'image/gif' }));
  if (opts.compress === false) form.append('compress', '0');
  return new Request('https://raricy.test/api/images', { method: 'POST', body: form });
}

/** 让用户已用掉「额度 − remaining」字节。 */
async function seedUsed(userId: string, remaining: number) {
  const limit = uploadMocks.quotaMb * 1024 * 1024;
  await prisma.imageHosting.create({
    data: {
      id: 'seed-image',
      authorId: userId,
      filename: 'seed.gif',
      fileSize: limit - remaining,
      mimeType: 'image/gif',
      isPublic: true,
      ignore: false,
      createdAt: new Date(),
    },
  });
}

describe('POST /api/images —— 配额预检口径', () => {
  it('★ 原图超剩余额度、压缩后放得下 → 200（预检必须用压缩后字节）', async () => {
    const user = await makeUser({ role: 'core' });
    auth.user = user;
    await seedUsed(user.id, 1000); // 只剩 1000B，原图 200KB
    uploadMocks.compressed = Buffer.alloc(600); // 压缩后 600B

    const res = await uploadImage(uploadReq());

    expect(res.status, '压缩后 600B 明明放得下，不该按 200KB 原图拒绝').toBe(200);
    const json = await res.json();
    expect(typeof json.id).toBe('string');

    const saved = await prisma.imageHosting.findUniqueOrThrow({ where: { id: json.id } });
    expect(saved.fileSize, '落库与预检必须同一个口径（压缩后）').toBe(600);
    expect(fs.readdirSync(uploadDir)).toHaveLength(1);
  });

  it('压缩后仍超额度 → 400 且不落盘、不落库', async () => {
    const user = await makeUser({ role: 'core' });
    auth.user = user;
    await seedUsed(user.id, 1000);
    uploadMocks.compressed = Buffer.alloc(1001);

    const res = await uploadImage(uploadReq());

    expect(res.status).toBe(400);
    expect((await res.json()).message).toContain('存储空间不足');
    expect(await prisma.imageHosting.count({ where: { authorId: user.id } })).toBe(1);
    expect(fs.readdirSync(uploadDir), '被拒的文件不该落盘').toHaveLength(0);
  });

  it('compress=0 时按原始字节判配额（不套用压缩口径）', async () => {
    const user = await makeUser({ role: 'core' });
    auth.user = user;
    await seedUsed(user.id, 1000);
    uploadMocks.compressed = Buffer.alloc(600); // 若误用压缩结果就会放行

    const res = await uploadImage(uploadReq({ compress: false }));

    expect(res.status, '不压缩的上传必须按原字节判').toBe(400);
    expect((await res.json()).message).toContain('存储空间不足');
    expect(fs.readdirSync(uploadDir)).toHaveLength(0);
  });

  it('压缩后恰好等于剩余额度 → 200（边界取等号）', async () => {
    const user = await makeUser({ role: 'core' });
    auth.user = user;
    await seedUsed(user.id, 1000);
    uploadMocks.compressed = Buffer.alloc(1000);

    const res = await uploadImage(uploadReq());

    expect(res.status).toBe(200);
    expect(fs.readdirSync(uploadDir)).toHaveLength(1);
  });
});
