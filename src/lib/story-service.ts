// ─────────────────────────────────────────────────────────────────────────────
// story-service.ts — 故事模块服务端读盘（忠实移植 Flask app/web/story/services.py）
//
// 磁盘结构（真实数据在 repo 根的 instance/stories/，可用 env STORIES_DIR 覆盖）：
//   • 顶层 = 若干「合集」文件夹，每个可含 info.json {title,description,author,
//     priority,ignore,ai_assisted}。
//   • 合集内可有 .md（markdown 故事）/ .cattca（互动小说）文件，以及子文件夹
//     （子合集，可多级嵌套）。
//   • 互动小说常见形态：子文件夹内放 content.cattca —— 按 Flask 逻辑，该子文件夹
//     被当作「合集」，其中 content.cattca 解析为一篇名为 "content" 的故事。
//     （即不特殊处理 content.* 文件名，纯粹沿用「目录=合集 / 文件=故事」的规则。）
//
// 与 Flask 对齐的关键点：
//   • get_collection：先 listdir 按小写名排序，再遍历；.md/.cattca → 故事条目，
//     子目录（排除 __pycache__）→ 合集条目；条目自身 ignore=true 则跳过。
//     最终 sort key = (priority, bool(description))，reverse=True（稳定排序，
//     故同优先级/同描述状态下保持名称升序）。
//   • get_story：path 拆成 parent/story_id，在 parent 目录里找 <story_id>.md
//     或 <story_id>.cattca；frontmatter 头解析 title/author/genre/ai_assisted；
//     ai_assisted 未在文章头声明时继承父合集设置。
//   • resolve：路径先当合集解析（目录存在且未 ignore），否则当故事解析，否则 404。
//
// 防御式设计（对齐任务要求，真实数据不得崩溃）：
//   • 所有 fs 读取 try/catch；缺目录、坏 JSON、坏 frontmatter、无权限 → 跳过/返回
//     notfound，绝不抛错。
//   • 路径穿越防护：拒绝空段、'.'、'..'、含分隔符或以绝对路径开头的段。
//   • 非 ASCII（中文）目录名按原样处理。
// ─────────────────────────────────────────────────────────────────────────────

import fs from 'node:fs';
import path from 'node:path';

// ── 数据形状 ────────────────────────────────────────────────────────────────

/** 合集内的子条目（故事或子合集）。 */
export interface CollectionChild {
  slug: string; // URL 段（文件名去扩展名 / 目录名）
  title: string;
  description: string;
  author: string;
  isCollection: boolean;
  priority: number;
  // 故事专属
  genre: string;
  aiAssisted: boolean;
  wordCount: number;
  // 合集专属
  itemCount: number;
}

export interface Breadcrumb {
  label: string;
  path: string; // 相对 /story 的路径（如 "active_story/fy"）
}

export interface CollectionResult {
  info: { title: string; description: string };
  children: CollectionChild[];
  breadcrumbs: Breadcrumb[];
}

export interface StoryResult {
  type: 'markdown' | 'cattca';
  title: string;
  author: string;
  genre: string;
  aiAssisted: boolean;
  wordCount: number;
  parentPath: string; // 父合集相对路径（面包屑 / 返回目录用）
  /** markdown：已渲染并去脚本的 HTML。 */
  contentHtml?: string;
  /** cattca / markdown 原文（cattca 交互引擎待实现，先原文展示）。 */
  contentRaw?: string;
}

export type ResolveResult =
  | { kind: 'collection'; data: CollectionResult }
  | { kind: 'markdown'; data: StoryResult }
  | { kind: 'cattca'; data: StoryResult }
  | { kind: 'notfound' };

// ── 根目录解析 ──────────────────────────────────────────────────────────────

/**
 * stories 根目录：优先 env STORIES_DIR；否则回退 `<cwd>/instance/stories`。
 * （cwd 即仓库根，process.cwd() 在 Next dev / start 下都等于仓库根。）
 */
function storiesRoot(): string {
  if (process.env.STORIES_DIR) return process.env.STORIES_DIR;
  const candidate = path.resolve(process.cwd(), 'instance', 'stories');
  try {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) return candidate;
  } catch {
    /* 忽略 */
  }
  return candidate;
}

// ── 基础工具 ────────────────────────────────────────────────────────────────

