// poster.ts —— 画报 / 收款码的 SVG 构造。
//
// 【为什么这里要用真解码器（jsqr）而不是只断言 SVG 片段】
// 画报的失败模式是「图很好看，但扫不出来」—— 那是线上最难发现、也最没法排查的一类
// 问题：用户不会来报告「你的二维码扫不出来」，他只会放弃。
//
// 这条用例不是假想的。写完画报的第一版，二维码内边距写死 48px；短链接的模块更大，
// 48px 实际不到规范要求的 4 个模块静默区，jsQR **直接解不出来**（长链接反而没事，
// 因为模块小）。当时肉眼看图完全正常。所以「渲染成 PNG 再解码」这一步必须留在用例里，
// 它是唯一能挡住「静默区 / 纠错等级 / 单元尺寸」这类改动的东西。

import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import jsQR from 'jsqr';

import {
  buildCollectPosterSvg,
  buildProfilePosterSvg,
  escapeXml,
  fitLine,
  qrModuleCount,
  stripControlChars,
  wrapText,
} from '@/lib/poster';

/** 1×1 透明 PNG —— 用例不需要真头像，避开 identicon 与 sharp 的额外往返。 */
const AVATAR =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/** 由码位拼控制字符 —— 源码里直接写字面量会让整个文件变成「二进制文件」。 */
function ctl(...codes: number[]): string {
  return codes.map((c) => String.fromCharCode(c)).join('');
}

/** 与路由一致的光栅化参数（density 144 = 2×）。 */
async function rasterize(svg: string): Promise<Buffer> {
  return sharp(Buffer.from(svg, 'utf8'), { density: 144 }).png().toBuffer();
}

/** 把渲染出来的画报丢给解码器，返回扫出来的内容（扫不出 → null）。 */
async function decode(svg: string): Promise<string | null> {
  const png = await rasterize(svg);
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const res = jsQR(new Uint8ClampedArray(data), info.width, info.height);
  return res?.data ?? null;
}

function profile(overrides: Partial<Parameters<typeof buildProfilePosterSvg>[0]> = {}) {
  return buildProfilePosterSvg({
    username: '聪明山上的猫',
    roleLabel: '核心用户',
    bio: '一句话简介。',
    joinedYear: '2023',
    blogs: 42,
    likes: 1287,
    comments: 356,
    qrText: 'https://raricy.com/u/u_e2e_owner',
    avatarDataUri: AVATAR,
    ...overrides,
  });
}

describe('文本转义（用户可控内容进 SVG 的唯一一道闸）', () => {
  it('转义 XML 元字符', () => {
    expect(escapeXml('<script>alert(1)</script>')).toBe(
      '&lt;script&gt;alert(1)&lt;/script&gt;'
    );
    expect(escapeXml('a & b "c" \'d\'')).toBe('a &amp; b &quot;c&quot; &apos;d&apos;');
  });

  it('去掉 XML 1.0 不允许的控制字符，但保留制表符与换行', () => {
    const nul = ctl(0x00, 0x01, 0x1f);
    const del = ctl(0x7f);
    expect(stripControlChars(`a${nul}b${del}c`)).toBe('abc');
    expect(stripControlChars('a\tb\nc')).toBe('a\tb\nc');
  });

  it('简介里的尖括号进不了 SVG 结构，只会被当成字面量', () => {
    const svg = profile({ bio: '<script>alert(1)</script>' });
    expect(svg).not.toContain('<script>');
    expect(svg).toContain('&lt;script&gt;');
  });

  it('用户名同样被转义', () => {
    const svg = profile({ username: '<img src=x onerror=alert(1)>' });
    expect(svg).not.toContain('<img');
  });
});

describe('折行与自适应字号（SVG 没有自动断行）', () => {
  it('按估算字宽折行', () => {
    // 字号 10 → 每行 10 个汉字
    const lines = wrapText('一二三四五六七八九十一二三四五', 10);
    expect(lines).toEqual(['一二三四五六七八九十', '一二三四五']);
  });

  it('尊重显式换行', () => {
    expect(wrapText('上\n下', 10)).toEqual(['上', '下']);
  });

  it('超过行数上限时在最后一行截断加省略号', () => {
    // 25 个字 → 10/10/5 三行，超过上限 2 → 砍到两行，第二行补省略号
    const lines = wrapText('一二三四五六七八九十一二三四五六七八九十一二三四五', 10, 2);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe('一二三四五六七八九十');
    expect(lines[1].endsWith('…')).toBe(true);
    // 省略号本身也要算进宽度里
    expect(Array.from(lines[1]).length).toBeLessThanOrEqual(10);
  });

  it('恰好等于行数上限时不截断（没有第三行就别加省略号）', () => {
    const lines = wrapText('一二三四五六七八九十一二三四五六七八九十', 10, 2);
    expect(lines).toEqual(['一二三四五六七八九十', '一二三四五六七八九十']);
  });

  it('放得下就不缩、放不下就缩、缩到底还放不下才截断', () => {
    expect(fitLine('短', 600, 46).size).toBe(46);

    const shrunk = fitLine('中等长度的用户名', 200, 46, 20);
    expect(shrunk.size).toBeLessThan(46);
    expect(shrunk.size).toBeGreaterThanOrEqual(20);
    expect(shrunk.text).toBe('中等长度的用户名');

    const cut = fitLine('a'.repeat(200), 100, 46, 20);
    expect(cut.size).toBe(20);
    expect(cut.text.endsWith('…')).toBe(true);
  });
});

