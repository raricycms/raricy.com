// ─────────────────────────────────────────────────────────────────────────────
// profile-blocks.ts —— 个人主页「积木」的词汇表与校验（零依赖）
//
// 【为什么零依赖】编辑器是客户端组件（拖拽/缩放都在浏览器里跑），而服务端校验
// 必须与它用**同一份规则**。任何 import prisma / fs 都会让客户端包炸掉，所以这里
// 只允许纯函数 + safe-url（那也是零依赖的）。
//
// 【它管四件事】
//   1. 白名单：允许哪些块（BLOCK_KINDS）、每块允许哪些尺寸
//   2. 形状校验：config 的规范化（normalizeConfig）与整页校验（normalizeBlocks）
//   3. 网格算术：重叠判定、找空位（编辑器与保存校验共用）
//   4. 渲染契约：BlockView —— 服务端解析好的「可渲染数据」，客户端只负责画
//
// 【为什么存指针不存快照】config 里只有 blogId / imageId / audioId。渲染时按当前
// 库里那几行重新解析：目标被删、档位降回 internal、作者归档 → 整块不渲染。把标题
// 或正文抄进 config 会出现「文章已经改成私有、名片上还挂着它」的洞，且那个洞
// 永远不会有报错。
// ─────────────────────────────────────────────────────────────────────────────

import { safeExternalReturnUrl } from './safe-url';

/**
 * 桌面网格列数。手机上是**同一份坐标的投影**（见下面的 projectMobile）：2 列由桌面
 * 左右两半折成，宽 ≥2 的块通栏；不再有独立的手机顺序（迁移 32 的 `sort` 列已失效，
 * 只保留旧值，读写都不再依赖）。
 */
export const GRID_COLUMNS = 4;
/** 一页最多几块。超过就拒绝保存 —— 防「每块一次查询」被堆成慢查询。 */
export const MAX_BLOCKS = 16;
export const MAX_TEXT_LENGTH = 200;
export const MAX_TEXT_TITLE = 24;
export const MAX_CAPTION = 40;
export const MAX_LINK_LABEL = 24;
export const MAX_Y = 200;

export type BlockKind = 'blog' | 'image' | 'audio' | 'text' | 'link' | 'stats' | 'checkin';

export interface BlockSize {
  w: number;
  h: number;
  label: string;
  hint: string;
}

/**
 * 尺寸只开放四档。理由：每个块都得在每一档下好看，自由像素 resize 等于要设计并
 * 测试无限种版式；四档已经足够「好玩」，而且手机上能直接映射（2×2 压通栏）。
 */
export const BLOCK_SIZES: readonly BlockSize[] = [
  { w: 1, h: 1, label: '小', hint: '一格' },
  { w: 2, h: 1, label: '宽', hint: '横两格' },
  { w: 1, h: 2, label: '高', hint: '竖两格' },
  { w: 2, h: 2, label: '大', hint: '四个格' },
];

export interface BlockDef {
  kind: BlockKind;
  /** 面板上的名字。 */
  label: string;
  /** 面板上的一句话说明（产品文案只写必要信息，不写抒情句）。 */
  hint: string;
  /** 默认尺寸；添加时用它找空位。 */
  defaultSize: { w: number; h: number };
  /** 需要挑一个已有对象（文章 / 图片 / 音频）才能创建。 */
  picker: 'blog' | 'image' | 'audio' | null;
  /** 没有可挑的对象时给用户的行动提示。 */
  emptyHint: string;
}

