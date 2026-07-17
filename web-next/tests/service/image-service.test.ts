// image-service.ts / image-upload.ts —— 图床（元信息读取 + 二进制上传 + 删除）。
//
// 【为什么值得重点测】
//  1. **安全**：CLAUDE.md 把「SVG XSS 防护」和「文件名净化」明确列为安全设计。
//     文件名净化一旦回退，攻击面是路径穿越（写盘逃出上传目录）；SVG 一旦以
//     inline 下发，攻击面是同源 XSS（SVG 里可以写 <script>）。这两条必须钉死。
//  2. **配额**：core 50MB / admin 50MB / owner 100MB 是 CLAUDE.md 写死的数字，
//     算错要么用户传不上图，要么磁盘被打爆。边界（恰好满 / 超 1 字节）尤其关键。
//  3. **软删 vs 硬删**：语义不同（保留磁盘文件 vs 删盘 + 删库行），弄反会丢数据。
//
// 【磁盘安全】所有涉及 IO 的用例只碰 tests/.tmp/images-test/，
// 绝不碰 data/ 或 ../instance/images 里的真实图片 —— 见下方 TEST_UPLOAD_DIR 与
// assertTempDir()（硬校验，防止 getUploadFolder() 回落到真实目录）。

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from 'vitest';

import {
  extForMime,
  listUserImages,
  listAllImages,
  getTotalStorageBytes,
  getImageMeta,
  getImageForServe,
  softDeleteImage,
  hardDeleteImage,
} from '@/lib/image-service';
import {
  ALLOWED_MIMETYPES,
  MAX_IMAGE_SIZE,
  QUOTA_LIMITS_MB,
  sanitizeFilename,
  getQuotaLimitMb,
  getUserUsedBytes,
  generateImageId,
  storagePathFor,
  getUploadFolder,
  saveUpload,
  detectImageMime,
  verifyImageMime,
} from '@/lib/image-upload';
import { resetDb, makeUser, prisma } from '../helpers/db';

// ── 磁盘隔离 ────────────────────────────────────────────────────────────────
//
// getUploadFolder() 的默认值是 `../instance/images`（Flask 仓库里的真实图片）。
// 必须在任何 saveUpload / storagePathFor 之前把它指向临时目录。
// 环境变量是运行时读取的（不是模块加载时快照），所以在这里赋值即可生效。

const TEST_UPLOAD_DIR = path.resolve(import.meta.dirname, '../.tmp/images-test');
process.env.IMAGE_UPLOAD_FOLDER = TEST_UPLOAD_DIR;

/** 硬校验：上传目录必须在 tests/.tmp/ 下，否则直接抛（防止误删真实图片）。 */
function assertTempDir() {
  const folder = getUploadFolder();
  if (!folder.includes(`${path.sep}tests${path.sep}.tmp${path.sep}`)) {
    throw new Error(`拒绝在非临时目录上跑图床用例：${folder}`);
  }
}

beforeAll(() => {
  assertTempDir();
  fs.mkdirSync(TEST_UPLOAD_DIR, { recursive: true });
});

afterAll(() => {
  assertTempDir();
  fs.rmSync(TEST_UPLOAD_DIR, { recursive: true, force: true });
});

beforeEach(async () => {
  await resetDb();
  assertTempDir();
  fs.rmSync(TEST_UPLOAD_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_UPLOAD_DIR, { recursive: true });
});

// ── 夹具 ────────────────────────────────────────────────────────────────────

let imgSeq = 0;

/** 造一条图床记录（只落库，不写盘）。 */
async function makeImage(opts: Partial<{
  id: string;
  authorId: string;
  filename: string;
  fileSize: number;
  mimeType: string;
  createdAt: Date | null;
  isPublic: boolean;
  ignore: boolean;
}> = {}) {
  const id = opts.id ?? `img${String(++imgSeq).padStart(7, '0')}`;
  const authorId = opts.authorId ?? (await makeUser({ role: 'core' })).id;
  return prisma.imageHosting.create({
    data: {
      id,
      authorId,
      filename: opts.filename ?? `f_${id}.png`,
      fileSize: opts.fileSize ?? 1024,
      mimeType: opts.mimeType ?? 'image/png',
      createdAt: opts.createdAt === undefined ? new Date() : opts.createdAt,
      isPublic: opts.isPublic ?? true,
      ignore: opts.ignore ?? false,
    },
  });
}

/** 造一张真 PNG 字节（sharp 生成，供压缩/上传路径使用）。 */
async function pngBytes(w = 12, h = 12): Promise<Buffer> {
  const sharp = (await import('sharp')).default;
  return sharp({
    create: { width: w, height: h, channels: 3, background: { r: 200, g: 30, b: 30 } },
  })
    .png()
    .toBuffer();
}

const MB = 1024 * 1024;

// ═════════════════════════════════════════════════════════════════════════════
// 一、sanitizeFilename —— 路径穿越 / XSS 防护（CLAUDE.md 明确列为安全设计）
// ═════════════════════════════════════════════════════════════════════════════
//
// 对照 Flask sanitize_filename：
//   re.sub(r'[^\w.\- 一-鿿]', '', name)  → 只保留 Unicode 字母数字/下划线/点/连字符/空格
//   折叠连续点、折叠连续空格、lstrip('. -')、截断 200、空则 'image'
//
// 这里最重要的不变式是「产出永远不能当作路径片段用」—— 见 describe 末尾的性质测试。

