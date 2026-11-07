// ─────────────────────────────────────────────────────────────────────────────
// image-quota-boundary.test.ts —— 配额边界的**真实路由闸门**（R3-381）
//
// 【为什么单独一份】这些边界原先在 `tests/service/image-service.test.ts` 里用测试内
// 复刻的 `wouldAccept`（角色取整 + `used + incoming <= limit`）断言 —— 把
// `api/images/route.ts` 的 `>` 改成 `>=`、把 MB 写成别的进制、或删掉「limitMb===0
// 提前 403」的角色闸，那 9 条断言**仍全绿**。现在全部走 `POST /api/images`：
//   · 恰好满（`used + incoming === limit`）→ 200；
//   · 超 1 字节 → 400「存储空间不足」；
//   · owner 100MB / admin 与 core 同 50MB / user 0 配额 → 403 角色闸；
//   · 软删释放额度；单文件 10MB 上限与角色配额是两道独立闸门。
//
// 【打法】`compress: '0'` 让 finalBuffer 就是原始字节（不 mock sharp、不依赖压缩率），
// 配额只往 `imageHosting.fileSize` 里写数字（不需要真磁盘文件）。auth 用 importActual
// 的真实角色判据，只替换 getCurrentUser。
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { resetDb, makeUser, prisma } from '../helpers/db';
import { __resetRateLimitStore } from '@/lib/rate-limit';
import { softDeleteImage } from '@/lib/image-service';

const auth = vi.hoisted(() => ({ user: null as unknown }));
vi.mock('@/lib/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth')>();
  return { ...actual, getCurrentUser: async () => auth.user };
});

import { POST as uploadImage } from '@/app/api/images/route';

const MB = 1024 * 1024;
/** 角色配额（与 src/lib/image-upload.ts 的 QUOTA_LIMITS_MB 同源；断言值本身写死才防漂移）。 */
const LIMIT: Record<string, number> = { core: 50 * MB, admin: 50 * MB, owner: 100 * MB };

/** 1×1 合法 PNG（planImageUpload 按字节判定会接受）。 */
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

const tempRoot = path.resolve(import.meta.dirname, '../.tmp');
const uploadDir = path.join(tempRoot, `image-quota-boundary-${randomUUID()}`);

beforeEach(async () => {
  await resetDb();
  __resetRateLimitStore();
  fs.rmSync(uploadDir, { recursive: true, force: true });
  fs.mkdirSync(uploadDir, { recursive: true });
  vi.stubEnv('IMAGE_UPLOAD_FOLDER', uploadDir);
  auth.user = null;
});

