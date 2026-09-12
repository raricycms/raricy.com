// 工具模块：invite-code / short-id / identicon
//
// 这三个模块共同点是「产物直接进 URL、进数据库主键、进浏览器渲染」，
// 出错的方式都不是抛异常，而是静默产出一个坏值：
//   · 邀请码长度不是 12 → 注册端 length===12 校验直接判死，码当场作废；
//   · 短 ID 撞号 → 剪贴板/投票主键冲突或串号；
//   · identicon 不确定 → 用户头像每次刷新都变；identicon 回显 seed → SVG XSS。
// 所以下面测的都是「值本身的形状与不变量」，而不是函数跑没跑通。

import { describe, it, expect, beforeAll } from 'vitest';
import { generateInviteCode } from '@/lib/invite-code';
import { generateShortId } from '@/lib/short-id';
import { generateIdenticonSvg } from '@/lib/identicon';
import { resetDb, prisma } from '../helpers/db';

// base62 默认表（数字 + 大写 + 小写）——与 Flask 侧 base62 PyPI 包的 CHARSET_DEFAULT 一致
const BASE62 = /^[0-9A-Za-z]{12}$/;
// short-id 字符集：小写字母 + 数字（对齐 Flask generate_stringid.py）
const SHORTID_CHARS = /^[a-z0-9]+$/;

// ═══════════════════════════════════════════════════════════════════════════
// 1. invite-code —— 对照 Flask app/utils/invite_code.py:generate_invite_code
// ═══════════════════════════════════════════════════════════════════════════