export const BLOCK_DEFS: Record<BlockKind, BlockDef> = {
  blog: {
    kind: 'blog',
    label: '文章',
    hint: '挑一篇已公开或凭链接可读的文章',
    defaultSize: { w: 2, h: 1 },
    picker: 'blog',
    emptyHint: '还没有对外可读的文章。去文章编辑器把某篇的可见性改成「凭链接可读」或「公开」。',
  },
  image: {
    kind: 'image',
    label: '图片',
    hint: '从图床挑一张公开的图',
    defaultSize: { w: 1, h: 1 },
    picker: 'image',
    emptyHint: '图床里还没有公开的图片。',
  },
  audio: {
    kind: 'audio',
    label: '音频',
    hint: '从音频床挑一段公开的录音',
    defaultSize: { w: 2, h: 1 },
    picker: 'audio',
    emptyHint: '音频床里还没有公开的录音。',
  },
  text: {
    kind: 'text',
    label: '文字',
    hint: '一句话、一段介绍，纯文本',
    defaultSize: { w: 2, h: 1 },
    picker: null,
    emptyHint: '',
  },
  link: {
    kind: 'link',
    label: '链接',
    hint: '一个站外地址（只收 http / https）',
    defaultSize: { w: 1, h: 1 },
    picker: null,
    emptyHint: '',
  },
  stats: {
    kind: 'stats',
    label: '统计',
    hint: '公开文章数、获赞数、签到天数',
    defaultSize: { w: 2, h: 1 },
    picker: null,
    emptyHint: '',
  },
  checkin: {
    kind: 'checkin',
    label: '签到',
    hint: '累计签到天数',
    defaultSize: { w: 1, h: 1 },
    picker: null,
    emptyHint: '',
  },
};

export const BLOCK_KINDS = Object.keys(BLOCK_DEFS) as BlockKind[];

export function isBlockKind(v: unknown): v is BlockKind {
  return typeof v === 'string' && (BLOCK_KINDS as string[]).includes(v);
}

/** 12 位短 id（与 short-id.ts 的字符集一致；这里只做形状校验）。 */
const BLOCK_ID_RE = /^[a-z0-9]{8,32}$/;

export function isBlockId(v: unknown): v is string {
  return typeof v === 'string' && BLOCK_ID_RE.test(v);
}

/** 单行文本：控制字符换空格、压缩空白、截断。 */
export function sanitizeInline(v: unknown, max: number): string {
  if (typeof v !== 'string') return '';
  return v
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

/**
 * 多行文本：保留换行，其余控制字符剥掉，连续空行压成一段。
 * ⚠️ 这里**只做文本**，不做 Markdown / HTML —— 主页的正文是纯文本 React 子节点，
 *    与 bio 同一条口径。想放富文本是另一件事，不要顺手把博客管线接上来。
 */
export function sanitizeText(v: unknown, max: number): string {
  if (typeof v !== 'string') return '';
  return v
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, max);
}

export interface StoredBlock {
  id: string;
  kind: BlockKind;
  x: number;
  y: number;
  w: number;
  h: number;
  config: Record<string, unknown>;
}

/** 块渲染所需的数据，由服务端按当前库解析好。客户端只画，不再查库、不再判权限。 */
export type BlockView =
  | {
      kind: 'blog';
      blogId: string;
      title: string;
      description: string;
      /**
       * 正文的**纯文本**摘要（服务端按当前正文现算，只给高卡片 h≥2 用）。空串 =
       * 不显示。它不是原文快照：正文改了下次请求就跟着变，与「存指针不存快照」同一条口径。
       */
      excerpt: string;
      /** 已经按站内钟面格式化好的日期（yyyy-mm-dd）。客户端不再做时间换算。 */
      date: string | null;
    }
  | { kind: 'image'; imageId: string; url: string; alt: string; caption: string }
  | { kind: 'audio'; audioId: string; url: string; title: string }
  | { kind: 'text'; title: string; text: string }
  | { kind: 'link'; label: string; url: string }
  | { kind: 'stats'; blogs: number; likes: number; checkins: number }
  | { kind: 'checkin'; days: number };

/** 页面拿到的一块：位置尺寸 + 原始 config（编辑用）+ 解析后的 view（渲染用）。 */
export interface ProfileBlock extends StoredBlock {
  /** null = 目标已不可对外展示（被删 / 降档 / 归档）。访客视图整块不渲染。 */
  view: BlockView | null;
}