afterAll(() => {
  if (!uploadDir.startsWith(tempRoot + path.sep)) throw new Error('拒绝清理测试目录以外的文件');
  fs.rmSync(uploadDir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

function uploadReq(bytes: Buffer = TINY_PNG) {
  const form = new FormData();
  form.append('file', new File([new Uint8Array(bytes)], 'shot.png', { type: 'image/png' }));
  form.append('compress', '0'); // 按原始字节判，边界才确定
  return new Request('https://raricy.test/api/images', { method: 'POST', body: form });
}

/** 让用户已用掉指定字节数（只写 fileSize，不落磁盘）。 */
async function seedUsed(userId: string, usedBytes: number) {
  await prisma.imageHosting.create({
    data: {
      id: `seed-${randomUUID()}`,
      authorId: userId,
      filename: 'seed.png',
      fileSize: usedBytes,
      mimeType: 'image/png',
      isPublic: true,
      ignore: false,
      createdAt: new Date(),
    },
  });
}

describe('POST /api/images —— 配额边界的真实闸门', () => {
  it('core：恰好用满 50MB → 200（边界取等号；改成 >= 会红）', async () => {
    const u = await makeUser({ role: 'core' });
    auth.user = { id: u.id, role: 'core' };
    await seedUsed(u.id, LIMIT.core - TINY_PNG.length);

    const res = await uploadImage(uploadReq());
    expect(res.status, 'used + incoming === limit 必须放行').toBe(200);
    const saved = await prisma.imageHosting.findFirstOrThrow({
      where: { authorId: u.id, filename: 'shot.png' },
    });
    expect(saved.fileSize).toBe(TINY_PNG.length);
  });

  it('core：超出 1 字节 → 400「存储空间不足」，不落库不落盘', async () => {
    const u = await makeUser({ role: 'core' });
    auth.user = { id: u.id, role: 'core' };
    await seedUsed(u.id, LIMIT.core - TINY_PNG.length + 1);

    const res = await uploadImage(uploadReq());
    expect(res.status).toBe(400);
    expect((await res.json()).message).toContain('存储空间不足');
    expect(await prisma.imageHosting.count({ where: { authorId: u.id } })).toBe(1);
    expect(fs.readdirSync(uploadDir), '被拒的文件不该落盘').toHaveLength(0);
  });

  it('core：已用满 50MB 后再传 1 字节 → 400', async () => {
    const u = await makeUser({ role: 'core' });
    auth.user = { id: u.id, role: 'core' };
    await seedUsed(u.id, LIMIT.core);

    expect((await uploadImage(uploadReq())).status).toBe(400);
  });

  it('owner：50MB 处仍有余量 → 200（core 会被拒的量 owner 放行）', async () => {
    const o = await makeUser({ role: 'owner' });
    auth.user = { id: o.id, role: 'owner' };
    await seedUsed(o.id, LIMIT.core);

    expect((await uploadImage(uploadReq())).status, 'owner 配额是 100MB').toBe(200);
  });

  it('owner：恰好用满 100MB → 200', async () => {
    const o = await makeUser({ role: 'owner' });
    auth.user = { id: o.id, role: 'owner' };
    await seedUsed(o.id, LIMIT.owner - TINY_PNG.length);

    expect((await uploadImage(uploadReq())).status, '正好填满 100MB 应放行').toBe(200);
  });

  it('owner：超出 1 字节 → 400', async () => {
    const o = await makeUser({ role: 'owner' });
    auth.user = { id: o.id, role: 'owner' };
    await seedUsed(o.id, LIMIT.owner - TINY_PNG.length + 1);

    expect((await uploadImage(uploadReq())).status, '多 1 字节必须拒绝').toBe(400);
  });

  it('admin：与 core 同为 50MB（不因是管理员而放宽）', async () => {
    const a = await makeUser({ role: 'admin' });
    auth.user = { id: a.id, role: 'admin' };
    await seedUsed(a.id, LIMIT.core);

    expect((await uploadImage(uploadReq())).status).toBe(400);
  });

  it('user：角色闸 → 403（先于容量判定，空账户也不放行）', async () => {
    const u = await makeUser({ role: 'user' });
    auth.user = { id: u.id, role: 'user' };

    const res = await uploadImage(uploadReq());
    expect(res.status).toBe(403);
    // 真实闸门顺序：isCoreUser 先拒（'需要核心用户权限'）；角色配额 0 的
    // 「无权使用图床」分支在 core 之外的角色上不可达。断言必须钉**实际**文案，
    // 否则把前面的 core 闸删掉、只靠后面 403 仍会绿。
    expect((await res.json()).message).toContain('核心用户');
  });

  it('软删后腾出的空间可被重新使用（配额与软删联动）', async () => {
    const u = await makeUser({ role: 'core' });
    auth.user = { id: u.id, role: 'core' };
    const full = await prisma.imageHosting.create({
      data: {
        id: 'soft-del',
        authorId: u.id,
        filename: 'old.png',
        fileSize: LIMIT.core,
        mimeType: 'image/png',
        isPublic: true,
        ignore: false,
        createdAt: new Date(),
      },
    });
    expect((await uploadImage(uploadReq())).status, '已满时应拒').toBe(400);

    await softDeleteImage(full.id);
    expect((await uploadImage(uploadReq())).status, '软删后应重新有额度').toBe(200);
  });

  it('单文件 10MB 上限与角色配额是两道独立闸门（配额空也会被单文件闸拒）', async () => {
    const u = await makeUser({ role: 'core' });
    auth.user = { id: u.id, role: 'core' };
    // 合法 GIF 头 + 填充撑到 10MB+1（配额层面 10MB+1 远小于 50MB，只有单文件闸能拦）
    const huge = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(10 * MB + 1 - 6)]);

    const res = await uploadImage(uploadReq(huge));
    expect(res.status).toBe(400);
    expect((await res.json()).message).toContain('文件过大');
    expect(await prisma.imageHosting.count({ where: { authorId: u.id } })).toBe(0);
  });
});
