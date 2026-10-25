// GET /api/audio/:id/raw —— 字节下发与 **HTTP Range**。
//
// 【为什么单独测这个，而且测得这么细】Range 是本功能唯一没有现成样板的一段，
// 也是**唯一会以「播放器行为很怪」而不是报错的形式坏掉**的一段：
//   · 没有 `Content-Length` / `Content-Range` → 浏览器不知道段有多长，拖动错乱；
//   · 该 206 却回了 200 → Safari 直接不出声（它先发 `bytes=0-1` 探测）；
//   · 该 416 却抛异常 → 一次媒体请求变成 500；
//   · 畸形头没挡住 → `parseInt` 的 NaN 会安静地变成「全程」或「0 字节」，
//     既不是 200 也不是 416，是个没人定义过的响应。
// 最后一条尤其值得打：它不抛错、不告警，只是返回一批没人预期的字节。
//
// 本文件打的是真实 route handler（不 mock Prisma，不 mock fs），只 mock 登录态。

import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// ⚠️ 上传目录必须在任何 audioStoragePathFor 之前指向临时目录。
// 漏了它，测试会往开发者本机的真实 instance/audio/ 里写 —— 不报错、只有数据被污染。
const TEST_UPLOAD_DIR = path.resolve(import.meta.dirname, '../.tmp/audio-raw-test');
process.env.AUDIO_UPLOAD_FOLDER = TEST_UPLOAD_DIR;

// 只替换 getCurrentUser，保留真实的 hasAdminRights —— 私有档的鉴权本身是被测语义
const mockUser = vi.hoisted(() => ({ current: null as unknown }));
vi.mock('@/lib/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth')>();
  return { ...actual, getCurrentUser: async () => mockUser.current };
});

import { resetDb, makeUser } from '../helpers/db';
import { prisma } from '../helpers/db';
import { audioStoragePathFor } from '@/lib/audio-upload';
import { GET as rawGet } from '@/app/api/audio/[id]/raw/route';

/** 兜底：确认没指到真实目录（Windows 路径是反斜杠，归一化后校验）。 */
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
  assertTempDir();
  fs.rmSync(TEST_UPLOAD_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_UPLOAD_DIR, { recursive: true });
  await resetDb();
  mockUser.current = null;
});

// ── 夹具 ─────────────────────────────────────────────────────────────────────

const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
let seq = 0;
function uid(): string {
  // 不用 Date.now()：本套件与全仓单测共用假定时器的约定，时间不该进 fixture
  seq += 1;
  let s = String(seq).padStart(4, '0');
  while (s.length < 10) s += ALNUM[(seq * 7 + s.length) % ALNUM.length];
  return s.slice(0, 10);
}

/** 造一段内容可预测的字节：第 i 字节 = i & 0xff，切片断言才能逐字节比对。 */
function makeBytes(size: number): Buffer {
  const buf = Buffer.alloc(size);
  for (let i = 0; i < size; i += 1) buf[i] = i & 0xff;
  return buf;
}

const AUDIO_SIZE = 1000;

/**
 * 造一行 DB 记录 + 一份磁盘文件。
 * ⚠️ Content-Type 取的是**落库的** mimeType（上传时 verifyAudioMime 认过的规范值），
 * 所以夹具直接写规范值，模拟真实落库形态。
 */
async function seedAudio(opts: {
  authorId: string;
  isPublic?: boolean;
  ignore?: boolean;
  size?: number;
  mimeType?: string;
}): Promise<{ id: string; bytes: Buffer }> {
  const id = uid();
  const mimeType = opts.mimeType ?? 'audio/mpeg';
  const bytes = makeBytes(opts.size ?? AUDIO_SIZE);
  await prisma.audioHosting.create({
    data: {
      id,
      filename: 'voice.mp3',
      fileSize: bytes.length,
      mimeType,
      authorId: opts.authorId,
      isPublic: opts.isPublic ?? true,
      ignore: opts.ignore ?? false,
    },
  });
  fs.writeFileSync(audioStoragePathFor(id, mimeType), bytes);
  return { id, bytes };
}

