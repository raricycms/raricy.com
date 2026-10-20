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
 * 桌面网格列数。手机上忽略 x/y，按**保存时的数组顺序**（数据库里的 `sort` 列）流式排
 * 两列 —— 顺序与桌面位置是两件事，理由见迁移 32 的头部。
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

/** 手机端把宽 2 的块压成两列；宽 1 保持一列。 */
export function mobileSpan(w: number): number {
  return Math.min(w, 2);
}
