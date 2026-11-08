// ─────────────────────────────────────────────────────────────────────────────
// avatar-sites-guard.test.ts —— 静态检查：头像只能走共用组件，URL 只有一处口径
//
// 【绊的是什么】全站有 16 个文件渲染头像（20px 到 120px）。此前每处都自己拼
// `/api/avatar/<id>`、自己记得写 `border-radius: 8%`。头像框要显示得到处都是，
// 所以必须先收敛 —— 而收敛之后真正危险的是**有人又手写回去**：
//
//     <img src={`/api/avatar/${id}`} />        ← 这一处永远不会有头像框
//
// 它**不报错**：页面照常渲染，只是那个人没有框，没有日志、没有 500。tsc 管不着
//（类名与 URL 都是字符串），单测也管不着（除非恰好覆盖到那一处）。跟 db-time-guard /
// blog-visibility-guard / anonymous-read-guard 同属一类：**只有静态检查能钉住**。
//

// 【只保留反向判据】（Round4 精简）
//   原来还有一张手工维护的「头像落点台账」：逐文件断言用了 <Avatar> / 出现 avatar__frame。
//   那是文件清单 + 写法断言，新增页面时台账本身要同步，且只覆盖列出的文件。
//   「框到底显示出来没有」由 tests/unit/avatar-component.test.ts 与
//   tests/e2e/avatar-frame.spec.ts 按真实渲染钉住，这里只留反向判据：
//   `/api/avatar/` 这个字面量全仓只允许出现在 src/lib/avatar-refs.ts 一处。
//   别的地方一律用 avatarUrl(id) 或 <Avatar>（组件内部就是调它）。
//   手写模板串的那一处**永远不会有头像框**：页面照常渲染，只是那个人没有框，
//   不报错、没有日志、没有 500 —— 只有静态检查能钉住「有没有人绕开唯一出口」。
//
// ── 【为什么注释要单独处理】──────────────────────────────────────────────────
// 本仓的注释里**故意**写着 `/api/avatar/<id>` 当反例（avatar.ts 的文件头、
// oauth/userinfo 的说明、ChatSidebar 与 CheckinCard 里解释旧写法的段落）。
// 不剥注释的话，这条守卫会把自己的文档判成违规 —— 而它一旦天天误报，最终会被人关掉。
//
// ⚠️ 剥离器必须**认得字符串字面量**：模板串 `` `/api/avatar/${id}` `` 正是我们要抓的
//    东西，把它当成「注释的开头」吃掉就等于瞎了。所以下面是一个三态的扫描器
//    （普通 / 注释 / 字符串），不是一句正则。
// ─────────────────────────────────────────────────────────────────────────────

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');
const SRC = path.join(ROOT, 'src');

/** 拼头像 URL 的**唯一**允许处。 */
const URL_OWNER = 'src/lib/avatar-refs.ts';

/** 全仓唯一的头像 URL 前缀字面量。 */
const AVATAR_URL_RE = /\/api\/avatar\//;

/**
 * 剥掉注释，**保留换行**（行号不能漂 —— 报错要指得到行）。
 *
 * 三态扫描：普通代码 / 注释 / 字符串字面量（`'` `"` `` ` ``）。
 * 字符串态是必须的：模板串 `` `/api/avatar/${id}` `` 正是判据 1 要抓的东西，
 * 若把 `//` 的判定做在字符串之前，`'https://…'` 这类会吃掉半行，
 * 而我们要抓的模板串**可能就在那半行里**（假阴性 = 守卫瞎了）。
 *
 * 转义用「前一个字符是不是反斜杠」近似判断 —— 对 TS 源码足够，
 * 且它出错的方向是「少数几个字符被当成字符串」，不会把代码吃成注释。
 */
function stripComments(src: string): string {
  let out = '';
  let i = 0;
  type Mode = 'code' | 'line' | 'block' | 'sq' | 'dq' | 'tpl';
  let mode: Mode = 'code';
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    const escaped = i > 0 && src[i - 1] === '\\';

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
    if (mode === 'sq' || mode === 'dq' || mode === 'tpl') {
      const closer = mode === 'sq' ? "'" : mode === 'dq' ? '"' : '`';
      out += c;
      if (c === closer && !escaped) mode = 'code';
      i += 1;
      continue;
    }

    // mode === 'code'
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
    if (c === "'") mode = 'sq';
    else if (c === '"') mode = 'dq';
    else if (c === '`') mode = 'tpl';
    out += c;
    i += 1;
  }
  return out;
}