function req(id: string, range?: string, headers: Record<string, string> = {}): Request {
  return new Request(`http://localhost/api/audio/${id}/raw`, {
    headers: { ...(range ? { Range: range } : {}), ...headers },
  });
}
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

async function bodyOf(res: Response): Promise<Buffer> {
  return Buffer.from(await res.arrayBuffer());
}

// ═══ 一、无 Range：全量 200 ═══════════════════════════════════════════════════

describe('无 Range / 畸形 Range → 全量 200', () => {
  it('不带 Range 头 → 200，整份字节，Content-Length 与文件等长', async () => {
    const user = await makeUser();
    const { id, bytes } = await seedAudio({ authorId: user.id });

    const res = await rawGet(req(id), ctx(id));
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Length')).toBe(String(bytes.length));
    expect(res.headers.get('Accept-Ranges')).toBe('bytes');
    // 全量响应**不该**有 Content-Range（那是 206 才有的头）
    expect(res.headers.get('Content-Range')).toBeNull();
    expect(await bodyOf(res)).toEqual(bytes);
  });

  it('Content-Type 取落库的 mimeType，并带 nosniff', async () => {
    const user = await makeUser();
    const { id } = await seedAudio({ authorId: user.id, mimeType: 'audio/ogg' });

    const res = await rawGet(req(id), ctx(id));
    expect(res.headers.get('Content-Type')).toBe('audio/ogg');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
  });

  it('**不设** Content-Disposition：音频是要内联播放的，不是下载', async () => {
    const user = await makeUser();
    const { id } = await seedAudio({ authorId: user.id });
    const res = await rawGet(req(id), ctx(id));
    expect(res.headers.get('Content-Disposition')).toBeNull();
  });

  it('畸形 Range 一律当「没给」，回 200 全量 —— 绝不 500、绝不空响应', async () => {
    const user = await makeUser();
    const { id, bytes } = await seedAudio({ authorId: user.id });

    // 每一条都是「parseInt 会给出 NaN」或「单位不认识」的形态。
    // 不加严格校验的话，NaN 参与的比较全是 false，会静默落进某个没定义过的分支。
    const malformed = [
      'bytes=abc',
      'bytes=abc-def',
      'bytes=-',
      'bytes=',
      'items=0-99',
      'bytes=0-99-200',
      'bytes=1.5-3',
      'bytes=-1.5',
      'bytes=0x10-20',
    ];
    for (const r of malformed) {
      const res = await rawGet(req(id, r), ctx(id));
      expect(res.status, `Range: ${r} 应当被当作「没给」`).toBe(200);
      expect(await bodyOf(res), `Range: ${r} 应当回全量`).toEqual(bytes);
    }
  });

  it('多段 Range 当「没给」处理，不做 multipart/byteranges', async () => {
    const user = await makeUser();
    const { id, bytes } = await seedAudio({ authorId: user.id });

    const res = await rawGet(req(id, 'bytes=0-99,200-299'), ctx(id));
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).not.toContain('multipart');
    expect(await bodyOf(res)).toEqual(bytes);
  });
});

// ═══ 二、三种合法形态 → 206 ═══════════════════════════════════════════════════

