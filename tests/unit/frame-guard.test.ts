// ─────────────────────────────────────────────────────────────────────────────
// frame-guard.test.ts —— 静态检查：渲染层不许碰头像框的**原始装备列**
//
// 【绊的是什么】到期判定**全仓只有一处**：`frame-service.frameUrlFor()`（内部调
// frame-refs.resolveFrameKey，那是唯一的比较运算）。渲染层拿到的必须永远是它算好的
// `frameUrl` 字符串。
//
// 而装备态在库里是 `users` 上的两个标量：`equipped_frame_key` +
// `equipped_frame_expires_at`。它们在 `SafeUser` 上**一直存在**（`SafeUser` 是
// `Omit<User, …>`，类型系统不知道某个 select 有没有取那一列），所以组件里写
//
//     const k = user.equippedFrameKey;   // ← 编译通过、运行时也真有值
//     if (k) { … }                        // ← 但**没判到期**
//
// 是完全合法的代码。它的后果是：**到期后那一处的框永远不消失** ——
// 不报错、不 500、日志里什么都没有，只有人眼盯着一个人到期的那一天才看得出来。
//
// 【为什么只有静态检查能钉住】tsc 拦不住（字段存在）；构建不报错；单测也要恰好
// 造出「已过期且仍装备」的状态才碰得到。跟 db-time-guard / blog-visibility-guard /
// anonymous-read-guard 同属一类。
//
// ── 【判据与它的边界】────────────────────────────────────────────────────────
// 扫描面 = src 下的所有 .tsx，加上 src/app 下的所有 .ts。即「所有渲染层代码」。
// `src/lib/**` **不在**扫描面内 —— 那里正是 DTO 生产者，它们**必须**读这两列才能
// 算出 frameUrl（它们读的方式是 `select: { equippedFrameKey: true }` 然后交给
// frameUrlFor，不是自己比较时间）。
//
// ⚠️ **它是绊线，不是证明器**：这条守卫保证的是「渲染层没有直接读原始列」，
//    它**不保证**每个 DTO 生产者都调了 frameUrlFor（那由
//    tests/service/frame-dto.test.ts 的台账负责），也**不保证**渲染时把 frameUrl
//    真的传给了 <Avatar>（那只由 e2e 负责 —— 见 avatar-frame.spec.ts）。
//    三道加起来才是完整的；任何一道单独看都会给人虚假的安全感。
// ─────────────────────────────────────────────────────────────────────────────

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');
const SRC = path.join(ROOT, 'src');

/** 原始装备列的四个拼写（camel 与 snake、两个字段各一份）。 */
const BANNED = [
  /equippedFrameKey/,
  /equipped_frame_key/,
  /equippedFrameExpiresAt/,
  /equipped_frame_expires_at/,
];

/** 唯一允许读这两列的目录：DTO 生产者与服务层。 */
const OWNER_PREFIX = path.join(SRC, 'lib') + path.sep;

/** 剥注释（保留换行）。只处理行注释与块注释就够 —— 这两个标识符不会出现在字符串里。 */
function stripComments(src: string): string {
  let out = '';
  let i = 0;
  let mode: 'code' | 'line' | 'block' = 'code';
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (mode === 'line') {
      if (c === '\n') {
        mode = 'code';
        out += c;
      } else out += ' ';
      i += 1;
      continue;
    }
    if (mode === 'block') {
      if (c === '*' && n === '/') {
        mode = 'code';
        out += '  ';
        i += 2;
        continue;
      }
      out += c === '\n' ? c : ' ';
      i += 1;
      continue;
    }
    if (c === '/' && n === '/') {
      mode = 'line';
      out += '  ';
      i += 2;
      continue;
    }
    if (c === '/' && n === '*') {
      mode = 'block';
      out += '  ';
      i += 2;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

/**
 * 扫描面：src 下的所有 .tsx（渲染层），加上 src/app 下的所有 .ts
 *（路由 handler 与页面里的非组件模块 —— 它们同样不该直接读原始列，一律走 frameUrlFor）。
 *
 * ⚠️ 注释里别写 glob 字面量（斜杠 + 连续两个星号那种）：其中的星号斜杠序列会
 *    **提前终止块注释**，而那是个语法错误、不是渲染问题（本文件踩过一次）。
 */
function scopedFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (
        e.name.endsWith('.tsx') || (e.name.endsWith('.ts') && full.startsWith(path.join(SRC, 'app')))
      ) {
        out.push(full);
      }
    }
  };
  walk(SRC);
  return out;
}

