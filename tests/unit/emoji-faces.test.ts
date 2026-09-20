// ─────────────────────────────────────────────────────────────────────────────
// emoji-faces.test.ts —— 内置黄脸清单（src/lib/emoji-faces.json）的自洽性
//
// 【为什么值得单独钉】这份清单是**手写的**（中文名 ↔ 码位），而写错的后果**全是静默的**：
//   · 名字里有空格 / 斜杠 → 那个 token 永远解析不出来，面板里点了没反应；
//   · 码位写错 → 那张图 404，正文里退回字面量，而面板里是一格加载不出来的空白；
//   · 重名 / 重文件 → 一个格子顶掉另一个（Map 后写的赢）。
// 没有一条会报错，所以只能静态挡住。
//
// 【刻意不碰磁盘】这里不验证 public/static/emoji/ 里的文件真的在 —— 那是
// `npm run emoji:check`（以及复制脚本自己的哨兵）的活。这组用例只查清单本身，
// 所以 `npm ci --ignore-scripts` 的环境里也照样跑得动。
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from 'vitest';
import {
  EMOJI_COLLECTION,
  EMOJI_FACES,
  emojiFileFor,
  emojiUrl,
  listEmojiFaces,
} from '@/lib/emoji-faces';
import { STICKER_REF_RE } from '@/lib/sticker-refs';

describe('内置黄脸清单', () => {
  it('非空，且数量够用（面板一栏装得下，也不至于只有寥寥几个）', () => {
    expect(EMOJI_FACES.length).toBeGreaterThan(30);
  });

  it('名字唯一、文件唯一', () => {
    const names = EMOJI_FACES.map((f) => f.name);
    const files = EMOJI_FACES.map((f) => f.file);
    expect(new Set(names).size).toBe(names.length);
    expect(new Set(files).size).toBe(files.length);
  });

  it('素材一律是 <码位>.svg —— 面板靠 <img> 引用，别的形状没有理由出现在这里', () => {
    for (const f of EMOJI_FACES) {
      expect(f.file, `${f.name} 的文件名`).toMatch(/^[0-9a-f]+\.svg$/);
    }
  });

  it('★ 每个名字都要能被 `[@黄脸/<名>]` 真的解析出来', () => {
    // 本文件最要紧的一条。段的字符集是**白名单**（\p{L}\p{N}+·-，且一个空白都不许有），
    // 名字里混进空格 / 斜杠 / 下划线就会**静默**退化成字面量：面板里点一下什么都不会
    // 发生，正文里也不出图，且没有任何报错。
    for (const f of EMOJI_FACES) {
      const re = new RegExp(STICKER_REF_RE.source, 'u');
      expect(re.test(`[@${EMOJI_COLLECTION}/${f.name}]`), `${f.name} 解析不出来`).toBe(true);
    }
  });

  it('查表：命中的给文件，查不到的给 undefined（由调用方决定退路）', () => {
    const first = EMOJI_FACES[0];
    expect(emojiFileFor(first.name)).toBe(first.file);
    expect(emojiFileFor('这个名字不在清单里')).toBeUndefined();
  });

  it('地址前缀与转义', () => {
    expect(emojiUrl('1f60a.svg')).toBe('/static/emoji/1f60a.svg');
  });

  it('面板列表：长度与顺序都跟清单一致，每项带 url', () => {
    const list = listEmojiFaces();
    expect(list).toHaveLength(EMOJI_FACES.length);
    expect(list.map((e) => e.name)).toEqual(EMOJI_FACES.map((f) => f.name));
    expect(list[0]).toEqual({ name: EMOJI_FACES[0].name, url: emojiUrl(EMOJI_FACES[0].file) });
  });
});