describe('合法 Range → 206 + 正确的 Content-Range', () => {
  it('`bytes=0-99` → 前 100 字节', async () => {
    const user = await makeUser();
    const { id, bytes } = await seedAudio({ authorId: user.id });

    const res = await rawGet(req(id, 'bytes=0-99'), ctx(id));
    expect(res.status).toBe(206);
    expect(res.headers.get('Content-Range')).toBe(`bytes 0-99/${AUDIO_SIZE}`);
    expect(res.headers.get('Content-Length')).toBe('100');
    expect(await bodyOf(res)).toEqual(bytes.subarray(0, 100));
  });

  it('`bytes=100-199` → 中段（下标对得上，不是从头切）', async () => {
    const user = await makeUser();
    const { id, bytes } = await seedAudio({ authorId: user.id });

    const res = await rawGet(req(id, 'bytes=100-199'), ctx(id));
    expect(res.status).toBe(206);
    expect(res.headers.get('Content-Range')).toBe(`bytes 100-199/${AUDIO_SIZE}`);
    expect(await bodyOf(res)).toEqual(bytes.subarray(100, 200));
  });

  it('`bytes=0-` → 从 0 到末尾，仍是 206', async () => {
    const user = await makeUser();
    const { id, bytes } = await seedAudio({ authorId: user.id });

    const res = await rawGet(req(id, 'bytes=0-'), ctx(id));
    expect(res.status).toBe(206);
    expect(res.headers.get('Content-Range')).toBe(`bytes 0-${AUDIO_SIZE - 1}/${AUDIO_SIZE}`);
    expect(await bodyOf(res)).toEqual(bytes);
  });

  it('`bytes=900-` → 尾段', async () => {
    const user = await makeUser();
    const { id, bytes } = await seedAudio({ authorId: user.id });

    const res = await rawGet(req(id, 'bytes=900-'), ctx(id));
    expect(res.status).toBe(206);
    expect(res.headers.get('Content-Range')).toBe(`bytes 900-999/${AUDIO_SIZE}`);
    expect(await bodyOf(res)).toEqual(bytes.subarray(900));
  });

  it('`bytes=-100`（后缀形）→ 最后 100 字节', async () => {
    const user = await makeUser();
    const { id, bytes } = await seedAudio({ authorId: user.id });

    const res = await rawGet(req(id, 'bytes=-100'), ctx(id));
    expect(res.status).toBe(206);
    expect(res.headers.get('Content-Range')).toBe(`bytes 900-999/${AUDIO_SIZE}`);
    expect(await bodyOf(res)).toEqual(bytes.subarray(900));
  });

  it('`bytes=-99999`（后缀比文件还长）→ 夹成整个文件', async () => {
    const user = await makeUser();
    const { id, bytes } = await seedAudio({ authorId: user.id });

    const res = await rawGet(req(id, 'bytes=-99999'), ctx(id));
    expect(res.status).toBe(206);
    expect(res.headers.get('Content-Range')).toBe(`bytes 0-${AUDIO_SIZE - 1}/${AUDIO_SIZE}`);
    expect(await bodyOf(res)).toEqual(bytes);
  });

  it('末端超出文件长度 → 夹住，而不是报错', async () => {
    const user = await makeUser();
    const { id, bytes } = await seedAudio({ authorId: user.id });

    const res = await rawGet(req(id, 'bytes=900-99999'), ctx(id));
    expect(res.status).toBe(206);
    expect(res.headers.get('Content-Range')).toBe(`bytes 900-999/${AUDIO_SIZE}`);
    expect(await bodyOf(res)).toEqual(bytes.subarray(900));
  });

  it('单字节探测 `bytes=0-1` —— **Safari 就是这么开场的**，必须回 206', async () => {
    const user = await makeUser();
    const { id, bytes } = await seedAudio({ authorId: user.id });

    const res = await rawGet(req(id, 'bytes=0-1'), ctx(id));
    expect(res.status).toBe(206);
    expect(res.headers.get('Content-Range')).toBe(`bytes 0-1/${AUDIO_SIZE}`);
    expect(await bodyOf(res)).toEqual(bytes.subarray(0, 2));
  });

  it('★ 200 与 206 都是 `public, no-cache` + 同一个 ETag（都不许 immutable）', async () => {
    const user = await makeUser();
    const { id } = await seedAudio({ authorId: user.id });

    const partial = await rawGet(req(id, 'bytes=0-99'), ctx(id));
    expect(partial.status).toBe(206);
    const full = await rawGet(req(id), ctx(id));
    expect(full.status).toBe(200);

    for (const res of [partial, full]) {
      const cc = res.headers.get('Cache-Control');
      expect(cc, 'immutable / max-age 会让软删的音频在访客那里继续能播').toBe(
        'public, no-cache'
      );
      expect(cc).not.toContain('immutable');
      expect(res.headers.get('ETag')).toMatch(/^W\/"\d+-\d+"$/);
    }
    // 两边必须是同一个验证器：播放器拿全量那份去验证分段请求，不一致就永远重下。
    expect(partial.headers.get('ETag')).toBe(full.headers.get('ETag'));
  });
});