export interface CatalogBlog {
  id: string;
  title: string;
  visibility: string;
  createdAt: string | null;
}
export interface CatalogImage {
  id: string;
  url: string;
  filename: string;
}
export interface CatalogAudio {
  id: string;
  url: string;
  filename: string;
}

/** 编辑器的「可挑清单」：只列**已经对外可读**的对象。 */
export interface BlockCatalog {
  blogs: CatalogBlog[];
  images: CatalogImage[];
  audios: CatalogAudio[];
  /**
   * 统计块的当前值。**新加的统计 / 签到块要立刻显示真数**，否则编辑器里会先画成
   * 「还没填内容」（那时它没有任何 config 可填），用户会以为这块坏了。
   */
  stats: { blogs: number; likes: number; checkins: number };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * 按块类型规范化 config。返回 null = 这块的内容不合法（调用方决定是丢弃还是报错）。
 * ⚠️ 每加一类块，这里必须加一支 —— 漏了就是「保存成功、刷新后块消失」。
 */
export function normalizeConfig(
  kind: BlockKind,
  raw: unknown
): Record<string, unknown> | null {
  const c = isPlainObject(raw) ? raw : {};
  switch (kind) {
    case 'blog': {
      const blogId = typeof c.blogId === 'string' ? c.blogId : '';
      return blogId ? { blogId } : null;
    }
    case 'image': {
      const imageId = typeof c.imageId === 'string' ? c.imageId : '';
      if (!imageId) return null;
      return { imageId, caption: sanitizeInline(c.caption, MAX_CAPTION) };
    }
    case 'audio': {
      const audioId = typeof c.audioId === 'string' ? c.audioId : '';
      if (!audioId) return null;
      return { audioId, title: sanitizeInline(c.title, MAX_TEXT_TITLE) };
    }
    case 'text': {
      const text = sanitizeText(c.text, MAX_TEXT_LENGTH);
      if (!text) return null;
      return { title: sanitizeInline(c.title, MAX_TEXT_TITLE), text };
    }
    case 'link': {
      // 只收 http(s)、禁凭据、长度上限 —— 与收银台「回到商户」同一条判据。
      const url = safeExternalReturnUrl(typeof c.url === 'string' ? c.url : '');
      if (!url) return null;
      let host = url;
      try {
        host = new URL(url).hostname.replace(/^www\./, '');
      } catch {
        /* 上面已经解析过，走不到这里 */
      }
      return { url, label: sanitizeInline(c.label, MAX_LINK_LABEL) || host };
    }
    case 'stats':
    case 'checkin':
      return {};
  }
}

export function rectsOverlap(
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number }
): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/** 从 (0,0) 起按行扫描，找第一个能放下 w×h 且不与他人重叠的位置。 */
export function findFreeSpot(
  blocks: readonly { x: number; y: number; w: number; h: number }[],
  w: number,
  h: number
): { x: number; y: number } {
  const maxY = blocks.reduce((m, b) => Math.max(m, b.y + b.h), 0);
  for (let y = 0; y <= maxY; y++) {
    for (let x = 0; x + w <= GRID_COLUMNS; x++) {
      const candidate = { x, y, w, h };
      if (!blocks.some((b) => rectsOverlap(candidate, b))) return { x, y };
    }
  }
  return { x: 0, y: maxY };
}

export function sizeKey(w: number, h: number): string {
  return `${w}x${h}`;
}

function sizeAllowed(w: number, h: number): boolean {
  return BLOCK_SIZES.some((s) => s.w === w && s.h === h);
}

export type NormalizeResult =
  | { ok: true; blocks: StoredBlock[] }
  | { ok: false; message: string };

/**
 * 整页校验。**服务端与客户端共用**：客户端拿它做「保存前自检」，服务端拿它做
 * 最后一道闸（客户端校验永远只是体验，不是防线）。
 *
 * 任何一块不合法 → 整页拒绝，并指出第几块。不要「跳过坏的、保存好的」：
 * 用户会看到「明明拖好了，保存后少了一块」。
 */