function isDirSafe(p: string): boolean {
  try {
    return fs.existsSync(p) && fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function isFileSafe(p: string): boolean {
  try {
    return fs.existsSync(p) && fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function readTextSafe(p: string): string | null {
  try {
    if (!isFileSafe(p)) return null;
    return fs.readFileSync(p, 'utf-8');
  } catch {
    return null;
  }
}

function readJsonSafe(p: string): Record<string, unknown> {
  try {
    if (!isFileSafe(p)) return {};
    return JSON.parse(fs.readFileSync(p, 'utf-8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function readdirSafe(p: string): string[] {
  try {
    return fs.readdirSync(p);
  } catch {
    return [];
  }
}

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}
function num(v: unknown, fallback = 0): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}
function bool(v: unknown): boolean {
  return v === true || v === 'true';
}

// ── frontmatter 解析（对齐 python-frontmatter 的常见用法，仅支持简单 key: value） ──

interface Parsed {
  meta: Record<string, unknown>;
  content: string;
}

/**
 * 解析 YAML frontmatter 块（--- ... ---）。真实文件里部分 .md 无头部（如 Life 精选集），
 * 部分有（如 Ein Paar），cattca 一般无头部。无头部 → meta 为空、content 为全文。
 * 仅解析平铺的 key: value（string / int / bool），足够覆盖 title/author/genre/
 * priority/ignore/description/ai_assisted。
 */
function parseFrontmatter(raw: string): Parsed {
  // 去 BOM
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!m) return { meta: {}, content: text };

  const meta: Record<string, unknown> = {};
  const block = m[1];
  for (const line of block.split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim();
    if (!key) continue;
    let val = line.slice(idx + 1).trim();
    // 去成对引号
    if (
      (val.startsWith('"') && val.endsWith('"') && val.length >= 2) ||
      (val.startsWith("'") && val.endsWith("'") && val.length >= 2)
    ) {
      val = val.slice(1, -1);
      meta[key] = val;
      continue;
    }
    if (val === 'true' || val === 'false') {
      meta[key] = val === 'true';
    } else if (/^-?\d+$/.test(val)) {
      meta[key] = parseInt(val, 10);
    } else if (/^-?\d+\.\d+$/.test(val)) {
      meta[key] = parseFloat(val);
    } else {
      meta[key] = val;
    }
  }
  return { meta, content: text.slice(m[0].length) };
}

/** 字数统计（移植 app/utils/markdown_countword.py 的 non_whitespace_characters）。 */
function countNonWhitespace(content: string): number {
  let c = content;
  c = c.replace(/```[\s\S]*?```/g, ''); // 代码块
  c = c.replace(/`[^`]*?`/g, ''); // 行内代码
  c = c.replace(/!\[.*?\]\(.*?\)/g, ''); // 图片
  c = c.replace(/\[(.*?)\]\(.*?\)/g, '$1'); // 链接保留文本
  c = c.replace(/<[^>]*?>/g, ''); // HTML 标签
  c = c.replace(/[*_~>`#\-\[\]()!]/g, ''); // markdown 特殊字符
  c = c.replace(/\s+/g, ' ').trim();
  return c.replace(/\s/g, '').length;
}

// ── 路径安全 ────────────────────────────────────────────────────────────────

/** 校验并规整路径段：拒绝穿越与非法段，返回安全段数组或 null。 */
function sanitizeParts(parts: string[]): string[] | null {
  const out: string[] = [];
  for (const raw of parts) {
    const seg = decodeSegment(raw);
    if (seg === null) return null;
    const trimmed = seg.replace(/\/+$/g, ''); // 去尾部斜杠（对齐 Flask rstrip('/')）
    if (trimmed === '') continue; // 跳过空段（如尾斜杠产生）
    if (
      trimmed === '.' ||
      trimmed === '..' ||
      trimmed.includes('/') ||
      trimmed.includes('\\') ||
      trimmed.includes('\0') ||
      path.isAbsolute(trimmed)
    ) {
      return null;
    }
    out.push(trimmed);
  }
  return out;
}

function decodeSegment(raw: string): string | null {
  try {
    return decodeURIComponent(raw);
  } catch {
    return null; // 非法百分号编码
  }
}

// ── 合集读取 ────────────────────────────────────────────────────────────────

/**
 * 读取给定路径的合集。空数组 = 根目录。目录不存在或 ignore=true → null。
 * 忠实移植 Flask StoryService.get_collection。
 */
export function getCollection(pathParts: string[]): CollectionResult | null {
  const safe = sanitizeParts(pathParts);
  if (safe === null) return null;

  const root = storiesRoot();
  const collDir = safe.length ? path.join(root, ...safe) : root;
  if (!isDirSafe(collDir)) return null;

  const info = readJsonSafe(path.join(collDir, 'info.json'));
  if (bool(info['ignore'])) return null;

  const fallbackAuthor = str(info['author'], '未知作者');
  const fallbackAi = bool(info['ai_assisted']);
  const displayTitle = str(info['title']) || (safe.length ? safe[safe.length - 1] : '故事');
  const description = str(info['description']);

  const children: CollectionChild[] = [];
  // 先按小写名排序（对齐 Flask，保证稳定排序的名称升序基线）
  const entries = readdirSafe(collDir).sort((a, b) =>
    a.toLowerCase() < b.toLowerCase() ? -1 : a.toLowerCase() > b.toLowerCase() ? 1 : 0,
  );

  for (const name of entries) {
    const full = path.join(collDir, name);

    if (name.endsWith('.md') || name.endsWith('.cattca')) {
      if (!isFileSafe(full)) continue;
      const slug = name.endsWith('.md') ? name.slice(0, -3) : name.slice(0, -7);
      const child = buildStoryChild(full, slug, fallbackAuthor, fallbackAi);
      if (child) children.push(child);
    } else if (name !== '__pycache__' && isDirSafe(full)) {
      const subInfo = readJsonSafe(path.join(full, 'info.json'));
      if (bool(subInfo['ignore'])) continue;
      children.push({
        slug: name,
        title: str(subInfo['title'], name),
        description: str(subInfo['description']),
        author: str(subInfo['author'], fallbackAuthor),
        isCollection: true,
        priority: num(subInfo['priority']),
        genre: '',
        aiAssisted: false,
        wordCount: 0,
        itemCount: countItems(full),
      });
    }
  }

  // 稳定排序：priority desc，再 hasDescription desc（对齐 Flask reverse=True 双键）
  children.sort((a, b) => {
    if (a.priority !== b.priority) return b.priority - a.priority;
    const ad = a.description ? 1 : 0;
    const bd = b.description ? 1 : 0;
    return bd - ad;
  });

  return {
    info: { title: displayTitle, description },
    children,
    breadcrumbs: buildBreadcrumbs(safe),
  };
}

function buildStoryChild(
  filePath: string,
  slug: string,
  fallbackAuthor: string,
  fallbackAi: boolean,
): CollectionChild | null {
  const raw = readTextSafe(filePath);
  if (raw === null) return null;
  let meta: Record<string, unknown>;
  try {
    meta = parseFrontmatter(raw).meta;
  } catch {
    return null;
  }
  if (bool(meta['ignore'])) return null;
  const aiAssisted = 'ai_assisted' in meta ? bool(meta['ai_assisted']) : fallbackAi;
  return {
    slug,
    title: str(meta['title'], slug),
    description: str(meta['description']),
    author: str(meta['author'], fallbackAuthor),
    isCollection: false,
    priority: num(meta['priority']),
    genre: str(meta['genre']),
    aiAssisted,
    wordCount: countNonWhitespace(raw),
    itemCount: 0,
  };
}

/** 统计目录内条目数（.md/.cattca 文件 + 子目录，排除 __pycache__），对齐 Flask _count_items。 */
function countItems(dir: string): number {
  let count = 0;
  for (const name of readdirSafe(dir)) {
    if (name.endsWith('.md') || name.endsWith('.cattca')) {
      count += 1;
    } else if (name !== '__pycache__' && isDirSafe(path.join(dir, name))) {
      count += 1;
    }
  }
  return count;
}

function buildBreadcrumbs(parts: string[]): Breadcrumb[] {
  const crumbs: Breadcrumb[] = [];
  for (let i = 0; i < parts.length; i++) {
    crumbs.push({ label: parts[i], path: parts.slice(0, i + 1).join('/') });
  }
  return crumbs;
}

// ── 故事读取 ────────────────────────────────────────────────────────────────

/**
 * 读取单篇故事。忠实移植 Flask StoryService.get_story：path 拆 parent/story_id，
 * 在 parent 目录里找 <story_id>.md 或 <story_id>.cattca。找不到 → null。
 * markdown 走 renderMarkdown；cattca 返回原文。
 */
export function getStory(pathParts: string[]): StoryResult | null {
  const safe = sanitizeParts(pathParts);
  if (safe === null || safe.length === 0) return null;

  const storyId = safe[safe.length - 1];
  const parentParts = safe.slice(0, -1);
  const parentPath = parentParts.join('/');

  const root = storiesRoot();
  const parentDir = parentParts.length ? path.join(root, ...parentParts) : root;
  if (!isDirSafe(parentDir)) return null;

  const parentInfo = readJsonSafe(path.join(parentDir, 'info.json'));
  const fallbackAuthor = str(parentInfo['author'], '未知作者');
  const fallbackAi = bool(parentInfo['ai_assisted']);

  const resolveAi = (meta: Record<string, unknown>): boolean =>
    'ai_assisted' in meta ? bool(meta['ai_assisted']) : fallbackAi;

  // 先 markdown
  const mdPath = path.join(parentDir, `${storyId}.md`);
  if (isFileSafe(mdPath)) {
    const raw = readTextSafe(mdPath);
    if (raw === null) return null;
    let parsed: Parsed;
    try {
      parsed = parseFrontmatter(raw);
    } catch {
      return null;
    }
    const meta = parsed.meta;
    return {
      type: 'markdown',
      title: str(meta['title'], storyId),
      author: str(meta['author'], fallbackAuthor),
      genre: str(meta['genre']),
      aiAssisted: resolveAi(meta),
      wordCount: countNonWhitespace(raw),
      parentPath,
      contentHtml: renderMarkdown(parsed.content),
      contentRaw: parsed.content,
    };
  }

  // 再 cattca
  const cattcaPath = path.join(parentDir, `${storyId}.cattca`);
  if (isFileSafe(cattcaPath)) {
    const raw = readTextSafe(cattcaPath);
    if (raw === null) return null;
    let parsed: Parsed;
    try {
      parsed = parseFrontmatter(raw);
    } catch {
      return null;
    }
    const meta = parsed.meta;
    return {
      type: 'cattca',
      title: str(meta['title'], storyId),
      author: str(meta['author'], fallbackAuthor),
      genre: str(meta['genre']),
      aiAssisted: resolveAi(meta),
      wordCount: countNonWhitespace(raw),
      parentPath,
      contentRaw: parsed.content,
    };
  }

  return null;
}

// ── 统一入口 ────────────────────────────────────────────────────────────────

/**
 * 解析任意路径：先当合集，否则当故事，否则 notfound。
 * 对齐 Flask views.resolve_path（合集优先）。空数组 = 根合集。
 */
export function resolvePath(pathParts: string[]): ResolveResult {
  const safe = sanitizeParts(pathParts);
  if (safe === null) return { kind: 'notfound' };

  const collection = getCollection(safe);
  if (collection !== null) return { kind: 'collection', data: collection };

  const story = getStory(safe);
  if (story !== null) {
    return story.type === 'markdown'
      ? { kind: 'markdown', data: story }
      : { kind: 'cattca', data: story };
  }

  return { kind: 'notfound' };
}

// ── markdown 渲染（服务端，对齐 Flask 服务端渲染 + 去脚本） ──────────────────

import { marked } from 'marked';

function renderMarkdown(content: string): string {
  try {
    marked.setOptions({ gfm: true, breaks: true });
    const html = marked.parse(content, { async: false }) as string;
    return stripScripts(html);
  } catch {
    // 渲染失败兜底为转义预格式化，绝不抛错。
    return `<pre style="white-space:pre-wrap;word-break:break-word">${escapeHtml(content)}</pre>`;
  }
}

function stripScripts(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<script\b[^>]*>/gi, '');
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ── 兼容导出：sitemap.ts 仍用 listStories().items[].id（仅根层，保持旧行为） ──

/** @deprecated 迁移期兼容：返回根合集的直接子项（供 sitemap 使用）。 */
export function listStories(): { title: string; description: string; items: { id: string }[] } {
  const coll = getCollection([]);
  if (!coll) return { title: '故事集', description: '', items: [] };
  return {
    title: coll.info.title,
    description: coll.info.description,
    items: coll.children.map((c) => ({ id: c.slug })),
  };
}