/** 扫全仓源码（已剥注释），返回违规处的 `相对路径:行号: 内容`。 */
function scan(text: string, rel: string): string[] {
  const hits: string[] = [];
  stripComments(text)
    .split(/\r?\n/)
    .forEach((line, i) => {
      if (AVATAR_URL_RE.test(line)) hits.push(`${rel}:${i + 1}: ${line.trim()}`);
    });
  return hits;
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) sourceFiles(full, out);
    else if (/\.tsx?$/.test(e.name)) out.push(full);
  }
  return out;
}

const rel = (f: string) => path.relative(ROOT, f).split(path.sep).join('/');

describe('剥注释：认得出字符串，也只剥注释', () => {
  // ★ 产出自检 ★ —— 剥离器写错时（把字符串当注释 / 把注释当代码），下面那条全仓
  // 扫描会**一片绿**，而它其实什么都没扫到、或者扫到了一堆假阳性。
  it('★ 自检：注释里的违规串被剥掉，代码里的（含模板串）留着', () => {
    const sample = [
      '// 反例：<img src={`/api/avatar/${id}`} />',
      '/* 块注释里的 /api/avatar/ 也该被剥掉 */',
      '/* 跨行块注释第一行 /api/avatar/',
      '   第二行还有 /api/avatar/ */',
      'const a = `/api/avatar/${id}`;',
      "const b = '/api/avatar/x';",
    ].join('\n');
    const hits = scan(sample, 'sample.ts');
    // 只有最后两行是代码
    expect(hits.length, `应当只命中两行代码，实际：\n${hits.join('\n')}`).toBe(2);
    expect(hits[0]).toContain('const a');
    expect(hits[1]).toContain('const b');
  });

  it('自检：行号不漂（剥注释保留换行）', () => {
    const sample = ['// 一', '/* 二', '三 */', 'const x = `/api/avatar/y`;'].join('\n');
    expect(scan(sample, 's.ts')[0]).toMatch(/^s\.ts:4:/);
  });

  it('自检：字符串里的 // 不会被当成注释开头（否则会吃掉同一行后半段的违规串）', () => {
    const sample = "const u = 'https://example.com'; const v = `/api/avatar/${id}`;";
    expect(scan(sample, 's.ts').length, '同一行后半段的模板串必须被看见').toBe(1);
  });

  it('自检：整段被注释掉的代码命中 0（行注释与块注释两种都要剥干净）', () => {
    const sample = [
      '// const a = `/api/avatar/a`;',
      '/*',
      '  const b = `/api/avatar/b`;',
      '  const c = `/api/avatar/c`;',
      '*/',
      'const live = 1;',
    ].join('\n');
    expect(scan(sample, 's.ts'), '块注释里那两行也必须被剥掉').toEqual([]);
  });
});

describe('★ 判据 1：拼头像 URL 只有一处口径', () => {
  it('全仓扫描：/api/avatar/ 只出现在 avatar-refs.ts', () => {
    const hits = sourceFiles(SRC)
      .flatMap((f) => scan(fs.readFileSync(f, 'utf8'), rel(f)))
      .filter((h) => !h.startsWith(`${URL_OWNER}:`));

    expect(
      hits,
      '拼头像地址请用 src/lib/avatar-refs.ts 的 avatarUrl(id)，渲染头像请用\n' +
        'src/app/components/Avatar.tsx 的 <Avatar>。手写模板串的那一处**永远不会有\n' +
        '头像框**，而且不报错（页面照常渲染，只是那个人没有框）。违规处：\n  ' +
        (hits.join('\n  ') || '（无）')
    ).toEqual([]);
  });

  it('★ 扫描面自检：真的扫到了源码（路径写错时上面那条会假绿）', () => {
    const files = sourceFiles(SRC);
    expect(files.length, 'src/ 下应当有大量 ts/tsx').toBeGreaterThan(100);
    // 唯一允许拼 URL 的那个文件必须在扫描面内 —— 否则上面那条的「排除它」是空操作
    expect(files.some((f) => rel(f) === URL_OWNER)).toBe(true);
  });

  it('avatar-refs.ts 自己确实定义了那个前缀（否则上面那条排除它就成了放行一切）', () => {
    const src = fs.readFileSync(path.join(ROOT, URL_OWNER), 'utf8');
    expect(stripComments(src)).toMatch(AVATAR_URL_RE);
  });
});