export function normalizeBlocks(raw: unknown): NormalizeResult {
  if (!Array.isArray(raw)) return { ok: false, message: '积木数据格式错误' };
  if (raw.length > MAX_BLOCKS) return { ok: false, message: `一页最多放 ${MAX_BLOCKS} 块` };

  const seen = new Set<string>();
  const blocks: StoredBlock[] = [];

  for (let i = 0; i < raw.length; i++) {
    const item = raw[i];
    if (!isPlainObject(item)) return { ok: false, message: `第 ${i + 1} 块格式错误` };
    const kind = item.kind;
    if (!isBlockKind(kind)) return { ok: false, message: `第 ${i + 1} 块类型不支持` };

    const w = Number(item.w);
    const h = Number(item.h);
    if (!sizeAllowed(w, h)) return { ok: false, message: `第 ${i + 1} 块的尺寸不支持` };

    const x = Number(item.x);
    const y = Number(item.y);
    if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || y > MAX_Y) {
      return { ok: false, message: `第 ${i + 1} 块的位置不合法` };
    }
    if (x + w > GRID_COLUMNS) return { ok: false, message: `第 ${i + 1} 块超出右边界` };

    const config = normalizeConfig(kind, item.config);
    if (!config) return { ok: false, message: `第 ${i + 1} 块的内容不完整` };

    const id = isBlockId(item.id) ? item.id : '';
    if (id) {
      if (seen.has(id)) return { ok: false, message: `第 ${i + 1} 块的 id 重复` };
      seen.add(id);
    }

    blocks.push({ id, kind, x, y, w, h, config });
  }

  // 重叠判定放在最后：上面任何一条失败都先报具体原因。
  for (let i = 0; i < blocks.length; i++) {
    for (let j = i + 1; j < blocks.length; j++) {
      if (rectsOverlap(blocks[i], blocks[j])) {
        return { ok: false, message: `第 ${i + 1} 块与第 ${j + 1} 块重叠了` };
      }
    }
  }

  return { ok: true, blocks };
}

// ── 手机两列的投影 ────────────────────────────────────────────────────────────
//
// 【两端是同一份坐标，不是两套布局（2026-10 改版）】桌面 4 列是唯一真相；手机 2 列
// 由它**投影**出来：
//   · 宽 ≥2 的块（2×1 / 2×2）→ 手机上通栏。所以「2×1 摆在桌面第 2–3 列」这种跨中线
//     的摆法不需要特殊处理：只要宽度够，它在手机上就是通栏。
//   · 宽 1 的块 → 看它落在桌面哪一半：x < 2（第 1–2 列）进手机左列，x ≥ 2（第 3–4 列）
//     进右列。这就是「4 列与 2 列怎么对齐」的答案：**两列桌面 = 一列手机**。
//   · 竖直方向按桌面阅读顺序（先 y 后 x）从上往下紧排。桌面上刻意留的空行在手机上
//     不保留 —— 手机屏幕窄，空一整行是纯浪费；投影只关心**顺序**，不关心桌面的空位。
//
// 【为什么投影要算出来、而不是交给 CSS grid-auto-flow】手机上的位置还要给拖拽 / 左右
// 移动 / 网格线用；CSS 自己流出来的位置 JS 读不到。投影是一次纯函数计算，两处共用同
// 一个结果，也就不会出现「画在 A、点击落在 B」。
//
// 【为什么可以「填洞」】按阅读顺序从上往下找第一个放得下的行，于是后面一个窄块可能
// 补进前面宽块上方留出的空列里。这与 CSS 的 dense 排布效果一致，但**顺序由这里唯一
// 决定**，不是浏览器行为；测试钉的就是这个纯函数。

export const MOBILE_COLUMNS = 2;
/** 桌面 4 列按左右分成两半：x < 2 是左半，x ≥ 2 是右半。 */
export const MOBILE_HALF = GRID_COLUMNS / 2;