// ═══ 二·五、条件请求 ═══════════════════════════════════════════════════════════
//
// 背景：音频的删除是软删，同一个 URL 从此 404。所以缓存不能是「一年别回来问」，
// 必须是「每次用之前验证」—— 没变 304（零字节），删了 404。这一节钉的就是
// 「验证不能盖过删除」与「200/206 共用同一个 ETag」。

describe('条件请求（软删后必须能失效）', () => {
  it('If-None-Match 命中 → 304，零字节，且缓存头原样带回', async () => {
    const user = await makeUser();
    const { id } = await seedAudio({ authorId: user.id });
    const etag = (await rawGet(req(id), ctx(id))).headers.get('ETag')!;

    const res = await rawGet(req(id, undefined, { 'if-none-match': etag }), ctx(id));
    expect(res.status).toBe(304);
    expect(res.headers.get('ETag')).toBe(etag);
    expect(res.headers.get('Cache-Control')).toBe('public, no-cache');
    expect((await bodyOf(res)).byteLength, '304 不能带 body').toBe(0);
  });

  it('带 Range 的验证请求同样回 304（RFC 9110 §13.1.3：If-None-Match 先于 Range）', async () => {
    const user = await makeUser();
    const { id } = await seedAudio({ authorId: user.id });
    const etag = (await rawGet(req(id), ctx(id))).headers.get('ETag')!;

    const res = await rawGet(req(id, 'bytes=0-99', { 'if-none-match': etag }), ctx(id));
    expect(res.status).toBe(304);
    expect((await bodyOf(res)).byteLength).toBe(0);
  });

  it('★ 软删之后，带着匹配的 ETag 也必须 404（删除赢过缓存验证）', async () => {
    const user = await makeUser();
    const { id } = await seedAudio({ authorId: user.id });
    const etag = (await rawGet(req(id), ctx(id))).headers.get('ETag')!;

    await prisma.audioHosting.update({ where: { id }, data: { ignore: true } });
    const res = await rawGet(req(id, undefined, { 'if-none-match': etag }), ctx(id));
    expect(res.status, '304 = 浏览器继续播放已经删掉的音频').toBe(404);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });

  it('★ 404 一律 no-store（删音频的反馈不能被记住）', async () => {
    const user = await makeUser();
    const deleted = await seedAudio({ authorId: user.id, ignore: true });
    expect((await rawGet(req(deleted.id), ctx(deleted.id))).headers.get('Cache-Control')).toBe(
      'no-store'
    );
    expect((await rawGet(req('nope123456'), ctx('nope123456'))).headers.get('Cache-Control')).toBe(
      'no-store'
    );
  });

  it('磁盘文件被换掉（大小变）→ ETag 变，旧 ETag 不再 304', async () => {
    const user = await makeUser();
    const { id } = await seedAudio({ authorId: user.id });
    const etag = (await rawGet(req(id), ctx(id))).headers.get('ETag')!;

    fs.writeFileSync(audioStoragePathFor(id, 'audio/mpeg'), makeBytes(AUDIO_SIZE + 7));
    const res = await rawGet(req(id, undefined, { 'if-none-match': etag }), ctx(id));
    expect(res.status).toBe(200);
    expect(res.headers.get('ETag')).not.toBe(etag);
  });

  it('私有音频不发 ETag（no-store 下条件请求无意义，也不能缓存鉴权结果）', async () => {
    const author = await makeUser();
    const { id } = await seedAudio({ authorId: author.id, isPublic: false });
    mockUser.current = author;

    const res = await rawGet(req(id), ctx(id));
    expect(res.status).toBe(200);
    expect(res.headers.get('ETag')).toBeNull();
  });
});