function scan(text: string, rel: string): string[] {
  const hits: string[] = [];
  stripComments(text)
    .split(/\r?\n/)
    .forEach((line, i) => {
      if (BANNED.some((re) => re.test(line))) hits.push(`${rel}:${i + 1}: ${line.trim()}`);
    });
  return hits;
}

const rel = (f: string) => path.relative(ROOT, f).split(path.sep).join('/');

describe('渲染层不许直接读头像框的原始装备列', () => {
  // ★ 产出自检 ★ —— 正则写错时下面那条会一片绿，而它其实什么都没扫到。
  it('自检：四个拼写都能被认出来', () => {
    const sample = [
      '  const k = user.equippedFrameKey;',
      '  select: { equipped_frame_key: true },',
      '  if (row.equippedFrameExpiresAt) { … }',
      '  data: { equipped_frame_expires_at: null },',
    ].join('\n');
    expect(scan(sample, 's.ts').length, '四种拼写都要命中').toBe(4);
  });

  it('自检：注释里的（比如解释这条纪律的那段）不该被命中', () => {
    const sample = [
      '// 别读 equippedFrameKey —— 那是原始列，没有到期判定',
      '/**',
      ' * 装备态在 equipped_frame_key 与 equipped_frame_expires_at 两列上',
      ' */',
    ].join('\n');
    expect(scan(sample, 's.ts')).toEqual([]);
  });

  it('★ 全仓扫描：渲染层没有任何一处直接读这两列', () => {
    const hits = scopedFiles()
      .filter((f) => !f.startsWith(OWNER_PREFIX))
      .flatMap((f) => scan(fs.readFileSync(f, 'utf8'), rel(f)));

    expect(
      hits,
      '渲染层请改用 DTO 上的 frameUrl（服务层已经用 frame-service.frameUrlFor() 算好了，\n' +
        '含到期判定）。直接读原始列的后果是**到期后那一处的框永远不消失** ——\n' +
        '不报错、不 500、日志里什么都没有。\n' +
        '若确实需要「没判定的原始值」，那多半说明你该改的是服务层的 DTO。违规处：\n  ' +
        (hits.join('\n  ') || '（无）')
    ).toEqual([]);
  });

  it('★ 扫描面自检：真的扫到了渲染层文件（路径写错时上面那条会假绿）', () => {
    const files = scopedFiles();
    expect(files.length, 'src/ 下应当有大量 tsx 与 app 下的 ts').toBeGreaterThan(50);
    expect(files.some((f) => rel(f) === 'src/app/components/Avatar.tsx')).toBe(true);
    expect(files.some((f) => rel(f) === 'src/app/layout.tsx')).toBe(true);
  });

  it('扫描面确实排除了 src/lib（否则 DTO 生产者会被误报，而它们本该读这两列）', () => {
    const files = scopedFiles();
    expect(files.some((f) => rel(f) === 'src/lib/frame-service.ts')).toBe(false);
    expect(files.some((f) => rel(f) === 'src/lib/blog-service.ts')).toBe(false);
  });

  it('DTO 生产者那边确实在读这两列（证明上面那条不是因为「全仓没人读」而绿）', () => {
    // 反向自检：若哪天有人把 select 全删了，上面那条会静默变成「永远没有框」的绿色。
    const hits = scan(
      fs.readFileSync(path.join(SRC, 'lib', 'comment-service.ts'), 'utf8'),
      'comment-service.ts'
    );
    expect(hits.length, 'comment-service 应当 select 了装备两列').toBeGreaterThan(0);
  });
});