export interface MobileRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 一块在手机两列里的列归属与宽度。宽 ≥2 通栏；宽 1 按左右半归列。 */
export function mobileColumn(b: { x: number; w: number }): { x: number; w: number } {
  const w = Math.min(b.w, MOBILE_COLUMNS);
  if (w === MOBILE_COLUMNS) return { x: 0, w };
  return { x: b.x < MOBILE_HALF ? 0 : 1, w };
}

/**
 * 把整页投影到手机两列。返回**与输入同序**的坐标数组（调用方按 id 建 map）。
 *
 * 排序键 = 桌面阅读顺序 (y, x) + 输入下标兜底；每块从第 0 行往下找第一个放得下的
 * 位置（所以会填上面的洞），放置后把占用的格子登记进 occupy 集合。
 */
export function projectMobile<T extends { x: number; y: number; w: number; h: number }>(
  blocks: readonly T[]
): MobileRect[] {
  const order = blocks
    .map((b, i) => ({ b, i }))
    .sort((a, b) => a.b.y - b.b.y || a.b.x - b.b.x || a.i - b.i);

  const occupied = new Set<string>();
  const fits = (x: number, w: number, y: number, h: number): boolean => {
    for (let dx = 0; dx < w; dx++) {
      for (let dy = 0; dy < h; dy++) {
        if (occupied.has(`${x + dx},${y + dy}`)) return false;
      }
    }
    return true;
  };

  const out: MobileRect[] = new Array(blocks.length);
  for (const { b, i } of order) {
    const col = mobileColumn(b);
    let y = 0;
    while (!fits(col.x, col.w, y, b.h)) y++;
    for (let dx = 0; dx < col.w; dx++) {
      for (let dy = 0; dy < b.h; dy++) occupied.add(`${col.x + dx},${y + dy}`);
    }
    out[i] = { x: col.x, y, w: col.w, h: b.h };
  }
  return out;
}

/**
 * 手机视图里的顺序（投影后的行优先序），返回 id。
 * 用于 DOM 顺序 / 读屏顺序；**上下移动**用的是 mobileNeighbors（同列内换位），别拿它
 * 当「上一块 / 下一块」—— 两列并排时行优先序会让同一行的右列块排在左列下一行之前。
 */
export function mobileOrder(
  blocks: readonly ({ id: string } & { x: number; y: number; w: number; h: number })[]
): string[] {
  const projected = projectMobile(blocks);
  return blocks
    .map((b, i) => ({ id: b.id, x: projected[i].x, y: projected[i].y, i }))
    .sort((a, b) => a.y - b.y || a.x - b.x || a.i - b.i)
    .map((b) => b.id);
}

/**
 * 手机端选中块的上下邻居：**同列（或同样通栏）里按 y 排序的前一块 / 后一块**。
 *
 * 【为什么按列找、而不是按行优先序找】两列并排时，「上移」如果拿行优先序的上一块，
 * 会和另一列的那块交换坐标 —— 那一列也跟着跳，用户看到的是「我移它，隔壁却跑了」。
 * 同列内换位才是手机上「上移一行」的直觉；宽块之间按通栏对通栏换。
 */
export function mobileNeighbors(
  blocks: readonly ({ id: string } & { x: number; y: number; w: number; h: number })[],
  id: string
): { prev: string | null; next: string | null } {
  const projected = projectMobile(blocks);
  const index = blocks.findIndex((b) => b.id === id);
  if (index < 0) return { prev: null, next: null };
  const me = projected[index];

  const sameColumn = blocks
    .map((b, i) => ({ id: b.id, p: projected[i], i }))
    .filter((e) => e.p.x === me.x && e.p.w === me.w)
    .sort((a, b) => a.p.y - b.p.y || a.i - b.i);

  const at = sameColumn.findIndex((e) => e.id === id);
  return {
    prev: at > 0 ? sameColumn[at - 1].id : null,
    next: at >= 0 && at < sameColumn.length - 1 ? sameColumn[at + 1].id : null,
  };
}