describe('sanitizeFilename（文件名净化）', () => {
  describe('路径穿越', () => {
    it('POSIX 路径穿越 ../../etc/passwd 被拍平成无害的普通名', async () => {
      // 斜杠被删 → '....etcpasswd' → 折叠点 → '.etcpasswd' → 去前导点 → 'etcpasswd'
      expect(sanitizeFilename('../../etc/passwd')).toBe('etcpasswd');
    });

    it('Windows 路径穿越 ..\\..\\windows\\system32 同样被拍平', async () => {
      expect(sanitizeFilename('..\\..\\windows\\system32')).toBe('windowssystem32');
    });

    it('绝对路径 /etc/shadow 丢掉根斜杠，不再是绝对路径', async () => {
      const out = sanitizeFilename('/etc/shadow');
      expect(out).toBe('etcshadow');
      expect(path.isAbsolute(out), '净化后绝不能仍是绝对路径').toBe(false);
    });

    it('URL 编码的穿越 %2e%2e%2f 不会被解码（百分号被删，不产生 ../）', async () => {
      // 防的是「净化后再被某处 decodeURIComponent 还原成 ../」
      const out = sanitizeFilename('%2e%2e%2fetc%2fpasswd');
      expect(out).not.toContain('%');
      expect(decodeURIComponent(out)).not.toContain('..');
    });

    it('前导点被剥离（防止写出 .bashrc 这类隐藏文件）', async () => {
      expect(sanitizeFilename('.bashrc')).toBe('bashrc');
      expect(sanitizeFilename('...hidden')).toBe('hidden');
    });

    it('前导连字符被剥离（防止文件名被当作命令行参数）', async () => {
      expect(sanitizeFilename('-rf.png')).toBe('rf.png');
      expect(sanitizeFilename('--force')).toBe('force');
    });

    it('单独的 . 与 .. 都不会原样漏出（否则拼路径即为目录引用）', async () => {
      expect(sanitizeFilename('.')).toBe('image');
      expect(sanitizeFilename('..')).toBe('image');
      expect(sanitizeFilename('../')).toBe('image');
    });
  });

  describe('注入字符', () => {
    it('NUL 字节被剥离（C 层截断攻击：a.png\\0.php）', async () => {
      const out = sanitizeFilename('a.png\u0000.php');
      expect(out).not.toContain('\u0000');
      expect(out).toBe('a.png.php');
    });

    it('换行/回车/制表被剥离（防 HTTP 响应头注入）', async () => {
      const out = sanitizeFilename('a\r\nContent-Type: text/html\tb.png');
      expect(/[\r\n\t]/.test(out), '净化产物进过 Content-Disposition 头，不能含 CR/LF').toBe(false);
    });

    it('HTML/JS 注入字符被剥离（文件名会被渲染进页面）', async () => {
      const out = sanitizeFilename('<script>alert(1)</script>.png');
      expect(out).toBe('scriptalert1script.png');
      expect(/[<>'"&()]/.test(out)).toBe(false);
    });

    it('引号被剥离（否则可越出 Content-Disposition 的 filename="..." 引号）', async () => {
      const out = sanitizeFilename('a".svg');
      expect(out).not.toContain('"');
    });
  });

  describe('长度 / 空值', () => {
    it('超长名截断到 200 字符', async () => {
      expect(sanitizeFilename('a'.repeat(300))).toHaveLength(200);
    });

    it('恰好 200 字符不被截断（边界是 <=200 保留）', async () => {
      expect(sanitizeFilename('a'.repeat(200))).toHaveLength(200);
    });

    it('净化后为空时回落到 image（绝不返回空串）', async () => {
      expect(sanitizeFilename('')).toBe('image');
      expect(sanitizeFilename('///')).toBe('image');
      expect(sanitizeFilename('   ')).toBe('image');
      expect(sanitizeFilename('!!!@@@###')).toBe('image');
    });

    it('null / undefined 不抛错，回落到 image（?? 兜底）', async () => {
      expect(sanitizeFilename(null as unknown as string)).toBe('image');
      expect(sanitizeFilename(undefined as unknown as string)).toBe('image');
    });
  });

  describe('Unicode', () => {
    it('中文名原样保留（对齐 Flask 的 一-鿿 白名单）', async () => {
      expect(sanitizeFilename('照片.png')).toBe('照片.png');
      expect(sanitizeFilename('聪明山_封面 2026.jpg')).toBe('聪明山_封面 2026.jpg');
    });

    it('日文 / 韩文 / 西里尔 / 带音标拉丁字母保留（\\p{L} 覆盖全部书写系统）', async () => {
      expect(sanitizeFilename('画像.png')).toBe('画像.png');
      expect(sanitizeFilename('사진.png')).toBe('사진.png');
      expect(sanitizeFilename('фото.png')).toBe('фото.png');
      expect(sanitizeFilename('café.png')).toBe('café.png');
    });

    it('阿拉伯数字与其它数字系统保留（\\p{N}）', async () => {
      expect(sanitizeFilename('2026年.png')).toBe('2026年.png');
    });

    it('emoji 被剥离（不是 \\p{L}/\\p{N}）—— 记录现状', async () => {
      // 🐱.png → 删 emoji → '.png' → 去前导点 → 'png'（扩展名被吃掉，仅记录）
      expect(sanitizeFilename('🐱.png')).toBe('png');
      // 纯 emoji 名则完全回落
      expect(sanitizeFilename('🐱🐟')).toBe('image');
    });

    it('RTL override 等不可见控制字符被剥离（防文件名视觉欺骗）', async () => {
      // gnp.exe 用 U+202E 伪装成 exe.png —— 控制字符必须删掉
      const out = sanitizeFilename('a‮gnp.exe');
      expect(out).not.toContain('‮');
    });
  });

  describe('折叠规则', () => {
    it('连续点折叠为单点（a..b...c.png → a.b.c.png）', async () => {
      expect(sanitizeFilename('a..b...c.png')).toBe('a.b.c.png');
    });

    it('连续空格折叠为单空格', async () => {
      expect(sanitizeFilename('a    b.png')).toBe('a b.png');
    });

    it('正常文件名原样通过（净化不能误伤）', async () => {
      expect(sanitizeFilename('my-photo_01.png')).toBe('my-photo_01.png');
      expect(sanitizeFilename('IMG 2026.jpeg')).toBe('IMG 2026.jpeg');
    });
  });

  // ── 核心不变式：无论输入什么，产出都不能当路径片段逃出目录 ─────────────────
  describe('★ 不变式：产出永不含路径分隔符、永不逃出上传目录', () => {
    const EVIL = [
      '../../etc/passwd',
      '..\\..\\..\\windows\\system32\\cmd.exe',
      '/etc/shadow',
      './../../a',
      'a/b/c.png',
      'a\u0000/../../b',
      '....//....//etc/passwd',
      '..;/..;/etc',
      '~/.ssh/id_rsa',
      '$HOME/.aws/credentials',
      'C:\\Windows\\win.ini',
      '\\\\server\\share\\file',
      '.'.repeat(500),
      '../'.repeat(100) + 'passwd',
    ];

    it.each(EVIL)('净化 %j 后不含 / 或 \\ 或 NUL', (input) => {
      const out = sanitizeFilename(input);
      expect(out).not.toContain('/');
      expect(out).not.toContain('\\');
      expect(out).not.toContain('\u0000');
      expect(out.length, '永不为空').toBeGreaterThan(0);
    });

    it.each(EVIL)('把净化产物当路径片段拼进上传目录，仍在目录内：%j', (input) => {
      const out = sanitizeFilename(input);
      const joined = path.resolve(path.join(TEST_UPLOAD_DIR, out));
      expect(
        joined.startsWith(TEST_UPLOAD_DIR + path.sep),
        `逃出上传目录：${input} → ${out} → ${joined}`
      ).toBe(true);
      expect(path.dirname(joined), '必须正好落在上传目录一层内').toBe(TEST_UPLOAD_DIR);
    });

    it('净化是幂等的（再净化一次结果不变）', async () => {
      for (const input of EVIL) {
        const once = sanitizeFilename(input);
        expect(sanitizeFilename(once), `幂等性对 ${input} 不成立`).toBe(once);
      }
    });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 二、storagePathFor —— 真正决定落盘位置的函数
// ═════════════════════════════════════════════════════════════════════════════
//
// 注意：落盘路径用的是 **image_id + ext**，不是用户提供的 filename。
// 也就是说用户文件名压根不参与路径拼接 —— 这才是路径穿越防不住也无所谓的根因。
// filename 只作为「展示名 / 下载名」存库。下面把这个结构性事实钉死。

describe('storagePathFor（磁盘路径）', () => {
  it('路径 = 上传目录/<id><ext>，与用户文件名完全无关', async () => {
    expect(storagePathFor('AbCdEf1234', 'image/png')).toBe(
      path.join(TEST_UPLOAD_DIR, 'AbCdEf1234.png')
    );
    expect(storagePathFor('AbCdEf1234', 'image/jpeg')).toBe(
      path.join(TEST_UPLOAD_DIR, 'AbCdEf1234.jpg')
    );
    expect(storagePathFor('AbCdEf1234', 'image/svg+xml')).toBe(
      path.join(TEST_UPLOAD_DIR, 'AbCdEf1234.svg')
    );
  });

  it('未知 MIME 时无扩展名（对齐 Flask ext_map.get(mime, "")）', async () => {
    expect(storagePathFor('AbCdEf1234', 'application/x-msdownload')).toBe(
      path.join(TEST_UPLOAD_DIR, 'AbCdEf1234')
    );
  });

  it('getUploadFolder 优先读 IMAGE_UPLOAD_FOLDER 环境变量', async () => {
    expect(getUploadFolder()).toBe(TEST_UPLOAD_DIR);
  });

  it('★ 由 generateImageId 产出的 ID 拼出的路径必在上传目录内（100 次抽样）', async () => {
    for (let i = 0; i < 100; i++) {
      const p = path.resolve(storagePathFor(generateImageId(), 'image/png'));
      expect(p.startsWith(TEST_UPLOAD_DIR + path.sep), `逃出目录：${p}`).toBe(true);
    }
  });

  it('⚠️ storagePathFor 不校验 id —— 恶意 id 可逃出目录（记录现状，见交付说明）', async () => {
    // 现实中 id 只来自 generateImageId() 或 DB 查询命中的行，攻击者无法注入。
    // 但函数本身没有防线：一旦将来有调用方把用户输入直接当 id 传进来就会穿越。
    const escaped = path.resolve(storagePathFor('../../../etc/passwd', 'image/png'));
    expect(
      escaped.startsWith(TEST_UPLOAD_DIR + path.sep),
      `如实记录：storagePathFor 对未净化 id 会拼出 ${escaped}`
    ).toBe(false);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 三、generateImageId —— 10 位字母数字，加密安全
// ═════════════════════════════════════════════════════════════════════════════

describe('generateImageId', () => {
  it('默认长度为 10（对齐 Flask generate_image_id）', async () => {
    expect(generateImageId()).toHaveLength(10);
  });

  it('字符集限定为大小写字母 + 数字（无 -_ 等需转义字符，可安全进 URL / 文件名）', async () => {
    for (let i = 0; i < 200; i++) {
      const id = generateImageId();
      expect(/^[A-Za-z0-9]{10}$/.test(id), `非法 ID：${id}`).toBe(true);
      expect(encodeURIComponent(id), 'ID 不应需要 URL 转义').toBe(id);
    }
  });

  it('可指定长度', async () => {
    expect(generateImageId(1)).toHaveLength(1);
    expect(generateImageId(32)).toHaveLength(32);
  });

  it('大量生成无重复（20000 个）—— 碰撞会覆盖他人图片', async () => {
    const n = 20000;
    const set = new Set<string>();
    for (let i = 0; i < n; i++) set.add(generateImageId());
    expect(set.size, `${n} 个 ID 出现重复（应为 0 碰撞）`).toBe(n);
  });

  it('三个字符类都能出现（不是只从字母表某一段取，佐证分布未坏）', async () => {
    let upper = false;
    let lower = false;
    let digit = false;
    for (let i = 0; i < 500; i++) {
      const id = generateImageId();
      if (/[A-Z]/.test(id)) upper = true;
      if (/[a-z]/.test(id)) lower = true;
      if (/[0-9]/.test(id)) digit = true;
    }
    expect([upper, lower, digit]).toEqual([true, true, true]);
  });

  it('使用 node:crypto.randomInt（加密安全，非 Math.random）', async () => {
    // 只验证「确实走了 crypto」：Math.random 被劫持也不影响产出。
    const spy = vi.spyOn(Math, 'random').mockReturnValue(0);
    const id = generateImageId();
    spy.mockRestore();
    expect(/^[A-Za-z0-9]{10}$/.test(id)).toBe(true);
    expect(id, 'Math.random 恒为 0 时若 ID 变成全 A，说明用错了随机源').not.toBe('AAAAAAAAAA');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 四、配额 —— CLAUDE.md：core 50MB / admin 50MB / owner 100MB
// ═════════════════════════════════════════════════════════════════════════════

describe('getQuotaLimitMb（角色 → 配额）', () => {
  // 这三个数字直接来自 CLAUDE.md 与 Flask QUOTA_LIMITS_MB，改动必须是有意的。
  it('core = 50 MB', async () => {
    expect(getQuotaLimitMb('core')).toBe(50);
  });

  it('admin = 50 MB（与 core 相同，不是 100）', async () => {
    expect(getQuotaLimitMb('admin')).toBe(50);
  });

  it('owner = 100 MB', async () => {
    expect(getQuotaLimitMb('owner')).toBe(100);
  });

  it('普通 user = 0 —— 无权使用图床（0 是权限闸门，不是「无限」）', async () => {
    expect(
      getQuotaLimitMb('user'),
      'user 若返回非 0，未认证用户就能传图；若被当成「无限」则更糟'
    ).toBe(0);
  });

  it('未知角色 / null / undefined / 空串 → 0（fail-closed）', async () => {
    expect(getQuotaLimitMb('moderator')).toBe(0);
    expect(getQuotaLimitMb(null)).toBe(0);
    expect(getQuotaLimitMb(undefined)).toBe(0);
    expect(getQuotaLimitMb('')).toBe(0);
  });

  // 【回归】原型链属性名不得穿透。
  // 曾经的实现是 `QUOTA_LIMITS_MB[role ?? ''] ?? 0`，对象字面量带 Object.prototype，
  // 'constructor' / 'toString' 取到的是**函数**而非 undefined，`?? 0` 兜不住。
  // 连锁后果：路由的 `if (limitMb === 0) return 403` 判不出来 →
  // limitBytes = fn * 1024*1024 = NaN → `used + size > NaN` 恒为 false → **配额闸门全开**。
  // role 虽来自 DB（攻击者注入不进来），但这道闸门不该靠「数据一定干净」来维持。
  it('原型链属性名不穿透：constructor / toString / __proto__ 一律返回 0', () => {
    for (const key of ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf']) {
      const v = getQuotaLimitMb(key);
      expect(typeof v, `getQuotaLimitMb('${key}') 应返回 number，实际 ${typeof v}`).toBe('number');
      expect(v, `getQuotaLimitMb('${key}') 应为 0`).toBe(0);
    }
  });

  it('普通未知角色名返回 0', () => {
    expect(getQuotaLimitMb('moderator')).toBe(0);
    expect(getQuotaLimitMb('')).toBe(0);
    expect(getQuotaLimitMb(null)).toBe(0);
    expect(getQuotaLimitMb(undefined)).toBe(0);
  });

  it('导出的 QUOTA_LIMITS_MB 表本身没有多余角色', async () => {
    expect(Object.keys(QUOTA_LIMITS_MB).sort()).toEqual(['admin', 'core', 'owner']);
  });
});

describe('getUserUsedBytes（已用字节）', () => {
  it('无图片时返回 0（不是 null —— 调用方直接做加法）', async () => {
    const u = await makeUser({ role: 'core' });
    expect(await getUserUsedBytes(u.id)).toBe(0);
  });

  it('不存在的用户返回 0，不抛错', async () => {
    expect(await getUserUsedBytes('ghost')).toBe(0);
  });

  it('累加本人全部未软删图片的 fileSize', async () => {
    const u = await makeUser({ role: 'core' });
    await makeImage({ authorId: u.id, fileSize: 100 });
    await makeImage({ authorId: u.id, fileSize: 250 });
    expect(await getUserUsedBytes(u.id)).toBe(350);
  });

  it('不串用户（他人图片不占我的配额）', async () => {
    const a = await makeUser({ role: 'core' });
    const b = await makeUser({ role: 'core' });
    await makeImage({ authorId: b.id, fileSize: 9999 });
    expect(await getUserUsedBytes(a.id)).toBe(0);
  });

  it('★ 软删除的图片不再占配额（对齐 Flask ignore == False 过滤）', async () => {
    const u = await makeUser({ role: 'core' });
    const img = await makeImage({ authorId: u.id, fileSize: 1000 });
    expect(await getUserUsedBytes(u.id)).toBe(1000);

    await softDeleteImage(img.id);
    expect(
      await getUserUsedBytes(u.id),
      '软删后配额必须释放（磁盘文件仍在，是已知的空间泄漏 —— 见交付说明）'
    ).toBe(0);
  });

  it('ignore 为 NULL 的历史行也计入（Flask 侧 ignore 默认 False）', async () => {
    // schema 里 ignore 是 Boolean? —— 迁移来的老数据可能是 NULL。
    const u = await makeUser({ role: 'core' });
    const img = await makeImage({ authorId: u.id, fileSize: 500 });
    await prisma.$executeRawUnsafe(`UPDATE image_hosting SET ignore = NULL WHERE id = ?`, img.id);

    const used = await getUserUsedBytes(u.id);
    // 如实记录：Prisma 的 `ignore: false` 过滤在 SQL 里是 `ignore = 0`，NULL 不等于 0，
    // 故 NULL 行不会被计入 —— 见交付说明「可疑之处」。
    expect(used, `NULL ignore 行的计入行为（实测 used=${used}）`).toBe(0);
  });
});

describe('★ 配额边界（恰好满 / 超 1 字节）', () => {
  /** 复刻路由里的判定：used + incoming > limitBytes → 拒绝。 */
  async function wouldAccept(userId: string, role: string, incoming: number) {
    const limitBytes = getQuotaLimitMb(role) * MB;
    if (limitBytes === 0) return false;
    const used = await getUserUsedBytes(userId);
    return used + incoming <= limitBytes;
  }

  it('core：恰好用满 50MB 允许（边界是 <=，不是 <）', async () => {
    const u = await makeUser({ role: 'core' });
    await makeImage({ authorId: u.id, fileSize: 50 * MB - 100 });
    expect(await wouldAccept(u.id, 'core', 100), '正好填满最后 100 字节应放行').toBe(true);
  });

  it('core：超出 1 字节即拒绝', async () => {
    const u = await makeUser({ role: 'core' });
    await makeImage({ authorId: u.id, fileSize: 50 * MB - 100 });
    expect(await wouldAccept(u.id, 'core', 101), '多 1 字节必须拒绝').toBe(false);
  });

  it('core：已用满 50MB 后，再传 1 字节被拒', async () => {
    const u = await makeUser({ role: 'core' });
    await makeImage({ authorId: u.id, fileSize: 50 * MB });
    expect(await getUserUsedBytes(u.id)).toBe(50 * MB);
    expect(await wouldAccept(u.id, 'core', 1)).toBe(false);
  });

  it('owner：50MB 处仍有余量（core 会被拒的量 owner 放行）', async () => {
    const o = await makeUser({ role: 'owner' });
    await makeImage({ authorId: o.id, fileSize: 50 * MB });
    expect(await wouldAccept(o.id, 'owner', 1), 'owner 配额是 100MB').toBe(true);
    expect(await wouldAccept(o.id, 'core', 1), '同样用量下 core 口径应被拒').toBe(false);
  });

  it('owner：恰好用满 100MB 允许，超 1 字节拒绝', async () => {
    const o = await makeUser({ role: 'owner' });
    await makeImage({ authorId: o.id, fileSize: 100 * MB - 10 });
    expect(await wouldAccept(o.id, 'owner', 10)).toBe(true);
    expect(await wouldAccept(o.id, 'owner', 11)).toBe(false);
  });

  it('admin：与 core 同为 50MB（不因是管理员而放宽）', async () => {
    const a = await makeUser({ role: 'admin' });
    await makeImage({ authorId: a.id, fileSize: 50 * MB });
    expect(await wouldAccept(a.id, 'admin', 1)).toBe(false);
  });

  it('user：配额 0，空账户传 1 字节也被拒（角色闸门先于容量）', async () => {
    const u = await makeUser({ role: 'user' });
    expect(await getUserUsedBytes(u.id)).toBe(0);
    expect(await wouldAccept(u.id, 'user', 1), 'user 无权使用图床').toBe(false);
  });

  it('软删后腾出的空间可被重新使用（配额与软删的联动）', async () => {
    const u = await makeUser({ role: 'core' });
    const img = await makeImage({ authorId: u.id, fileSize: 50 * MB });
    expect(await wouldAccept(u.id, 'core', 1024)).toBe(false);

    await softDeleteImage(img.id);
    expect(await wouldAccept(u.id, 'core', 1024), '软删后应重新有额度').toBe(true);
  });

  it('单文件上限 10MB 与角色配额是两道独立闸门', async () => {
    expect(MAX_IMAGE_SIZE).toBe(10 * MB);
    const u = await makeUser({ role: 'core' });
    // 配额空空如也，但单文件超 10MB 仍应被上限拦下
    expect(await wouldAccept(u.id, 'core', 10 * MB + 1), '配额层面 10MB+1 < 50MB 是放行的').toBe(
      true
    );
    expect(10 * MB + 1 > MAX_IMAGE_SIZE, '但单文件闸门必须拦下').toBe(true);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 五、MIME 白名单 / 扩展名映射
// ═════════════════════════════════════════════════════════════════════════════

describe('ALLOWED_MIMETYPES / extForMime', () => {
  it('白名单恰好是 PNG/JPEG/GIF/WebP/SVG（对齐 Flask）', async () => {
    expect([...ALLOWED_MIMETYPES].sort()).toEqual([
      'image/gif',
      'image/jpeg',
      'image/png',
      'image/svg+xml',
      'image/webp',
    ]);
  });

  it('危险类型不在白名单（html / 脚本 / 可执行）', async () => {
    for (const bad of [
      'text/html',
      'image/svg', // 注意：不带 +xml 的写法不应被放行
      'application/javascript',
      'application/xhtml+xml',
      'text/xml',
      'application/octet-stream',
      '',
    ]) {
      expect(ALLOWED_MIMETYPES.has(bad), `${bad} 不应在白名单`).toBe(false);
    }
  });

  it('MIME → 扩展名映射', async () => {
    expect(extForMime('image/png')).toBe('.png');
    expect(extForMime('image/jpeg')).toBe('.jpg');
    expect(extForMime('image/gif')).toBe('.gif');
    expect(extForMime('image/webp')).toBe('.webp');
    expect(extForMime('image/svg+xml')).toBe('.svg');
  });

  it('未知 MIME → 空串（不抛错）', async () => {
    expect(extForMime('application/pdf')).toBe('');
    expect(extForMime('')).toBe('');
  });

  it('白名单里每个 MIME 都有扩展名（否则会落一个无后缀的裸文件）', async () => {
    for (const m of ALLOWED_MIMETYPES) {
      expect(extForMime(m), `${m} 缺少扩展名映射`).not.toBe('');
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 六、listUserImages —— 用户端列表
// ═════════════════════════════════════════════════════════════════════════════

describe('listUserImages', () => {
  it('只返回本人的图片（不能泄漏他人图床）', async () => {
    const a = await makeUser({ role: 'core' });
    const b = await makeUser({ role: 'core' });
    await makeImage({ authorId: a.id, filename: 'mine.png' });
    await makeImage({ authorId: b.id, filename: 'theirs.png' });

    const r = await listUserImages(a.id);
    expect(r).toHaveLength(1);
    expect(r[0].filename).toBe('mine.png');
  });

  it('排除软删除的图片', async () => {
    const u = await makeUser({ role: 'core' });
    await makeImage({ authorId: u.id, filename: 'alive.png' });
    await makeImage({ authorId: u.id, filename: 'dead.png', ignore: true });

    const r = await listUserImages(u.id);
    expect(r.map((i) => i.filename)).toEqual(['alive.png']);
  });

  it('按 createdAt 倒序（最新在前）', async () => {
    const u = await makeUser({ role: 'core' });
    await makeImage({ authorId: u.id, filename: 'old.png', createdAt: new Date('2026-01-01') });
    await makeImage({ authorId: u.id, filename: 'new.png', createdAt: new Date('2026-06-01') });
    await makeImage({ authorId: u.id, filename: 'mid.png', createdAt: new Date('2026-03-01') });

    const r = await listUserImages(u.id);
    expect(r.map((i) => i.filename)).toEqual(['new.png', 'mid.png', 'old.png']);
  });

  it('无图片时返回空数组', async () => {
    const u = await makeUser({ role: 'core' });
    expect(await listUserImages(u.id)).toEqual([]);
  });

  it('DTO 字段完整：ext 由 mime 推导，url 指向 /api/images/:id/raw，带上传者用户名', async () => {
    const u = await makeUser({ role: 'core', username: 'shooter' });
    const img = await makeImage({
      authorId: u.id,
      filename: 'p.jpg',
      fileSize: 2048,
      mimeType: 'image/jpeg',
      createdAt: new Date('2026-05-05T01:02:03.000Z'),
    });

    const [dto] = await listUserImages(u.id);
    expect(dto).toEqual({
      id: img.id,
      filename: 'p.jpg',
      fileSize: 2048,
      mimeType: 'image/jpeg',
      authorId: u.id,
      authorName: 'shooter',
      createdAt: new Date('2026-05-05T01:02:03.000Z'),
      isPublic: true,
      ext: '.jpg',
      url: `/api/images/${img.id}/raw`,
    });
  });

  it('isPublic 为 NULL 的历史行序列化为 true（?? true 兜底）', async () => {
    const u = await makeUser({ role: 'core' });
    const img = await makeImage({ authorId: u.id });
    await prisma.$executeRawUnsafe(`UPDATE image_hosting SET is_public = NULL WHERE id = ?`, img.id);

    const [dto] = await listUserImages(u.id);
    expect(dto.isPublic).toBe(true);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 七、listAllImages —— 管理端列表 / 搜索 / 分页
// ═════════════════════════════════════════════════════════════════════════════

describe('listAllImages（管理端）', () => {
  /** 造 n 张图，createdAt 依次递增，便于断言倒序。 */
  async function seed(authorId: string, n: number, prefix = 'p') {
    const out = [];
    for (let i = 0; i < n; i++) {
      out.push(
        await makeImage({
          authorId,
          filename: `${prefix}${i}.png`,
          createdAt: new Date(2026, 0, 1, 0, 0, i),
        })
      );
    }
    return out;
  }

  it('返回全站图片（跨用户）', async () => {
    const a = await makeUser({ role: 'core' });
    const b = await makeUser({ role: 'core' });
    await makeImage({ authorId: a.id, filename: 'a.png' });
    await makeImage({ authorId: b.id, filename: 'b.png' });

    const r = await listAllImages();
    expect(r.total).toBe(2);
    expect(r.images).toHaveLength(2);
  });

  it('排除软删除', async () => {
    const u = await makeUser({ role: 'core' });
    await makeImage({ authorId: u.id, filename: 'ok.png' });
    await makeImage({ authorId: u.id, filename: 'gone.png', ignore: true });

    const r = await listAllImages();
    expect(r.total).toBe(1);
    expect(r.images[0].filename).toBe('ok.png');
  });

  it('每页 30 条（对齐 Flask per_page=30），pages 向上取整', async () => {
    const u = await makeUser({ role: 'core' });
    await seed(u.id, 35);

    const p1 = await listAllImages(1);
    expect(p1.images).toHaveLength(30);
    expect(p1.total).toBe(35);
    expect(p1.pages, 'ceil(35/30) = 2').toBe(2);
    expect(p1.page).toBe(1);

    const p2 = await listAllImages(2);
    expect(p2.images, '末页剩 5 条').toHaveLength(5);
  });

  it('分页无重复无遗漏', async () => {
    const u = await makeUser({ role: 'core' });
    await seed(u.id, 35);
    const ids = [
      ...(await listAllImages(1)).images.map((i) => i.id),
      ...(await listAllImages(2)).images.map((i) => i.id),
    ];
    expect(new Set(ids).size).toBe(35);
  });

  it('倒序：第一页第一条是最新的那张', async () => {
    const u = await makeUser({ role: 'core' });
    await seed(u.id, 35);
    const p1 = await listAllImages(1);
    expect(p1.images[0].filename, '第 35 张（i=34）最新').toBe('p34.png');
  });

  it('越界页返回空列表而非报错（对齐 Flask error_out=False）', async () => {
    const u = await makeUser({ role: 'core' });
    await makeImage({ authorId: u.id });
    const r = await listAllImages(99);
    expect(r.images).toEqual([]);
    expect(r.total).toBe(1);
  });

  it('page 非法（0 / 负数 / NaN / 小数）被夹到合法值', async () => {
    const u = await makeUser({ role: 'core' });
    await makeImage({ authorId: u.id });

    expect((await listAllImages(0)).page, 'page=0 → 1').toBe(1);
    expect((await listAllImages(-5)).page, '负页码 → 1').toBe(1);
    expect((await listAllImages(NaN)).page, 'NaN → 1').toBe(1);
    expect((await listAllImages(1.9)).page, '小数向下取整').toBe(1);
    // 关键：夹取失败会导致 skip 为负 → Prisma 抛错
    expect((await listAllImages(0)).images).toHaveLength(1);
  });

  it('空库：total=0、pages=0、images=[]', async () => {
    const r = await listAllImages();
    expect(r).toMatchObject({ total: 0, pages: 0, images: [] });
  });

  describe('搜索', () => {
    it('命中文件名（contains，子串匹配）', async () => {
      const u = await makeUser({ role: 'core' });
      await makeImage({ authorId: u.id, filename: 'holiday-beach.png' });
      await makeImage({ authorId: u.id, filename: 'work-desk.png' });

      const r = await listAllImages(1, 'beach');
      expect(r.total).toBe(1);
      expect(r.images[0].filename).toBe('holiday-beach.png');
    });

    it('命中上传者用户名（对齐 Flask 的 author_id in 子查询）', async () => {
      const alice = await makeUser({ role: 'core', username: 'alice' });
      const bob = await makeUser({ role: 'core', username: 'bob' });
      await makeImage({ authorId: alice.id, filename: 'x.png' });
      await makeImage({ authorId: bob.id, filename: 'y.png' });

      const r = await listAllImages(1, 'alic');
      expect(r.total).toBe(1);
      expect(r.images[0].authorName).toBe('alice');
    });

    it('文件名 OR 用户名 —— 两边命中都算（去重后不重复计数）', async () => {
      const alice = await makeUser({ role: 'core', username: 'alice' });
      // 这张同时满足「作者叫 alice」和「文件名含 alice」
      await makeImage({ authorId: alice.id, filename: 'alice-selfie.png' });
      const r = await listAllImages(1, 'alice');
      expect(r.total, '同时命中两个条件的行只能算一次').toBe(1);
    });

    it('搜索也排除软删除', async () => {
      const u = await makeUser({ role: 'core' });
      await makeImage({ authorId: u.id, filename: 'beach.png', ignore: true });
      expect((await listAllImages(1, 'beach')).total).toBe(0);
    });

    it('无命中返回空', async () => {
      const u = await makeUser({ role: 'core' });
      await makeImage({ authorId: u.id, filename: 'a.png' });
      expect((await listAllImages(1, 'zzz')).total).toBe(0);
    });

    it('search 为 null / 空串时不过滤（空串是 falsy）', async () => {
      const u = await makeUser({ role: 'core' });
      await makeImage({ authorId: u.id });
      expect((await listAllImages(1, null)).total).toBe(1);
      expect((await listAllImages(1, '')).total).toBe(1);
    });

    it('引号 / SQL 关键字不会造成注入（参数化查询）', async () => {
      const u = await makeUser({ role: 'core' });
      await makeImage({ authorId: u.id, filename: 'a.png' });
      await makeImage({ authorId: u.id, filename: 'b.png' });

      // ' OR 1=1 -- 若被字符串拼进 SQL，total 会变成 2
      expect(
        (await listAllImages(1, "' OR 1=1 --")).total,
        '参数化查询下应 0 命中；若为 2 说明存在 SQL 注入'
      ).toBe(0);
      expect((await listAllImages(1, '"; DROP TABLE image_hosting; --')).total).toBe(0);
      // 表还在（注入若成功，下一句会抛）
      expect(await prisma.imageHosting.count()).toBe(2);
    });

    it('⚠️ LIKE 通配符 % / _ 未被转义 —— 搜索 "%" 命中全部（记录现状）', async () => {
      const u = await makeUser({ role: 'core' });
      await makeImage({ authorId: u.id, filename: 'a.png' });
      await makeImage({ authorId: u.id, filename: 'b.png' });

      // Prisma 的 contains 在 SQLite 上直接拼进 LIKE，不转义通配符。
      // 不是注入（值仍是绑定参数），但管理端搜索 '%' 会当成「全部」。见交付说明。
      expect(
        (await listAllImages(1, '%')).total,
        '如实记录：% 被当作 LIKE 通配符，命中全部 2 张'
      ).toBe(2);
      expect((await listAllImages(1, '_')).total, '如实记录：_ 匹配任意单字符').toBe(2);
    });

    it('搜索 + 分页组合：pages 基于过滤后的 total 计算', async () => {
      const u = await makeUser({ role: 'core' });
      await seed(u.id, 35, 'zz'); // 35 张 zz*.png
      await makeImage({ authorId: u.id, filename: 'other.png' });

      const r = await listAllImages(1, 'zz');
      expect(r.total, '只数命中的 35 张').toBe(35);
      expect(r.pages).toBe(2);
      expect(r.images).toHaveLength(30);
    });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 八、getTotalStorageBytes —— 全站用量
// ═════════════════════════════════════════════════════════════════════════════

describe('getTotalStorageBytes', () => {
  it('空库返回 0（不是 null）', async () => {
    expect(await getTotalStorageBytes()).toBe(0);
  });

  it('跨用户累加', async () => {
    const a = await makeUser({ role: 'core' });
    const b = await makeUser({ role: 'core' });
    await makeImage({ authorId: a.id, fileSize: 100 });
    await makeImage({ authorId: b.id, fileSize: 200 });
    expect(await getTotalStorageBytes()).toBe(300);
  });

  it('排除软删除（与 getUserUsedBytes 同口径）', async () => {
    const u = await makeUser({ role: 'core' });
    await makeImage({ authorId: u.id, fileSize: 100 });
    await makeImage({ authorId: u.id, fileSize: 900, ignore: true });
    expect(await getTotalStorageBytes()).toBe(100);
  });

  it('等于各用户 getUserUsedBytes 之和（两个聚合口径必须一致）', async () => {
    const a = await makeUser({ role: 'core' });
    const b = await makeUser({ role: 'owner' });
    await makeImage({ authorId: a.id, fileSize: 111 });
    await makeImage({ authorId: a.id, fileSize: 222, ignore: true });
    await makeImage({ authorId: b.id, fileSize: 333 });

    const perUser = (await getUserUsedBytes(a.id)) + (await getUserUsedBytes(b.id));
    expect(await getTotalStorageBytes()).toBe(perUser);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 九、getImageMeta / getImageForServe
// ═════════════════════════════════════════════════════════════════════════════

describe('getImageMeta', () => {
  it('返回元信息', async () => {
    const u = await makeUser({ role: 'core', username: 'zoe' });
    const img = await makeImage({ authorId: u.id, filename: 'q.gif', mimeType: 'image/gif' });
    const meta = await getImageMeta(img.id);
    expect(meta).toMatchObject({ id: img.id, filename: 'q.gif', ext: '.gif', authorName: 'zoe' });
  });

  it('不存在返回 null', async () => {
    expect(await getImageMeta('nope')).toBeNull();
  });

  it('软删除的图片返回 null（元信息层面视同不存在）', async () => {
    const u = await makeUser({ role: 'core' });
    const img = await makeImage({ authorId: u.id, ignore: true });
    expect(await getImageMeta(img.id)).toBeNull();
  });
});

describe('getImageForServe', () => {
  it('返回服务所需最小字段，且不含 fileSize / 作者名等无关信息', async () => {
    const u = await makeUser({ role: 'core' });
    const img = await makeImage({ authorId: u.id, filename: 's.png' });
    const r = await getImageForServe(img.id);
    expect(Object.keys(r!).sort()).toEqual([
      'authorId',
      'filename',
      'id',
      'ignore',
      'isPublic',
      'mimeType',
    ]);
  });

  it('不存在返回 null', async () => {
    expect(await getImageForServe('nope')).toBeNull();
  });

  it('★ 软删除的图片仍会被返回（ignore=true）—— 由调用方裁决，与 getImageMeta 不同', async () => {
    // 这是有意的语义分叉：DELETE 路由需要读到已软删的行才能回「图片已被删除」。
    const u = await makeUser({ role: 'core' });
    const img = await makeImage({ authorId: u.id, ignore: true });
    const r = await getImageForServe(img.id);
    expect(r, 'getImageForServe 不做软删过滤').not.toBeNull();
    expect(r!.ignore).toBe(true);
  });

  it('NULL 的 isPublic / ignore 兜底为 true / false', async () => {
    const u = await makeUser({ role: 'core' });
    const img = await makeImage({ authorId: u.id });
    await prisma.$executeRawUnsafe(
      `UPDATE image_hosting SET is_public = NULL, ignore = NULL WHERE id = ?`,
      img.id
    );
    const r = await getImageForServe(img.id);
    expect(r).toMatchObject({ isPublic: true, ignore: false });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 十、软删除 vs 硬删除 —— 语义差异
// ═════════════════════════════════════════════════════════════════════════════

describe('softDeleteImage / hardDeleteImage', () => {
  /** 造一条带真实磁盘文件的图片。 */
  async function makeImageOnDisk(opts: { authorId: string; mimeType?: string; bytes?: Buffer }) {
    const mimeType = opts.mimeType ?? 'image/png';
    const bytes = opts.bytes ?? (await pngBytes());
    const img = await makeImage({
      authorId: opts.authorId,
      mimeType,
      fileSize: bytes.length,
    });
    await fsp.writeFile(storagePathFor(img.id, mimeType), bytes);
    return img;
  }

  it('★ 软删除：置 ignore = true，DB 行与磁盘文件都保留', async () => {
    const u = await makeUser({ role: 'core' });
    const img = await makeImageOnDisk({ authorId: u.id });
    const filePath = storagePathFor(img.id, img.mimeType);

    await softDeleteImage(img.id);

    const row = await prisma.imageHosting.findUnique({ where: { id: img.id } });
    expect(row, '软删不能删 DB 行').not.toBeNull();
    expect(row!.ignore).toBe(true);
    expect(fs.existsSync(filePath), '软删必须保留磁盘文件（可恢复）').toBe(true);
  });

  it('软删可重复调用，幂等（不抛错）', async () => {
    const u = await makeUser({ role: 'core' });
    const img = await makeImage({ authorId: u.id });
    await softDeleteImage(img.id);
    await expect(softDeleteImage(img.id)).resolves.toBeUndefined();
  });

  it('软删不存在的 id 会抛错（Prisma update 找不到行）', async () => {
    await expect(softDeleteImage('nope')).rejects.toThrow();
  });

  it('★ 硬删除：磁盘文件与 DB 行同时消失（站长专属语义）', async () => {
    const u = await makeUser({ role: 'core' });
    const img = await makeImageOnDisk({ authorId: u.id });
    const filePath = storagePathFor(img.id, img.mimeType);
    expect(fs.existsSync(filePath)).toBe(true);

    await hardDeleteImage(img.id);

    expect(await prisma.imageHosting.findUnique({ where: { id: img.id } }), 'DB 行必须没了').toBeNull();
    expect(fs.existsSync(filePath), '硬删必须删掉磁盘文件，否则空间永久泄漏').toBe(false);
  });

  it('硬删按 mimeType 解析扩展名删文件（jpg 不能去删 .png）', async () => {
    const u = await makeUser({ role: 'core' });
    const sharp = (await import('sharp')).default;
    const jpg = await sharp({
      create: { width: 8, height: 8, channels: 3, background: { r: 1, g: 2, b: 3 } },
    })
      .jpeg()
      .toBuffer();
    const img = await makeImageOnDisk({ authorId: u.id, mimeType: 'image/jpeg', bytes: jpg });
    const jpgPath = storagePathFor(img.id, 'image/jpeg');
    expect(path.extname(jpgPath)).toBe('.jpg');

    // 放一个同名 .png 干扰项，硬删不应误伤
    const decoy = path.join(TEST_UPLOAD_DIR, `${img.id}.png`);
    await fsp.writeFile(decoy, 'decoy');

    await hardDeleteImage(img.id);
    expect(fs.existsSync(jpgPath), '.jpg 应被删').toBe(false);
    expect(fs.existsSync(decoy), '同名 .png 不应被误删').toBe(true);
  });

  it('硬删时磁盘文件已丢失也不报错，DB 行照删（不能因文件缺失卡住清理）', async () => {
    const u = await makeUser({ role: 'core' });
    const img = await makeImage({ authorId: u.id }); // 只落库，不写盘
    await expect(hardDeleteImage(img.id)).resolves.toBeUndefined();
    expect(await prisma.imageHosting.findUnique({ where: { id: img.id } })).toBeNull();
  });

  it('已软删的图片仍可硬删（软删 → 硬删的清理链路）', async () => {
    const u = await makeUser({ role: 'core' });
    const img = await makeImageOnDisk({ authorId: u.id });
    const filePath = storagePathFor(img.id, img.mimeType);

    await softDeleteImage(img.id);
    expect(fs.existsSync(filePath), '软删后文件还在').toBe(true);

    await hardDeleteImage(img.id);
    expect(fs.existsSync(filePath), '硬删后文件才真正消失').toBe(false);
    expect(await prisma.imageHosting.findUnique({ where: { id: img.id } })).toBeNull();
  });

  it('硬删不存在的 id 抛错（Prisma delete 找不到行）', async () => {
    await expect(hardDeleteImage('nope')).rejects.toThrow();
  });

  it('硬删只影响目标图片，不动同用户其它文件', async () => {
    const u = await makeUser({ role: 'core' });
    const keep = await makeImageOnDisk({ authorId: u.id });
    const drop = await makeImageOnDisk({ authorId: u.id });

    await hardDeleteImage(drop.id);

    expect(fs.existsSync(storagePathFor(keep.id, keep.mimeType))).toBe(true);
    expect(await prisma.imageHosting.findUnique({ where: { id: keep.id } })).not.toBeNull();
  });

  it('两种删除对配额的影响一致（都释放额度）', async () => {
    const u = await makeUser({ role: 'core' });
    const soft = await makeImage({ authorId: u.id, fileSize: 1000 });
    const hard = await makeImage({ authorId: u.id, fileSize: 2000 });
    expect(await getUserUsedBytes(u.id)).toBe(3000);

    await softDeleteImage(soft.id);
    expect(await getUserUsedBytes(u.id)).toBe(2000);
    await hardDeleteImage(hard.id);
    expect(await getUserUsedBytes(u.id)).toBe(0);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 十一、saveUpload —— 落盘 + 落库
// ═════════════════════════════════════════════════════════════════════════════

describe('saveUpload', () => {
  it('写盘 + 落库，返回的 id 能查回元信息', async () => {
    const u = await makeUser({ role: 'core' });
    const bytes = await pngBytes();
    const saved = await saveUpload({
      userId: u.id,
      buffer: bytes,
      mimeType: 'image/png',
      filename: 'hello.png',
    });

    expect(saved.id).toMatch(/^[A-Za-z0-9]{10}$/);
    expect(fs.existsSync(storagePathFor(saved.id, 'image/png')), '文件必须落盘').toBe(true);

    const meta = await getImageMeta(saved.id);
    expect(meta).toMatchObject({ filename: 'hello.png', mimeType: 'image/png', authorId: u.id });
  });

  it('★ 文件名经过净化后才落库（路径穿越名不会原样入库）', async () => {
    const u = await makeUser({ role: 'core' });
    const saved = await saveUpload({
      userId: u.id,
      buffer: await pngBytes(),
      mimeType: 'image/png',
      filename: '../../etc/passwd.png',
    });
    expect(saved.filename, '入库文件名必须已净化').toBe('etcpasswd.png');

    const row = await prisma.imageHosting.findUniqueOrThrow({ where: { id: saved.id } });
    expect(row.filename).toBe('etcpasswd.png');
    expect(row.filename).not.toContain('/');
  });

  it('★ 无论文件名多恶意，落盘位置永远在上传目录一层内', async () => {
    const u = await makeUser({ role: 'core' });
    const before = fs.readdirSync(TEST_UPLOAD_DIR);
    expect(before).toEqual([]);

    for (const evil of ['../../../tmp/pwned.png', '/etc/x.png', 'a/b/c.png']) {
      const saved = await saveUpload({
        userId: u.id,
        buffer: await pngBytes(),
        mimeType: 'image/png',
        filename: evil,
      });
      const p = path.resolve(storagePathFor(saved.id, 'image/png'));
      expect(path.dirname(p), `${evil} 落盘逃出目录`).toBe(TEST_UPLOAD_DIR);
      expect(fs.existsSync(p)).toBe(true);
    }

    // 目录里只应该有 3 个 <id>.png，没有任何子目录
    const after = fs.readdirSync(TEST_UPLOAD_DIR);
    expect(after).toHaveLength(3);
    for (const f of after) {
      expect(f, `产生了非预期文件名：${f}`).toMatch(/^[A-Za-z0-9]{10}\.png$/);
      expect(fs.statSync(path.join(TEST_UPLOAD_DIR, f)).isFile()).toBe(true);
    }
  });

  it('fileSize 记的是压缩后的字节数，且与磁盘文件实际大小一致', async () => {
    const u = await makeUser({ role: 'core' });
    const saved = await saveUpload({
      userId: u.id,
      buffer: await pngBytes(64, 64),
      mimeType: 'image/png',
      filename: 'x.png',
    });
    const onDisk = fs.statSync(storagePathFor(saved.id, 'image/png')).size;
    expect(saved.fileSize, 'DB 记的大小与磁盘不符会让配额算错').toBe(onDisk);

    const row = await prisma.imageHosting.findUniqueOrThrow({ where: { id: saved.id } });
    expect(row.fileSize).toBe(onDisk);
  });

  it('上传后立即计入配额（getUserUsedBytes 能读到）', async () => {
    const u = await makeUser({ role: 'core' });
    const a = await saveUpload({
      userId: u.id,
      buffer: await pngBytes(),
      mimeType: 'image/png',
      filename: 'a.png',
    });
    const b = await saveUpload({
      userId: u.id,
      buffer: await pngBytes(20, 20),
      mimeType: 'image/png',
      filename: 'b.png',
    });
    expect(await getUserUsedBytes(u.id)).toBe(a.fileSize + b.fileSize);
  });

  it('createdAt 被显式写入（schema 无 @default(now())，漏写会导致排序全失效）', async () => {
    const u = await makeUser({ role: 'core' });
    const saved = await saveUpload({
      userId: u.id,
      buffer: await pngBytes(),
      mimeType: 'image/png',
      filename: 'x.png',
    });
    const row = await prisma.imageHosting.findUniqueOrThrow({ where: { id: saved.id } });
    expect(row.createdAt, 'createdAt 为 NULL 则图床列表排序失效').not.toBeNull();
  });

  it('SVG 原样落盘（不走 sharp 压缩，避免损坏矢量内容）', async () => {
    const u = await makeUser({ role: 'core' });
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>');
    const saved = await saveUpload({
      userId: u.id,
      buffer: svg,
      mimeType: 'image/svg+xml',
      filename: 'v.svg',
    });
    const onDisk = await fsp.readFile(storagePathFor(saved.id, 'image/svg+xml'));
    expect(onDisk.equals(svg), 'SVG 必须字节级原样保存').toBe(true);
    expect(saved.fileSize).toBe(svg.length);
  });

  it('并发上传各自拿到不同 ID、各自落盘、配额正确累加', async () => {
    const u = await makeUser({ role: 'core' });
    const bytes = await pngBytes();
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        saveUpload({ userId: u.id, buffer: bytes, mimeType: 'image/png', filename: `c${i}.png` })
      )
    );
    expect(new Set(results.map((r) => r.id)).size, '并发下 ID 不能碰撞').toBe(8);
    expect(fs.readdirSync(TEST_UPLOAD_DIR)).toHaveLength(8);
    expect(await getUserUsedBytes(u.id)).toBe(results.reduce((s, r) => s + r.fileSize, 0));
  });

  it('⚠️ saveUpload 自身不校验配额 / MIME / 尺寸（前置校验在路由层）', async () => {
    // 记录职责边界：service 层是「无脑存」，闸门全在 src/app/api/images/route.ts。
    // 任何新调用方若绕过路由直接调 saveUpload，配额就形同虚设。
    const u = await makeUser({ role: 'user' }); // 配额 0 的角色
    const saved = await saveUpload({
      userId: u.id,
      buffer: await pngBytes(),
      mimeType: 'image/png',
      filename: 'x.png',
    });
    expect(saved.id, '如实记录：user 角色也能经 saveUpload 存进去').toBeTruthy();
    expect(getQuotaLimitMb('user')).toBe(0);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 十二、★ SVG XSS 防护 —— GET /api/images/:id/raw 的响应头
// ═════════════════════════════════════════════════════════════════════════════
//
// CLAUDE.md：「SVG 图片以 Content-Disposition: attachment 提供」。
// 为什么关键：SVG 是 XML，可以内嵌 <script>。若以 inline 在同源下渲染，
// 等于给任意「能上传图片的用户」一个存储型 XSS。这一节把响应头钉死。
//
// 路由依赖 getCurrentUser()（读 cookie，需 Next 请求上下文）—— 这里 mock 掉 @/lib/auth，
// 用 authState 控制「当前登录者」。注意 image-service / image-upload 不依赖 auth，
// 所以此 mock 不影响本文件其它用例。

const authState: { user: { id: string; role: string } | null } = { user: null };

vi.mock('@/lib/auth', () => ({
  getCurrentUser: async () => authState.user,
  hasAdminRights: (u: { role: string } | null) => u?.role === 'admin' || u?.role === 'owner',
  isOwner: (u: { role: string } | null) => u?.role === 'owner',
  isCoreUser: (u: { role: string } | null) =>
    !!u && ['core', 'admin', 'owner'].includes(u.role),
  isCurrentlyBanned: () => false,
}));

describe('GET /api/images/:id/raw（SVG XSS 防护 + 私有图鉴权）', () => {
  let rawGET: (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;

  beforeAll(async () => {
    ({ GET: rawGET } = await import('@/app/api/images/[id]/raw/route'));
  });

  beforeEach(() => {
    authState.user = null;
  });

  const call = (id: string) =>
    rawGET(new Request(`http://localhost/api/images/${id}/raw`), {
      params: Promise.resolve({ id }),
    });

  /** 造一张带磁盘文件的图。 */
  async function seedOnDisk(opts: {
    authorId: string;
    mimeType: string;
    bytes: Buffer;
    filename?: string;
    isPublic?: boolean;
    ignore?: boolean;
  }) {
    const img = await makeImage({
      authorId: opts.authorId,
      mimeType: opts.mimeType,
      filename: opts.filename ?? `f.${extForMime(opts.mimeType).slice(1)}`,
      fileSize: opts.bytes.length,
      isPublic: opts.isPublic ?? true,
      ignore: opts.ignore ?? false,
    });
    await fsp.writeFile(storagePathFor(img.id, opts.mimeType), opts.bytes);
    return img;
  }

  const SVG = Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(document.domain)</script></svg>'
  );

  it('★ SVG 必须带 Content-Disposition: attachment（否则是存储型 XSS）', async () => {
    const u = await makeUser({ role: 'core' });
    const img = await seedOnDisk({
      authorId: u.id,
      mimeType: 'image/svg+xml',
      bytes: SVG,
      filename: 'logo.svg',
    });

    const res = await call(img.id);
    expect(res.status).toBe(200);
    const cd = res.headers.get('Content-Disposition');
    expect(cd, 'SVG 缺少 Content-Disposition 头 —— XSS 防线失效').not.toBeNull();
    expect(
      cd!.startsWith('attachment'),
      `必须是 attachment 而非 inline（实测：${cd}）`
    ).toBe(true);
  });

  it('SVG 的 attachment 文件名经净化，且含 ASCII fallback + UTF-8 版本', async () => {
    const u = await makeUser({ role: 'core' });
    const img = await seedOnDisk({
      authorId: u.id,
      mimeType: 'image/svg+xml',
      bytes: SVG,
      filename: '标志.svg',
    });

    const cd = (await call(img.id)).headers.get('Content-Disposition')!;
    expect(cd).toContain('filename="'); // ASCII fallback
    expect(cd).toContain("filename*=UTF-8''"); // RFC 5987
    expect(cd).toMatch(/filename="[\x20-\x7e]*"/); // fallback 必须纯 ASCII
    expect(cd).toContain(encodeURIComponent('标志.svg'));
  });

  it('★ 恶意 SVG 文件名不能注入 Content-Disposition 头（引号/CRLF 逃逸）', async () => {
    const u = await makeUser({ role: 'core' });
    const img = await seedOnDisk({
      authorId: u.id,
      mimeType: 'image/svg+xml',
      bytes: SVG,
      // 直接写库，绕过上传时的净化 —— 模拟历史脏数据 / 别处写入的行
      filename: 'a"; x=y\r\nX-Injected: 1.svg',
    });

    const res = await call(img.id);
    const cd = res.headers.get('Content-Disposition')!;
    expect(cd, '文件名里的引号必须已被净化，否则可越出 filename="..."').not.toContain('"; x=y');
    expect(/[\r\n]/.test(cd), 'CD 头不能含 CRLF').toBe(false);
    expect(res.headers.get('X-Injected'), '不能注入出新响应头').toBeNull();
    expect(cd.startsWith('attachment')).toBe(true);
  });

  it('文件名净化后为空的 SVG 仍产出合法 attachment 名（image.svg）', async () => {
    const u = await makeUser({ role: 'core' });
    const img = await seedOnDisk({
      authorId: u.id,
      mimeType: 'image/svg+xml',
      bytes: SVG,
      filename: '!!!',
    });
    const cd = (await call(img.id)).headers.get('Content-Disposition')!;
    expect(cd).toContain('filename="image.svg"');
  });

  it('SVG 响应体原样返回，Content-Type 为 image/svg+xml', async () => {
    const u = await makeUser({ role: 'core' });
    const img = await seedOnDisk({ authorId: u.id, mimeType: 'image/svg+xml', bytes: SVG });
    const res = await call(img.id);
    expect(res.headers.get('Content-Type')).toBe('image/svg+xml');
    expect(Buffer.from(await res.arrayBuffer()).equals(SVG)).toBe(true);
  });

  it('非 SVG（PNG）不带 attachment —— 位图需要能内联显示', async () => {
    const u = await makeUser({ role: 'core' });
    const img = await seedOnDisk({ authorId: u.id, mimeType: 'image/png', bytes: await pngBytes() });

    const res = await call(img.id);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('image/png');
    expect(
      res.headers.get('Content-Disposition'),
      'PNG 若被强制下载，博客里的图就全挂了'
    ).toBeNull();
  });

  it('⚠️ GIF/WebP/JPEG 也内联下发（只有 SVG 是特例）', async () => {
    const u = await makeUser({ role: 'core' });
    const sharp = (await import('sharp')).default;
    const webp = await sharp({
      create: { width: 4, height: 4, channels: 3, background: { r: 0, g: 0, b: 0 } },
    })
      .webp()
      .toBuffer();
    const img = await seedOnDisk({ authorId: u.id, mimeType: 'image/webp', bytes: webp });
    expect((await call(img.id)).headers.get('Content-Disposition')).toBeNull();
  });

  it('软删除的图片返回 404', async () => {
    const u = await makeUser({ role: 'core' });
    const img = await seedOnDisk({
      authorId: u.id,
      mimeType: 'image/png',
      bytes: await pngBytes(),
      ignore: true,
    });
    expect((await call(img.id)).status).toBe(404);
  });

  it('不存在的 id 返回 404（不泄漏是否存在）', async () => {
    expect((await call('nope')).status).toBe(404);
  });

  it('DB 有行但磁盘文件缺失 → 404，不是 500', async () => {
    const u = await makeUser({ role: 'core' });
    const img = await makeImage({ authorId: u.id }); // 只落库
    expect((await call(img.id)).status).toBe(404);
  });

  describe('私有图鉴权（isPublic = false）', () => {
    it('未登录者拿到 404（伪装成不存在，不回 403）', async () => {
      const u = await makeUser({ role: 'core' });
      const img = await seedOnDisk({
        authorId: u.id,
        mimeType: 'image/png',
        bytes: await pngBytes(),
        isPublic: false,
      });
      authState.user = null;
      expect((await call(img.id)).status).toBe(404);
    });

    it('其他登录用户也拿到 404', async () => {
      const owner = await makeUser({ role: 'core' });
      const other = await makeUser({ role: 'core' });
      const img = await seedOnDisk({
        authorId: owner.id,
        mimeType: 'image/png',
        bytes: await pngBytes(),
        isPublic: false,
      });
      authState.user = { id: other.id, role: 'core' };
      expect((await call(img.id)).status).toBe(404);
    });

    it('作者本人可访问', async () => {
      const u = await makeUser({ role: 'core' });
      const img = await seedOnDisk({
        authorId: u.id,
        mimeType: 'image/png',
        bytes: await pngBytes(),
        isPublic: false,
      });
      authState.user = { id: u.id, role: 'core' };
      expect((await call(img.id)).status).toBe(200);
    });

    it('管理员 / 站长可访问', async () => {
      const u = await makeUser({ role: 'core' });
      const img = await seedOnDisk({
        authorId: u.id,
        mimeType: 'image/png',
        bytes: await pngBytes(),
        isPublic: false,
      });

      authState.user = { id: 'admin-x', role: 'admin' };
      expect((await call(img.id)).status).toBe(200);
      authState.user = { id: 'owner-x', role: 'owner' };
      expect((await call(img.id)).status).toBe(200);
    });

    it('私有 + 已软删：软删优先，作者本人也拿 404', async () => {
      const u = await makeUser({ role: 'core' });
      const img = await seedOnDisk({
        authorId: u.id,
        mimeType: 'image/png',
        bytes: await pngBytes(),
        isPublic: false,
        ignore: true,
      });
      authState.user = { id: u.id, role: 'core' };
      expect((await call(img.id)).status).toBe(404);
    });

    it('公开图无需登录即可访问（默认 isPublic = true）', async () => {
      const u = await makeUser({ role: 'core' });
      const img = await seedOnDisk({
        authorId: u.id,
        mimeType: 'image/png',
        bytes: await pngBytes(),
      });
      authState.user = null;
      expect((await call(img.id)).status).toBe(200);
    });
  });

  it('缓存头为 immutable 长缓存（ID 内容不可变，安全）', async () => {
    const u = await makeUser({ role: 'core' });
    const img = await seedOnDisk({ authorId: u.id, mimeType: 'image/png', bytes: await pngBytes() });
    expect((await call(img.id)).headers.get('Cache-Control')).toBe(
      'public, max-age=31536000, immutable'
    );
  });

  it('★ 私有图必须是 private, no-store（否则共享缓存/CDN 会向无权者下发）', async () => {
    const u = await makeUser({ role: 'core' });
    const img = await seedOnDisk({
      authorId: u.id,
      mimeType: 'image/png',
      bytes: await pngBytes(),
      isPublic: false,
    });
    authState.user = { id: u.id, role: 'core' };
    const cc = (await call(img.id)).headers.get('Cache-Control');
    expect(cc).toBe('private, no-store');
    // 关键回归点：私有图一旦出现 public，鉴权就被缓存层旁路了
    expect(cc).not.toContain('public');
  });

  it('私有图即便由管理员取回，也不得进共享缓存', async () => {
    const u = await makeUser({ role: 'core' });
    const img = await seedOnDisk({
      authorId: u.id,
      mimeType: 'image/png',
      bytes: await pngBytes(),
      isPublic: false,
    });
    authState.user = { id: 'admin-x', role: 'admin' };
    expect((await call(img.id)).headers.get('Cache-Control')).toBe('private, no-store');
  });

  // ── nosniff ───────────────────────────────────────────────────────────────
  //
  // 缺 nosniff 时，「字节是 SVG/HTML、Content-Type 是 image/png」的图会被浏览器
  // 嗅探成可执行文档 → 同源 XSS。上传侧的 magic byte 校验是第一道闸，这是第二道。

  it('★ 响应必须带 X-Content-Type-Options: nosniff', async () => {
    const u = await makeUser({ role: 'core' });
    const img = await seedOnDisk({ authorId: u.id, mimeType: 'image/png', bytes: await pngBytes() });
    expect((await call(img.id)).headers.get('X-Content-Type-Options')).toBe('nosniff');
  });

  it('nosniff 对所有 MIME / 公私有一致下发', async () => {
    const u = await makeUser({ role: 'core' });
    authState.user = { id: u.id, role: 'core' };

    const png = await seedOnDisk({
      authorId: u.id,
      mimeType: 'image/png',
      bytes: await pngBytes(),
      isPublic: false,
    });
    const svg = await seedOnDisk({ authorId: u.id, mimeType: 'image/svg+xml', bytes: SVG });

    for (const img of [png, svg]) {
      expect((await call(img.id)).headers.get('X-Content-Type-Options')).toBe('nosniff');
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 十、内容校验（magic bytes）—— detectImageMime / verifyImageMime
// ═════════════════════════════════════════════════════════════════════════════
//
// 【威胁模型】file.type 由浏览器声明，攻击者可任意伪造。若只看声明：
//   上传 SVG/HTML 字节 + 声明 image/png → 绕过 raw 路由「只看 mimeType」的
//   SVG attachment 分支 → 以 image/png 内联下发 → 浏览器嗅探成 SVG → 同源 XSS。
// 对齐 Flask verify_image_mime 的拒绝语义：识别不出 / 与声明不符 → 一律拒绝。

describe('detectImageMime（由内容识别真实类型）', () => {
  it('识别真 PNG', async () => {
    expect(detectImageMime(await pngBytes())).toBe('image/png');
  });

  it('识别真 JPEG / WebP / GIF', async () => {
    const sharp = (await import('sharp')).default;
    const base = () =>
      sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 1, g: 2, b: 3 } } });

    expect(detectImageMime(await base().jpeg().toBuffer())).toBe('image/jpeg');
    expect(detectImageMime(await base().webp().toBuffer())).toBe('image/webp');
    expect(detectImageMime(await base().gif().toBuffer())).toBe('image/gif');
  });

  it('识别 GIF87a / GIF89a 两种签名', () => {
    expect(detectImageMime(Buffer.from('GIF87a\x00\x00'))).toBe('image/gif');
    expect(detectImageMime(Buffer.from('GIF89a\x00\x00'))).toBe('image/gif');
  });

  it('WebP 必须 RIFF 与 WEBP 同时命中（RIFF/WAVE 不算图片）', () => {
    const wav = Buffer.concat([
      Buffer.from('RIFF'),
      Buffer.from([0, 0, 0, 0]),
      Buffer.from('WAVE'),
    ]);
    expect(detectImageMime(wav)).toBeNull();
  });

  describe('SVG 文本识别', () => {
    it('裸 <svg 开头', () => {
      expect(detectImageMime(Buffer.from('<svg xmlns="..."></svg>'))).toBe('image/svg+xml');
    });

    it('带 XML prolog', () => {
      expect(detectImageMime(Buffer.from('<?xml version="1.0"?><svg></svg>'))).toBe(
        'image/svg+xml'
      );
    });

    it('带 BOM', () => {
      expect(detectImageMime(Buffer.from('﻿<svg></svg>', 'utf8'))).toBe('image/svg+xml');
    });

    it('带前导空白 / 换行', () => {
      expect(detectImageMime(Buffer.from('\n\n   \t<svg></svg>'))).toBe('image/svg+xml');
    });

    it('带前导注释', () => {
      expect(detectImageMime(Buffer.from('<!-- made by inkscape --><svg></svg>'))).toBe(
        'image/svg+xml'
      );
    });

    it('带 DOCTYPE（含内部子集）', () => {
      const doctype =
        '<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" ' +
        '"http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd" [<!ENTITY foo "bar">]>';
      expect(detectImageMime(Buffer.from(`${doctype}<svg></svg>`))).toBe('image/svg+xml');
    });

    it('prolog + 注释 + DOCTYPE 混合（真实 Inkscape 产物形态）', () => {
      const src =
        '﻿<?xml version="1.0" encoding="UTF-8"?>\n' +
        '<!-- Generator: Adobe Illustrator -->\n' +
        '<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "svg11.dtd">\n' +
        '<svg width="10"></svg>';
      expect(detectImageMime(Buffer.from(src, 'utf8'))).toBe('image/svg+xml');
    });

    it('★ HTML 文档不算 SVG（哪怕内部含 <svg>）', () => {
      const html = '<!DOCTYPE html><html><body><svg onload="alert(1)"></svg></body></html>';
      expect(detectImageMime(Buffer.from(html))).toBeNull();
    });

    it('★ 纯 HTML / 脚本不算 SVG', () => {
      expect(detectImageMime(Buffer.from('<script>alert(1)</script>'))).toBeNull();
      expect(detectImageMime(Buffer.from('<html><body>hi</body></html>'))).toBeNull();
    });

    it('<svgfoo> 这类同前缀标签不算 SVG', () => {
      expect(detectImageMime(Buffer.from('<svgfoo></svgfoo>'))).toBeNull();
    });

    it('大小写不敏感', () => {
      expect(detectImageMime(Buffer.from('<SVG></SVG>'))).toBe('image/svg+xml');
    });
  });

  it('无法识别的内容返回 null（空 / 纯文本 / 截断头部）', async () => {
    expect(detectImageMime(Buffer.alloc(0))).toBeNull();
    expect(detectImageMime(Buffer.from('hello world'))).toBeNull();
    expect(detectImageMime(Buffer.from([0x89, 0x50]))).toBeNull(); // 半个 PNG 签名
    expect(detectImageMime((await pngBytes()).subarray(0, 4))).toBeNull();
  });
});

describe('verifyImageMime（内容 vs 声明）', () => {
  it('内容与声明一致 → 通过', async () => {
    expect(verifyImageMime(await pngBytes(), 'image/png')).toBe(true);
  });

  it('★ SVG 字节声明成 image/png → 拒绝（这是 XSS 链路的入口）', () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    expect(verifyImageMime(svg, 'image/png')).toBe(false);
  });

  it('★ HTML 字节声明成 image/svg+xml → 拒绝', () => {
    const html = Buffer.from('<!DOCTYPE html><html><script>alert(1)</script></html>');
    expect(verifyImageMime(html, 'image/svg+xml')).toBe(false);
  });

  it('★ 位图之间互相伪装 → 拒绝', async () => {
    const png = await pngBytes();
    for (const claimed of ['image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml']) {
      expect(verifyImageMime(png, claimed), `PNG 字节声明成 ${claimed}`).toBe(false);
    }
  });

  it('★ 识别不出的内容一律拒绝（对齐 Flask：解不开 → False）', () => {
    for (const mime of ALLOWED_MIMETYPES) {
      expect(verifyImageMime(Buffer.from('not an image at all'), mime)).toBe(false);
    }
  });

  it('声明不在白名单 → 拒绝（即便内容是真图）', async () => {
    expect(verifyImageMime(await pngBytes(), 'text/html')).toBe(false);
    expect(verifyImageMime(await pngBytes(), 'image/bmp')).toBe(false);
  });

  it('白名单内每种真实格式都能自证', async () => {
    const sharp = (await import('sharp')).default;
    const base = () =>
      sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 9, g: 9, b: 9 } } });

    expect(verifyImageMime(await base().png().toBuffer(), 'image/png')).toBe(true);
    expect(verifyImageMime(await base().jpeg().toBuffer(), 'image/jpeg')).toBe(true);
    expect(verifyImageMime(await base().webp().toBuffer(), 'image/webp')).toBe(true);
    expect(verifyImageMime(await base().gif().toBuffer(), 'image/gif')).toBe(true);
    expect(verifyImageMime(Buffer.from('<svg></svg>'), 'image/svg+xml')).toBe(true);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 十一、POST /api/images —— 上传路由必须接上内容校验
// ═════════════════════════════════════════════════════════════════════════════

describe('POST /api/images（上传内容校验接线）', () => {
  let postImages: (req: Request) => Promise<Response>;

  beforeAll(async () => {
    ({ POST: postImages } = await import('@/app/api/images/route'));
  });

  beforeEach(() => {
    authState.user = null;
  });

  async function upload(bytes: Buffer, declaredMime: string, filename = 'x.png') {
    const form = new FormData();
    form.append('file', new File([new Uint8Array(bytes)], filename, { type: declaredMime }));
    const res = await postImages(
      new Request('http://localhost/api/images', { method: 'POST', body: form })
    );
    return { res, body: (await res.json()) as { code: number; message: string } };
  }

  it('真 PNG 正常上传', async () => {
    const u = await makeUser({ role: 'core' });
    authState.user = { id: u.id, role: 'core' };

    const { res, body } = await upload(await pngBytes(), 'image/png');
    expect(res.status).toBe(200);
    expect(body.code).toBe(200);
    // 确实落库了
    expect(await prisma.imageHosting.count({ where: { authorId: u.id } })).toBe(1);
  });

  it('★ SVG 字节 + 声明 image/png → 400，且不落库不落盘', async () => {
    const u = await makeUser({ role: 'core' });
    authState.user = { id: u.id, role: 'core' };

    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    const { res, body } = await upload(svg, 'image/png', 'evil.png');

    expect(res.status).toBe(400);
    expect(body.message).toBe('文件内容与声明的格式不匹配');
    expect(await prisma.imageHosting.count({ where: { authorId: u.id } })).toBe(0);
    expect(fs.readdirSync(TEST_UPLOAD_DIR)).toHaveLength(0);
  });

  it('★ HTML 字节 + 声明 image/svg+xml → 400', async () => {
    const u = await makeUser({ role: 'core' });
    authState.user = { id: u.id, role: 'core' };

    const html = Buffer.from('<!DOCTYPE html><html><script>alert(1)</script></html>');
    const { res, body } = await upload(html, 'image/svg+xml', 'evil.svg');

    expect(res.status).toBe(400);
    expect(body.message).toBe('文件内容与声明的格式不匹配');
    expect(await prisma.imageHosting.count({ where: { authorId: u.id } })).toBe(0);
  });

  it('★ 任意垃圾字节 + 声明真图 MIME → 400', async () => {
    const u = await makeUser({ role: 'core' });
    authState.user = { id: u.id, role: 'core' };

    const { res } = await upload(Buffer.from('just some text'), 'image/jpeg', 'a.jpg');
    expect(res.status).toBe(400);
    expect(await prisma.imageHosting.count({ where: { authorId: u.id } })).toBe(0);
  });

  it('合法 SVG（声明 image/svg+xml）仍可上传 —— 校验不能误伤', async () => {
    const u = await makeUser({ role: 'core' });
    authState.user = { id: u.id, role: 'core' };

    const svg = Buffer.from('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"/>');
    const { res } = await upload(svg, 'image/svg+xml', 'ok.svg');
    expect(res.status).toBe(200);
  });

  it('白名单外的声明仍先被白名单拦下（错误文案不变）', async () => {
    const u = await makeUser({ role: 'core' });
    authState.user = { id: u.id, role: 'core' };

    const { res, body } = await upload(await pngBytes(), 'text/html', 'a.html');
    expect(res.status).toBe(400);
    expect(body.message).toContain('不支持的文件格式');
  });

  it('内容校验先于配额（伪造上传不消耗额度）', async () => {
    // 校验顺序对齐 Flask：白名单 → 内容 → 尺寸 → 配额 → 限频。
    // 造一个**配额已满**的 core 用户：若配额先于内容被检查，这里会撞配额错误；
    // 拿到 400「内容不匹配」才说明内容校验确实在前。
    //
    // 此前这条用例用的是 role=user（配额为 0），并注释说「若内容校验没有前置，
    // 这里会先撞 403」—— 那个前提是错的：Flask 的 @authenticated_required 是**装饰器**，
    // 永远先于函数体跑，非核心用户根本到不了任何校验。当时能拿到 400，是因为
    // Next 这个接口漏了核心用户判断（已修）。
    const u = await makeUser({ role: 'core' }); // core 配额 50MB
    await makeImage({ authorId: u.id, fileSize: 50 * 1024 * 1024 }); // 一把占满
    authState.user = { id: u.id, role: 'core' };

    const { res, body } = await upload(Buffer.from('<svg></svg>'), 'image/png', 'e.png');
    expect(res.status).toBe(400);
    expect(body.message).toBe('文件内容与声明的格式不匹配');
  });
});