// ═══ 三、不可满足 → 416 ═══════════════════════════════════════════════════════

describe('不可满足的 Range → 416 + `bytes */total`', () => {
  it('起点超出文件长度 → 416（不是 200、更不是 500）', async () => {
    const user = await makeUser();
    const { id } = await seedAudio({ authorId: user.id });

    const res = await rawGet(req(id, `bytes=${AUDIO_SIZE}-`), ctx(id));
    expect(res.status).toBe(416);
    expect(res.headers.get('Content-Range')).toBe(`bytes */${AUDIO_SIZE}`);
  });

  it('起点与终点都超出 → 416', async () => {
    const user = await makeUser();
    const { id } = await seedAudio({ authorId: user.id });

    const res = await rawGet(req(id, 'bytes=2000-3000'), ctx(id));
    expect(res.status).toBe(416);
  });

  it('`bytes=-0` → 416（RFC 7233：后缀长度 0 不可满足）', async () => {
    const user = await makeUser();
    const { id } = await seedAudio({ authorId: user.id });

    const res = await rawGet(req(id, 'bytes=-0'), ctx(id));
    expect(res.status).toBe(416);
    expect(res.headers.get('Content-Range')).toBe(`bytes */${AUDIO_SIZE}`);
  });
});

// ═══ 四、可见性与软删 ═════════════════════════════════════════════════════════

describe('可见性 / 软删', () => {
  it('已软删 → 404（对所有人，包括作者本人）', async () => {
    const user = await makeUser();
    const { id } = await seedAudio({ authorId: user.id, ignore: true });
    mockUser.current = user;

    const res = await rawGet(req(id), ctx(id));
    expect(res.status).toBe(404);
  });

  it('私有 + 匿名 → 404（伪装成不存在，不泄露「这里有一条）」', async () => {
    const user = await makeUser();
    const { id } = await seedAudio({ authorId: user.id, isPublic: false });
    mockUser.current = null;

    const res = await rawGet(req(id), ctx(id));
    expect(res.status).toBe(404);
  });

  it('私有 + 非作者的普通用户 → 404', async () => {
    const author = await makeUser();
    const other = await makeUser();
    const { id } = await seedAudio({ authorId: author.id, isPublic: false });
    mockUser.current = other;

    const res = await rawGet(req(id), ctx(id));
    expect(res.status).toBe(404);
  });

  it('私有 + 作者本人 → 200，且 Cache-Control 是 private, no-store', async () => {
    const author = await makeUser();
    const { id, bytes } = await seedAudio({ authorId: author.id, isPublic: false });
    mockUser.current = author;

    const res = await rawGet(req(id), ctx(id));
    expect(res.status).toBe(200);
    expect(await bodyOf(res)).toEqual(bytes);
    // 私有档绝不能进共享缓存：缓存命中会绕过这里的鉴权
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    expect(res.headers.get('X-Robots-Tag')).toBe('noindex');
  });

  it('不存在的 id → 404（Range 头在也不炸）', async () => {
    const res = await rawGet(req('nope123456', 'bytes=0-99'), ctx('nope123456'));
    expect(res.status).toBe(404);
  });

  it('行在但磁盘文件没了 → 404（不是 500）', async () => {
    const user = await makeUser();
    const { id } = await seedAudio({ authorId: user.id });
    fs.rmSync(audioStoragePathFor(id, 'audio/mpeg'));

    const res = await rawGet(req(id, 'bytes=0-99'), ctx(id));
    expect(res.status).toBe(404);
  });
});