function hasOverlap(blocks: readonly { x: number; y: number; w: number; h: number }[]): boolean {
  for (let i = 0; i < blocks.length; i++) {
    for (let j = i + 1; j < blocks.length; j++) {
      if (rectsOverlap(blocks[i], blocks[j])) return true;
    }
  }
  return false;
}

/**
 * 交换两块**位置**（尺寸不动）。换完与第三块重叠就返回 null —— 调用方什么都不做，
 * 别自作主张找空位：手机上拖到哪一块头上，用户期待的是「两块换位」，不是「随机弹开」。
 */
export function swapBlockPositions<T extends { id: string; x: number; y: number; w: number; h: number }>(
  blocks: readonly T[],
  idA: string,
  idB: string
): T[] | null {
  if (idA === idB) return null;
  const a = blocks.find((b) => b.id === idA);
  const b = blocks.find((x) => x.id === idB);
  if (!a || !b) return null;
  const next = blocks.map((it) =>
    it.id === idA ? { ...it, x: b.x, y: b.y } : it.id === idB ? { ...it, x: a.x, y: a.y } : it
  );
  return hasOverlap(next) ? null : next;
}

/**
 * 手机端「左右移动」：1 宽的块换到另一半（左半 ↔ 右半）；宽 ≥2 的块通栏，没有左右
 * 可言，返回 null（调用方把按钮置灰）。
 *
 * 目标格被别人占着时先尝试与那一块换位；换位不成立（尺寸不同又压到第三块）就在目标
 * 半区里找第一个放得下的位置 —— 宁可上下挪一格，也不要「按了没反应」。
 */
export function moveToOtherHalf<T extends { id: string; x: number; y: number; w: number; h: number }>(
  blocks: readonly T[],
  id: string
): T[] | null {
  const me = blocks.find((b) => b.id === id);
  if (!me || me.w !== 1) return null;

  const targetX = me.x < MOBILE_HALF ? me.x + MOBILE_HALF : me.x - MOBILE_HALF;
  const others = blocks.filter((b) => b.id !== id);
  const target = { ...me, x: targetX };
  if (!others.some((o) => rectsOverlap(target, o))) {
    return blocks.map((b) => (b.id === id ? target : b));
  }

  // 目标格被占：先换位（两块交换位置，最常见也最符合直觉）
  const blocker = others.find((o) => rectsOverlap(target, o));
  if (blocker) {
    const swapped = swapBlockPositions(blocks, id, blocker.id);
    if (swapped) return swapped;
  }

  // 再退一步：在目标半区里找空位。半区只有两列，两列都扫。
  const halfStart = targetX < MOBILE_HALF ? 0 : MOBILE_HALF;
  const maxY = blocks.reduce((m, b) => Math.max(m, b.y + b.h), 0);
  for (let y = 0; y <= maxY; y++) {
    for (let x = halfStart; x + me.w <= halfStart + MOBILE_HALF; x++) {
      const candidate = { x, y, w: me.w, h: me.h };
      if (!others.some((o) => rectsOverlap(candidate, o))) {
        return blocks.map((b) => (b.id === id ? { ...b, x: candidate.x, y: candidate.y } : b));
      }
    }
  }
  return null;
}

/**
 * 手机端「上移 / 下移」：与**同列**的上一块 / 下一块换位（见 mobileNeighbors）。
 * 换位改变的是桌面坐标 —— 两端是同一份布局，这是刻意的；不同列之间不换，所以不会
 * 出现「移这块、隔壁那块也跟着跳列」。
 */
export function moveInMobileOrder<T extends { id: string; x: number; y: number; w: number; h: number }>(
  blocks: readonly T[],
  id: string,
  dir: -1 | 1
): T[] | null {
  const { prev, next } = mobileNeighbors(blocks, id);
  const target = dir < 0 ? prev : next;
  if (!target) return null;
  return swapBlockPositions(blocks, id, target);
}
