// ─────────────────────────────────────────────────────────────────────────────
// frame-assets.test.ts —— 静态检查：入库的素材必须**就是出图脚本的产物**
//
// 【绊的是什么】头像框素材原先住 instance/frames/（gitignored 的运行时数据），
// 所以「改了脚本却忘了重跑」这件事**不可能发生** —— 站点读的就是脚本刚写出来的字节。
// 素材搬进 public/static/frames/ 随代码入库之后，PNG 成了仓库里的**独立副本**，
// 于是多出一条静默失效：
//
//     改了 FRAMES 里的 SVG、忘了重跑  →  站点继续显示旧图，
//     不报错、不 500、日志里什么都没有 —— 只有人眼盯着那个框才看得出来。
//
// 跟 db-time-guard / blog-visibility-guard / avatar-sites-guard 同属一类：
// tsc 管不着、构建不报、只有静态检查能钉住。
//
// ── 【判据：核对「生成这一刻」的台账】────────────────────────────────────────
// 出图脚本每次运行都会写 public/static/frames/manifest.json：
//   · `generatorSha256` —— 脚本**自己**的哈希；
//   · `frames[key].png` / `.preview` —— 每张产物的哈希。
// 本用例只做两件事：脚本没变过、每张图还是当初生成的那张。
//
// ⚠️ **刻意不在这里重新光栅化**（那是最直觉的写法，也是错的）：SVG → PNG 要过
//    librsvg，而 sharp 各平台的预编译二进制不保证给出逐字节相同的像素。那样写出来
//    的守卫会变成「只在作者的机器上绿」，在别人的机器上假红 —— 而一道会误报的守卫
//    最终会被人关掉。核对脚本文件与**已落盘的字节**则与平台无关。
//
// ── 【它不管什么】────────────────────────────────────────────────────────────
//   · **手画的框**（没进脚本的那种）：不在台账里，本条只要求它是一张真 PNG。
//     允许手画是有意的 —— 指南里写着可以直接拷一张图进来。
//   · 素材的**内容对不对**（框会不会盖住脸、20px 下看不看得清）：那是眼睛的活，
//     出图规格见 docs/guide/头像框使用指南.md。
//   · 运行时的「盘上有没有图」：那是 frame-service 的第三道闸与
//     `npm run cli -- frame list --keys` 的活。
// ─────────────────────────────────────────────────────────────────────────────

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { FRAME_KEYS } from '@/lib/frame-refs';

const ROOT = path.resolve(import.meta.dirname, '../..');
const FRAMES_DIR = path.join(ROOT, 'public', 'static', 'frames');
const MANIFEST = path.join(FRAMES_DIR, 'manifest.json');
const GENERATOR = path.join(ROOT, 'scripts', 'make-frame-demos.mjs');

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function sha256(file: string): string {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** 重跑出图脚本的命令 —— 报错里要给人这一句，而不是让他去猜。 */
const REMEDY = '跑一次 `node scripts/make-frame-demos.mjs`，把 public/static/frames/ 的改动一起提交。';

interface Manifest {
  generator: string;
  generatorSha256: string;
  frames: Record<string, { png: string; preview: string }>;
}

function readManifest(): Manifest {
  expect(
    fs.existsSync(MANIFEST),
    `缺少 ${path.relative(ROOT, MANIFEST)} —— 它由出图脚本写、随素材入库，` +
      `缺了说明素材不是脚本生成的。${REMEDY}`
  ).toBe(true);
  return JSON.parse(fs.readFileSync(MANIFEST, 'utf8')) as Manifest;
}

describe('入库的头像框素材', () => {
  const manifest = readManifest();

  it('★ 出图脚本没被改过（改了就得重跑，否则站点还在用旧图）', () => {
    expect(
      sha256(GENERATOR),
      `scripts/make-frame-demos.mjs 变了，而素材还是上一次生成的 —— 站点会继续显示旧图，` +
        `且不报任何错。${REMEDY}`
    ).toBe(manifest.generatorSha256);
  });

  it('每一项 FRAME_KEYS 都有素材，且是一张真 PNG', () => {
    for (const key of FRAME_KEYS) {
      const file = path.join(FRAMES_DIR, `${key}.png`);
      expect(fs.existsSync(file), `缺少 ${key}.png（FRAME_KEYS 里有它，盘上却没有）`).toBe(true);

      const head = fs.readFileSync(file).subarray(0, 8);
      // 扩展名只是声明 —— 真按扩展名信一次，就是一条同源存储型 XSS 路径
      //（见 src/lib/frame-service.ts 的 ALLOWED_FRAME_MIME）
      expect(head.equals(PNG_SIG), `${key}.png 的内容不是 PNG`).toBe(true);
    }
  });

  it('★ 每张图都还是生成时的那一张（手改过 / 被替换过就红）', () => {
    for (const [key, hashes] of Object.entries(manifest.frames)) {
      const png = path.join(FRAMES_DIR, `${key}.png`);
      expect(fs.existsSync(png), `台账里有 ${key}，盘上却没有 —— ${REMEDY}`).toBe(true);
      expect(sha256(png), `${key}.png 与台账对不上（被手改过？还是脚本改了没重跑？）`).toBe(
        hashes.png
      );

      const preview = path.join(FRAMES_DIR, `_preview-20px-${key}.png`);
      expect(fs.existsSync(preview), `缺少 _preview-20px-${key}.png —— ${REMEDY}`).toBe(true);
      expect(sha256(preview), `_preview-20px-${key}.png 与台账对不上`).toBe(hashes.preview);
    }
  });

  it('★ 台账不是空的、也不含已下线的 key', () => {
    // 自检：上面两条都是「遍历台账 / 遍历 FRAME_KEYS」，台账被清空时它们会**全绿**。
    const keys = Object.keys(manifest.frames);
    expect(keys.length, '台账里一个框都没有').toBeGreaterThan(0);
    // 脚本里的 key 必须是 FRAME_KEYS 的子集 —— 出了图却没登记（或登记完又从
    // FRAME_KEYS 里删了）都会在这里露出来（后者会让扫盘直接忽略那张图）
    for (const key of keys) {
      expect(FRAME_KEYS as readonly string[], `台账里的 ${key} 不在 FRAME_KEYS 里`).toContain(key);
    }
  });

  it('生成脚本确实在生成这些框（防止它被改成写别处 / 只写一部分）', () => {
    // 反向自检：脚本里出现每一个 key 的字面量定义。哈希那两条只证明「文件没变」，
    // 证明不了「文件里还真有这些框」—— 比如有人把 FRAMES 清空后重跑，台账会跟着
    // 变成空对象，第一条与第三条就都绿了（第四条会拦住）。这里是第二道。
    //
    // ⚠️ 判据是**台账里的 key**，不是 FRAME_KEYS —— 两者刻意允许不等：手画的框
    //（没进脚本、直接拷一张 PNG 进来的那种）是合法的（指南 §4 明说了），它不在
    // 台账里、也不该被这条拦下。写成 FRAME_KEYS 就等于**偷偷禁掉了手画那条路**，
    // 而报错信息还指着「跑一次出图脚本」—— 对手画的框来说那是一句不可能执行的建议。
    const src = fs.readFileSync(GENERATOR, 'utf8');
    for (const key of Object.keys(manifest.frames)) {
      expect(src, `出图脚本里找不到 ${key} 的定义`).toMatch(new RegExp(`\\n\\s*${key}:\\s*\``));
    }
  });
});