describe('二维码：渲染成 PNG 之后必须真的能扫出来', () => {
  // 模块数随 payload 长度变化很大 —— 这是对「静默区 ≥ 4 模块」那条约束的压力测试。
  // 短链接模块大，正是当初踩坑的那一档。
  const payloads = [
    'https://raricy.com/u/x', // 最短：模块最少、模块尺寸最大
    'https://raricy.com/u/abc',
    'https://raricy.com/u/u_e2e_owner',
    'https://raricy.com/u/9f8c1d2e-4a3b-4c5d-8e7f-0123456789ab', // 真实 uuid 长度
    'https://raricy.com/fish/collect?to=%E8%81%AA%E6%98%8E%E5%B1%B1%E4%B8%8A%E7%9A%84%E7%8C%AB',
  ];

  it.each(payloads)('主页画报：%s', async (text) => {
    expect(await decode(profile({ qrText: text }))).toBe(text);
  });

  it.each(payloads.slice(0, 4))('收款码：%s', async (text) => {
    const svg = buildCollectPosterSvg({
      username: '聪明山上的猫',
      qrText: text,
      avatarDataUri: AVATAR,
    });
    expect(await decode(svg)).toBe(text);
  });

  it('模块数随内容增长（短内容模块更少，正是静默区最紧的情况）', () => {
    expect(qrModuleCount('https://raricy.com/u/x')).toBeLessThan(
      qrModuleCount('https://raricy.com/u/9f8c1d2e-4a3b-4c5d-8e7f-0123456789ab')
    );
  });
});

describe('版式', () => {
  const heightOf = (svg: string) => Number(svg.match(/height="(\d+)"/)?.[1]);

  it('高度按内容算：有简介、有注册年份时更高', () => {
    const full = heightOf(profile());
    const bare = heightOf(profile({ bio: '', joinedYear: '', roleLabel: '' }));
    expect(full).toBeGreaterThan(bare);
    expect(profile()).toContain('width="750"');
  });

  it('没有简介与注册年份时不写占位文案', () => {
    const svg = profile({ bio: '', joinedYear: '' });
    expect(svg).not.toContain('这个人还没有写简介');
    expect(svg).not.toContain('注册于');
  });

  it('整幅满出血：四角必须不透明（图片是方的，圆角只会把角抠漏）', async () => {
    // 曾经给背景矩形加过 rx=28，四个角变成透明的：弹窗里（浅灰底）露出四个灰色
    // 小月牙，下载到手机上换个深色底看也是破的。方图里抠圆角 = 把角抠漏，
    // 要圆角是展示端的事（CSS border-radius），不该烧进像素。
    for (const svg of [
      profile(),
      buildCollectPosterSvg({
        username: '聪明山上的猫',
        qrText: 'https://raricy.com/fish/collect?to=x',
        avatarDataUri: AVATAR,
      }),
    ]) {
      const png = await rasterize(svg);
      const { data, info } = await sharp(png)
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      const alphaAt = (x: number, y: number) => data[(y * info.width + x) * 4 + 3];
      const corners: Array<[number, number]> = [
        [0, 0],
        [info.width - 1, 0],
        [0, info.height - 1],
        [info.width - 1, info.height - 1],
      ];
      for (const [x, y] of corners) {
        expect(alphaAt(x, y), `角点 (${x},${y}) 不该是透明的`).toBe(255);
      }
    }
  });

  it('二维码内容以文字形式印在卡片上（去掉协议头）', () => {
    expect(profile({ qrText: 'https://raricy.com/u/abc' })).toContain('raricy.com/u/abc');
  });

  it('收款码把用户名印在图上（收款方身份）', () => {
    const svg = buildCollectPosterSvg({
      username: '聪明山上的猫',
      qrText: 'https://raricy.com/fish/collect?to=x',
      avatarDataUri: AVATAR,
    });
    expect(svg).toContain('聪明山上的猫');
    expect(svg).toContain('收款方');
  });
});
