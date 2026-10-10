import { afterAll, beforeEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { resetDb, makeUser, prisma } from '../helpers/db';
import { __resetRateLimitStore } from '@/lib/rate-limit';
const auth = vi.hoisted(() => ({ user: null as unknown }));
vi.mock('@/lib/auth', async (original) => ({ ...await original<typeof import('@/lib/auth')>(), getCurrentUser: async () => auth.user }));
vi.mock('@/lib/image-upload', async (original) => {
  const actual = await original<typeof import('@/lib/image-upload')>();
  return { ...actual, getUserUsedBytes: vi.fn(actual.getUserUsedBytes) };
});
vi.mock('@/lib/audio-service', async (original) => {
  const actual = await original<typeof import('@/lib/audio-service')>();
  return { ...actual, getUserUsedAudioBytes: vi.fn(actual.getUserUsedAudioBytes) };
});
import { getUserUsedBytes } from '@/lib/image-upload';
import { getUserUsedAudioBytes } from '@/lib/audio-service';
import { POST as uploadImage } from '@/app/api/images/route';
import { POST as uploadAudio } from '@/app/api/audio/route';

const tempRoot = path.resolve(import.meta.dirname, '../.tmp');
const uploadDir = path.join(tempRoot, `quota-race-${randomUUID()}`);
const imageDir = path.join(uploadDir, 'images');
const audioDir = path.join(uploadDir, 'audio');
function clean() {
  if (!uploadDir.startsWith(tempRoot + path.sep)) throw new Error('拒绝清理测试目录以外的文件');
  fs.rmSync(uploadDir, { recursive: true, force: true });
}
beforeEach(async () => {
  await resetDb(); __resetRateLimitStore(); clean();
  vi.stubEnv('IMAGE_UPLOAD_FOLDER', imageDir);
  vi.stubEnv('AUDIO_UPLOAD_FOLDER', audioDir);
});
afterAll(() => { clean(); vi.unstubAllEnvs(); });

it.each(['image', 'audio'] as const)('%s：并发上传不能共享最后一份存储额度，失败不留下文件', async (kind) => {
  const user = await makeUser({ role: 'core' }); auth.user = user;
  const bytes = kind === 'image' ? Buffer.from('GIF89a') : Buffer.from([73, 68, 51, 3, 0, 0, 0, 0, 0, 0]);
  const mimeType = kind === 'image' ? 'image/gif' : 'audio/mpeg';
  const model = kind === 'image' ? prisma.imageHosting : prisma.audioHosting;
  const quota = 50 * 1024 * 1024;
  await model.create({ data: { id: 'quota-seed', filename: 'seed', mimeType,
    authorId: user.id, fileSize: quota - bytes.length } });
  // 两个请求都在写入前完成真实聚合读，精确复现共享同一份剩余额度。
  let arrivals = 0;
  let release!: () => void;
  const bothRead = new Promise<void>((resolve) => { release = resolve; });
  const readUsed = kind === 'image' ? vi.mocked(getUserUsedBytes) : vi.mocked(getUserUsedAudioBytes);
  readUsed.mockImplementation(async () => {
    const used = await model.aggregate({ where: { authorId: user.id, ignore: false }, _sum: { fileSize: true } });
    if (++arrivals === 2) release();
    await bothRead;
    return used._sum.fileSize ?? 0;
  });
  function request() {
    const form = new FormData();
    form.append('file', new File([bytes], kind === 'image' ? 'test.gif' : 'test.mp3', { type: mimeType }));
    return new Request('https://raricy.test/api/upload', { method: 'POST', body: form });
  }
  const upload = kind === 'image' ? uploadImage : uploadAudio;
  const responses = await Promise.all([upload(request()), upload(request())]);
  expect(responses.map((r) => r.status).sort()).toEqual([200, 400]);
  expect((await model.aggregate({ where: { authorId: user.id, ignore: false }, _sum: { fileSize: true } }))._sum.fileSize).toBe(quota);
  expect(fs.readdirSync(kind === 'image' ? imageDir : audioDir)).toHaveLength(1);
});
