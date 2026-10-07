import { describe, expect, it } from 'vitest';
import {
  RESOURCE_KINDS,
  dbStamp,
  filterResourceItems,
  resourceKind,
} from '@/lib/md-editor/resources';
import { AUDIO_REF_PROBE } from '@/lib/audio-refs';
import { CLIPBOARD_REF_PROBE, IMAGE_REF_PROBE, MAX_BLOG_REF_ITEMS } from '@/lib/content-refs';
import { FAVORITE_ID_RE } from '@/lib/favorite-refs';

// 「插入引用」面板的词汇表：五类资源的解析与插入语法。
//
// 【为什么值得单测】三件事都是静默的：
//   · 读口解析写松 → 少一列只是标题空着，看不出是解析错了；
//   · 插入语法拼错 → 正文里留一段方括号原文，谁也不报错；
//   · 私有收藏夹被插进正文 → 得到一个**谁的读口都不认**的 token。
// 所以每条插入结果都要拿**正文侧真正用的那条正则**去回验（不是自己再写一个
// 断言用的正则 —— 那样两边一起错还是绿的）。

/** 五类读口的**真实报文形态**（截取自各自的 route.ts，字段一个不多一个不少）。 */
const PAYLOADS = {
  image: {
    code: 200,
    images: [
      {
        id: 'AbCdEf1234',
        filename: '示意图.png',
        file_size: 1234,
        mime_type: 'image/png',
        author_id: 'u1',
        author_name: '甲',
        created_at: '2026-10-07T21:04:05.000Z',
        is_public: true,
        ext: 'png',
        url: '/api/images/AbCdEf1234/raw',
      },
    ],
  },
  audio: {
    code: 200,
    items: [
      {
        id: 'Zx9Yw8Vu7T',
        filename: '录音.m4a',
        file_size: 999,
        mime_type: 'audio/mp4',
        author_id: 'u1',
        author_name: '甲',
        created_at: '2026-10-07T21:04:05.000Z',
        is_public: false,
        ext: 'm4a',
        url: '/api/audio/Zx9Yw8Vu7T/raw',
      },
    ],
  },
  clipboard: {
    code: 200,
    clips: [{ id: 'a1b2c3d4', title: '一段材料', publicity: true, created_at: '2026-10-07T21:04:05.000Z' }],
  },
  vote: {
    code: 200,
    votes: [
      {
        id: 'v1o2t3e4x',
        title: '晚饭吃什么',
        author_id: 'u1',
        author_name: '甲',
        is_locked: false,
        created_at: '2026-10-07T21:04:05.000Z',
        option_count: 3,
        total_votes: 7,
      },
    ],
  },
  favorite: {
    code: 200,
    favorites: [
      {
        id: 12,
        public_id: '123456',
        title: '公开的',
        is_public: true,
        item_count: 4,
        created_at: '2026-10-07T21:04:05.000Z',
      },
      {
        id: 13,
        public_id: null,
        title: '私有的',
        is_public: false,
        item_count: 2,
        created_at: '2026-10-07T21:04:05.000Z',
      },
    ],
  },
} as const;

function parse(kind: Parameters<typeof resourceKind>[0]) {
  const spec = resourceKind(kind);
  return spec.parse(PAYLOADS[kind]);
}

