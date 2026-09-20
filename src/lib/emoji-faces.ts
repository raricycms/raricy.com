// ─────────────────────────────────────────────────────────────────────────────
// emoji-faces.ts —— 内置「黄脸表情」合集的清单与地址
//
// 【它是什么】表情面板里那一栏黄脸。与站长放在 instance/stickers/ 的表情包**同一条
// 渲染管线**（token 语法一模一样，`[@黄脸/微笑]`），差别只有两点，都是刻意的：
//   · 尺寸是**文字大小**（1.2em），不是表情包的 4em —— 见 _markdown-body.scss；
//   · 点一下**进输入框**，不直接发送（讨论区也不例外）—— 见 StickerPicker 的 onPick。
//
// 【素材从哪来、为什么不入库】`@twemoji/svg` 这个 npm 包，由
// scripts/copy-emoji-assets.mjs 按本目录的 emoji-faces.json 拷出用到的那些到
// public/static/emoji/，postinstall 触发。与 public/static/vditor/ 、
// public/static/mathjax/ 完全同款：**npm 包的派生产物，不入库**（package-lock.json
// 已经钉住版本）。清单里没有任何第三方美术，所以那份 json 是入库的。
//
// 【许可 —— 别被包里那份 LICENSE 骗了】
// Twemoji 的**代码是 MIT、素材（图形）是 CC BY 4.0**，出处：
//   https://github.com/jdecked/twemoji 的 LICENSE 与 LICENSE-GRAPHICS
// ⚠️ 但 npm 包 @twemoji/svg 里那份 license 文件**只写了打包者自己的 MIT**
//    （Copyright (c) 2023 Samuel Kopp），**完全没有带素材的 CC BY 4.0**。
//    那是打包失误，署名义务不会因此消失 —— 所以复制脚本自己写一份正确的
//    LICENSE.txt 放进 public/static/emoji/，而不是照拷包里那份。
// CC BY 4.0 是**署名即可、无传染性**：站点无需因此改许可。Twemoji 官方对署名要求
// 极宽松（README 原话：接受 README / 关于页 / 页脚的一句提及，「HTML/JS 源码里提一句
// 也算」）—— 这个文件头与复制脚本的头注释就是按那条给的署名。
//
// 【为什么零依赖】sticker-refs.ts 是**浏览器侧**模块（见它的文件头），本文件被它
// 在客户端 import。所以这里不许引入 fs / prisma / 任何 Node 侧东西。
// ─────────────────────────────────────────────────────────────────────────────

import EMOJI_FACES_RAW from './emoji-faces.json';

/** 内置合集的 key —— 进 token（`[@黄脸/微笑]`），也**只**认这一个名字。 */
export const EMOJI_COLLECTION = '黄脸';

/**
 * tab 上显示的合集名。与 key 分开是为了不把显示名绑进 token：
 * 想改叫「黄脸表情」只动这里，用户手打过的 `[@黄脸/…]` 一个字都不用变。
 */
export const EMOJI_COLLECTION_TITLE = '黄脸表情';

/**
 * 素材地址前缀。落 `public/static/` 下由 Next 直接分发 —— 与站长表情走的
 * `/api/stickers/` 字节路由**不是一回事**：那条要读磁盘、按字节嗅探 MIME、
 * 还得防路径穿越；这边是构建期就固定好的静态文件，没有用户可控的路径成分。
 */
export const EMOJI_URL_PREFIX = '/static/emoji/';

/** 清单里的一项：`name` 是 token 里的那一段，`file` 是 @twemoji/svg 里的文件名。 */
export interface EmojiFace {
  name: string;
  file: string;
}

/** 面板里一格所需的最小形状 —— 与 /api/stickers 下发的 stickers[] 逐字同构。 */
export interface EmojiFaceEntry {
  name: string;
  url: string;
}

export const EMOJI_FACES: readonly EmojiFace[] = EMOJI_FACES_RAW;

/**
 * 名字 → 文件名。**命中不了就返回 undefined**，由调用方决定退路。
 *
 * 【为什么查表前要归一化】与 stickerKey 同一条纪律（见 sticker-refs.ts）：iOS / macOS
 * 键盘与部分输入法产出的是 NFD（分解形），而清单里写的是 NFC。不归一化的话
 * 「看起来一模一样但码点不同」→ 查不到 → **静默退回字面量**，用户只看到表情没出来。
 */
const FILE_BY_NAME = new Map<string, string>(
  EMOJI_FACES.map((f) => [f.name.normalize('NFC'), f.file])
);

export function emojiFileFor(name: string): string | undefined {
  return FILE_BY_NAME.get(name.normalize('NFC'));
}

/** 文件名 → 可直接塞进 `<img src>` 的地址。 */
export function emojiUrl(file: string): string {
  return `${EMOJI_URL_PREFIX}${encodeURIComponent(file)}`;
}

/**
 * 面板网格要的列表。
 *
 * 【为什么不用 Map 直接给 URL】面板要的是「顺序 + 两项形状」，而 Map 不保证顺序
 * 的表达意图。清单的**书写顺序就是面板里的显示顺序**（正面 → 中性 → 负面 → 特殊），
 * 想调顺序就直接调 json 里的行序，不用改代码。
 */
export function listEmojiFaces(): EmojiFaceEntry[] {
  return EMOJI_FACES.map((f) => ({ name: f.name, url: emojiUrl(f.file) }));
}