describe('generateInviteCode：12 位 base62（注册端按 length===12 硬校验）', () => {
  beforeAll(async () => {
    await resetDb();
  });

  it('生成的码恰好 12 位且全为 base62 字符', async () => {
    const code = await generateInviteCode();
    expect(code.length, `邀请码长度必须为 12，实际 ${code.length}：${code}`).toBe(12);
    expect(code, `邀请码含非 base62 字符：${code}`).toMatch(BASE62);
  });

  it('落库：生成后能按 code 查到记录，且 isUsed=false', async () => {
    const code = await generateInviteCode();
    const row = await prisma.inviteCode.findUnique({ where: { code } });
    expect(row, `生成的邀请码 ${code} 没有落库，注册时会查不到`).not.toBeNull();
    expect(row!.isUsed, '新码必须是未使用状态').toBe(false);
    expect(row!.usedBy).toBeNull();
    expect(row!.createdAt).toBeInstanceOf(Date);
  });

  it('大量生成（500 个）：长度恒为 12、字符集合法、无重复', async () => {
    const N = 500;
    const codes: string[] = [];
    for (let i = 0; i < N; i++) codes.push(await generateInviteCode());

    // 长度 / 字符集：任何一个不合规的码都是废码，逐个查
    const badLen = codes.filter((c) => c.length !== 12);
    expect(badLen, `有 ${badLen.length} 个码长度不是 12，例如 ${badLen.slice(0, 3)}`).toEqual([]);
    const badChar = codes.filter((c) => !BASE62.test(c));
    expect(badChar, `有 ${badChar.length} 个码含非 base62 字符，例如 ${badChar.slice(0, 3)}`).toEqual([]);

    // 无重复：code 是 @unique 列，撞号会让 prisma.create 直接抛错，
    // 所以这里能跑到断言本身就已经说明没撞；但显式断言可以定位是「静默去重」还是真没撞。
    expect(new Set(codes).size, `${N} 个码里出现重复`).toBe(N);
  }, 60_000);

  it('随机性抽查：500 个码里首字符不应全都一样（不是常量生成器）', async () => {
    const codes: string[] = [];
    for (let i = 0; i < 200; i++) codes.push(await generateInviteCode());
    const firstChars = new Set(codes.map((c) => c[0]));
    expect(firstChars.size, '所有码首字符都相同，随机源可疑').toBeGreaterThan(1);
  }, 60_000);
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. short-id —— 剪贴板 8 位 / 投票 9 位
// ═══════════════════════════════════════════════════════════════════════════

describe('generateShortId：长度与字符集', () => {
  it('默认 8 位（剪贴板主键 ClipBoard.id 用的就是默认值）', () => {
    const id = generateShortId();
    expect(id.length, `默认长度必须是 8，实际 ${id.length}：${id}`).toBe(8);
    expect(id, `含非法字符：${id}`).toMatch(SHORTID_CHARS);
  });

  it('显式 8 位（剪贴板）与 9 位（投票）都按参数返回对应长度', () => {
    expect(generateShortId(8)).toHaveLength(8);
    expect(generateShortId(9)).toHaveLength(9);
  });

  it('字符集只含小写字母 + 数字（无大写、无符号——ID 要进 URL）', () => {
    // 单次抽样看不出边缘字符，跑 200 次把字符集扫全
    const all = Array.from({ length: 200 }, () => generateShortId(16)).join('');
    expect(all, '出现了小写字母 + 数字以外的字符').toMatch(SHORTID_CHARS);
    // 反向确认：确实同时出现了字母和数字，不是只会吐数字
    expect(all, '200×16 个字符里一个字母都没有，字符集可疑').toMatch(/[a-z]/);
    expect(all, '200×16 个字符里一个数字都没有，字符集可疑').toMatch(/[0-9]/);
  });

  it('各种长度都成立（1 / 2 / 12 / 64）', () => {
    for (const len of [1, 2, 12, 64]) {
      const id = generateShortId(len);
      expect(id, `len=${len}`).toHaveLength(len);
      expect(id, `len=${len} 含非法字符：${id}`).toMatch(SHORTID_CHARS);
    }
  });

  it('len=0 返回空串而不是崩溃', () => {
    expect(generateShortId(0)).toBe('');
  });
});

describe('generateShortId：大量生成无重复', () => {
  it('1000 个 8 位剪贴板 ID 无重复（撞号 = 主键冲突 / 串号）', () => {
    const ids = new Set(Array.from({ length: 1000 }, () => generateShortId(8)));
    expect(ids.size, `1000 个 8 位 ID 出现 ${1000 - ids.size} 次重复`).toBe(1000);
  });

  it('1000 个 9 位投票 ID 无重复', () => {
    const ids = new Set(Array.from({ length: 1000 }, () => generateShortId(9)));
    expect(ids.size, `1000 个 9 位 ID 出现 ${1000 - ids.size} 次重复`).toBe(1000);
  });

  it('两次调用几乎必然不同（不是固定种子）', () => {
    expect(generateShortId(16)).not.toBe(generateShortId(16));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. identicon —— 头像兜底（/api/avatar/[id] 直接把返回值当 image/svg+xml 吐给浏览器）
// ═══════════════════════════════════════════════════════════════════════════

describe('generateIdenticonSvg：确定性（同 id 必须永远同图）', () => {
  it('同一 id 两次调用输出完全相同（否则头像每次刷新都变）', () => {
    const id = '3f8b1c2a-0e4d-4a7b-9c11-2d5e6f708192';
    expect(generateIdenticonSvg(id)).toBe(generateIdenticonSvg(id));
  });

  it('连续 20 次调用输出全部一致（排除隐藏的随机 / 时间依赖）', () => {
    const id = 'stable-user-id';
    const first = generateIdenticonSvg(id);
    const outs = new Set(Array.from({ length: 20 }, () => generateIdenticonSvg(id)));
    expect(outs.size, '同一 id 的输出出现了多个版本，说明含随机或时间依赖').toBe(1);
    expect([...outs][0]).toBe(first);
  });

  it('同 id 不同 size 参数下，同参数依然确定性', () => {
    expect(generateIdenticonSvg('u1', 64)).toBe(generateIdenticonSvg('u1', 64));
    expect(generateIdenticonSvg('u1', 64)).not.toBe(generateIdenticonSvg('u1', 200));
  });
});

describe('generateIdenticonSvg：不同 id 输出不同', () => {
  it('两个相近 id 的输出不同（不是所有人共用一张图）', () => {
    expect(generateIdenticonSvg('user-a')).not.toBe(generateIdenticonSvg('user-b'));
    // 只差一个字符也必须不同（md5 雪崩效应）
    expect(generateIdenticonSvg('abc')).not.toBe(generateIdenticonSvg('abd'));
  });

  it('50 个不同 id 至少产出 45 种不同图案（允许极少量图案碰撞，但不能大面积撞）', () => {
    const svgs = new Set(
      Array.from({ length: 50 }, (_, i) => generateIdenticonSvg(`user-${i}`))
    );
    expect(
      svgs.size,
      `50 个 id 只产出 ${svgs.size} 种图案，区分度不足`
    ).toBeGreaterThanOrEqual(45);
  });
});

describe('generateIdenticonSvg：输出是合法 SVG', () => {
  const svg = generateIdenticonSvg('some-user-id', 200);

  it('以 <svg 开头、以 </svg> 结尾', () => {
    expect(svg.startsWith('<svg'), `输出不以 <svg 开头：${svg.slice(0, 40)}`).toBe(true);
    expect(svg.endsWith('</svg>'), '输出不以 </svg> 结尾').toBe(true);
  });

  it('含 xmlns / viewBox / width / height（缺 xmlns 时浏览器不渲染）', () => {
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(svg).toContain('viewBox="0 0 200 200"');
    expect(svg).toContain('width="200"');
    expect(svg).toContain('height="200"');
  });

  it('含背景矩形与前景色块（不是一张空图）', () => {
    expect(svg, '缺少 rgb(240,240,240) 背景').toContain('fill="rgb(240,240,240)"');
    expect(svg, '一个 <rect> 都没有，图是空的').toMatch(/<rect /);
    // 前景色必须是合法 rgb()，且 r/g/b 在 0-255
    const m = svg.match(/<g fill="rgb\((\d+),(\d+),(\d+)\)">/);
    expect(m, `找不到前景色 <g fill="rgb(r,g,b)">：${svg.slice(0, 120)}`).not.toBeNull();
    for (const v of m!.slice(1, 4)) {
      expect(Number(v)).toBeGreaterThanOrEqual(0);
      expect(Number(v)).toBeLessThanOrEqual(255);
    }
  });

  it('标签成对：<rect> 数量与 <g> 闭合正常，无残缺标签', () => {
    expect((svg.match(/<g /g) || []).length).toBe(1);
    expect((svg.match(/<\/g>/g) || []).length).toBe(1);
    expect((svg.match(/<svg /g) || []).length).toBe(1);
    expect((svg.match(/<\/svg>/g) || []).length).toBe(1);
  });
});

describe('generateIdenticonSvg：边界输入不崩溃', () => {
  const EDGE_CASES: Array<[string, string]> = [
    ['空字符串', ''],
    ['单字符', 'x'],
    ['超长 id（10000 字符）', 'a'.repeat(10_000)],
    ['中文', '聪明山用户'],
    ['emoji', '🐟🐱'],
    ['路径穿越形状', '../../etc/passwd'],
    ['空白字符', '  \t\n  '],
    ['NUL 字符', 'a\0b'],
    ['纯符号', '!@#$%^&*()'],
  ];

  for (const [name, seed] of EDGE_CASES) {
    it(`${name} 不抛异常且仍返回合法 SVG`, () => {
      let out!: string;
      expect(() => {
        out = generateIdenticonSvg(seed);
      }, `seed=${JSON.stringify(seed).slice(0, 30)} 抛异常了`).not.toThrow();
      expect(out.startsWith('<svg')).toBe(true);
      expect(out.endsWith('</svg>')).toBe(true);
    });
  }
});

describe('安全：identicon 输出不得回显原始 seed（SVG XSS）', () => {
  // /api/avatar/[id] 对未通过 ^[a-zA-Z0-9_-]+$ 校验的 id 依然会走到 identicon 分支，
  // 并以 Content-Type: image/svg+xml 返回 —— SVG 在浏览器里是可执行文档，
  // 一旦 seed 被原样拼进输出，等于把任意标记注入同源页面。
  const PAYLOADS = [
    '<script>alert(1)</script>',
    '"><script>alert(1)</script>',
    '"/><script>alert(document.domain)</script><rect x="',
    "'><svg onload=alert(1)>",
    '</g></svg><script>alert(1)</script>',
    // 注意：不要往这里加 '</svg>' 这类「模板本来就有」的串——它必然是输出的子串，
    // includes 判定会假阳性。这类形状由下方「结构不变式」用例覆盖（按标签白名单判定）。
    '<foreignObject><iframe src="javascript:alert(1)"></iframe></foreignObject>',
    'x" onload="alert(1)',
    '&lt;img src=x onerror=alert(1)&gt;',
    'javascript:alert(1)',
    '<!--',
    ']]><script>alert(1)</script>',
  ];

  for (const payload of PAYLOADS) {
    it(`payload 不出现在输出里: ${JSON.stringify(payload).slice(0, 44)}`, () => {
      const out = generateIdenticonSvg(payload);
      expect(
        out.includes(payload),
        `原始 seed 被回显进 SVG，可直接 XSS：\n${out.slice(0, 200)}`
      ).toBe(false);
      // 更强的保证：输出里不该出现任何脚本/事件处理器/外链
      expect(out.toLowerCase(), '输出里出现了 <script>').not.toContain('<script');
      expect(out.toLowerCase(), '输出里出现了 on* 事件处理器').not.toMatch(/\son\w+\s*=/);
      expect(out.toLowerCase(), '输出里出现了 javascript: 协议').not.toContain('javascript:');
      expect(out.toLowerCase(), '输出里出现了 <foreignObject>').not.toContain('<foreignobject');
    });
  }

  it('结构不变式：无论 seed 多脏，输出只由固定标签构成（seed 只经 md5，不进正文）', () => {
    // 允许出现的标签白名单：svg / rect / g。出现别的标签就说明 seed 漏进了输出。
    for (const seed of [...PAYLOADS, '正常用户', '']) {
      const tags = [...generateIdenticonSvg(seed).matchAll(/<\/?([a-zA-Z][\w-]*)/g)].map(
        (m) => m[1].toLowerCase()
      );
      const unexpected = [...new Set(tags)].filter((t) => !['svg', 'rect', 'g'].includes(t));
      expect(
        unexpected,
        `seed=${JSON.stringify(seed).slice(0, 30)} 引入了预期外的标签：${unexpected}`
      ).toEqual([]);
    }
  });
});