describe('资源面板：五类读口的解析', () => {
  it('五类都在表里，且各有读口 / 空文案 / 说明', () => {
    expect(RESOURCE_KINDS.map((s) => s.key)).toEqual([
      'image',
      'audio',
      'clipboard',
      'vote',
      'favorite',
    ]);
    for (const spec of RESOURCE_KINDS) {
      expect(spec.endpoint).toBe(`/api/${spec.key === 'image' ? 'images' : spec.key === 'vote' ? 'votes' : spec.key === 'favorite' ? 'favorites' : spec.key}`);
      expect(spec.empty.length).toBeGreaterThan(0);
      expect(spec.hint.length).toBeGreaterThan(0);
    }
  });

  it('★ 插入语法必须能被正文侧的正则认出来 ★', () => {
    // 图床：标准 Markdown（**不是** 10 位 token）—— 与上传插入同一个形状
    const image = parse('image')[0];
    expect(image.insert).toBe('![示意图.png](/api/images/AbCdEf1234/raw)\n');
    expect(IMAGE_REF_PROBE.test('')).toBe(false); // 只是提醒这条断言不走 token 那条路

    // 音频：具名合集 token
    const audio = parse('audio')[0];
    expect(AUDIO_REF_PROBE.test(audio.insert ?? '')).toBe(true);

    // 剪贴板：8 位
    const clip = parse('clipboard')[0];
    expect(CLIPBOARD_REF_PROBE.test(clip.insert ?? '')).toBe(true);

    // 投票：9 位（8 位 / 10 位的正则都不该认它 —— 按长度分流的意义就在这里）
    const vote = parse('vote')[0];
    expect(CLIPBOARD_REF_PROBE.test(vote.insert ?? '')).toBe(false);
    expect(IMAGE_REF_PROBE.test(vote.insert ?? '')).toBe(false);

    // 收藏夹：6 位数字
    const fav = parse('favorite')[0];
    expect(FAVORITE_ID_RE.test('123456')).toBe(true);
    expect(fav.insert).toBe('[@123456]');
  });

  it('★ 私有收藏夹列得出来、但插不进去，并给出理由 ★', () => {
    const [pub, priv] = parse('favorite');
    expect(pub.insert).toBe('[@123456]');
    // 私有收藏夹的 public_id 恒为 NULL（没有句柄）—— 插一个假的只会得到一段
    // 谁也不认的方括号，所以这里必须是 null + 一句人话
    expect(priv.insert).toBeNull();
    expect(priv.reason).toBeTruthy();
    expect(priv.title).toBe('私有的');
  });

  it('public_id 形态不对（不是 6 位数字）也按不可插入处理', () => {
    const items = resourceKind('favorite').parse({
      favorites: [{ id: 1, public_id: '12', title: '坏 id', is_public: true }],
    });
    expect(items[0].insert).toBeNull();
  });

  it('报文形态不对一律得到空列表，不抛', () => {
    for (const spec of RESOURCE_KINDS) {
      expect(spec.parse(null)).toEqual([]);
      expect(spec.parse({ code: 403, message: '需要核心用户权限' })).toEqual([]);
      expect(spec.parse({ wrong: 'shape' })).toEqual([]);
    }
  });

  it('缺字段的条目跳过，不让一条坏数据把整个面板打空', () => {
    const items = resourceKind('image').parse({
      images: [{ filename: '没有 id' }, { id: 'AbCdEf1234', filename: '好的.png' }],
    });
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe('好的.png');
  });

  it('时间戳只切字符串，**不做时区换算**', () => {
    // 库里的形态是「UTC+8 墙上时间贴 Z」（src/lib/db-time.ts）。用 new Date() 再
    // 本地化会把东八区的 21:04 显示成别的钟点 —— 东八区之外的读者看到差 8 小时的
    // 日期，而本机跑测试时**看不出来**（本机就是东八区）。
    expect(dbStamp('2026-10-07T21:04:05.000Z')).toBe('2026-10-07 21:04');
    expect(dbStamp(null)).toBe('');
    expect(dbStamp('坏了')).toBe('');
  });

  it('标题里的 id 也参与本地搜索', () => {
    const items = parse('image');
    expect(filterResourceItems(items, '')).toHaveLength(1);
    expect(filterResourceItems(items, '示意')).toHaveLength(1);
    expect(filterResourceItems(items, 'abcdef1234')).toHaveLength(1);
    expect(filterResourceItems(items, '不存在')).toHaveLength(0);
  });

  it('面板的插入条数与正文侧的引用上限是两回事，这里不擅自截断', () => {
    // 预算由正文管线按整篇算（MAX_BLOG_REF_ITEMS），面板只负责「插一条」。
    // 面板若自己截断，用户会看到「列表里少了后半段」而没有任何提示。
    const many = resourceKind('clipboard').parse({
      clips: Array.from({ length: MAX_BLOG_REF_ITEMS + 20 }, (_, i) => ({
        id: `abcdef${String(i).padStart(2, '0')}`,
        title: `第 ${i} 条`,
        publicity: true,
        created_at: null,
      })),
    });
    expect(many).toHaveLength(MAX_BLOG_REF_ITEMS + 20);
  });
});
