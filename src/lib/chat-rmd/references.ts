// ─────────────────────────────────────────────────────────────────────────────
// chat-rmd/references.ts — 聊天 AST 引用适配（M0 冻结入口）
//
// 唯一出口：adaptChatReferences(document, context)。输入是已通过聊天文档策略的
// LocalDocument，输出不可变副本、按出现位置编号的 hostData，以及裸图候选槽位。
//
// 规则与限额沿用旧聊天管线与零依赖引用模块：
//   · 10 位图床 / 8 位剪贴板 / 9 位投票 / 6 位收藏夹（后两者刻意保留字面量）
//   · 音频、表情（含内置黄脸）、名片的命名空间与上限来自 audio-refs / sticker-refs /
//     user-refs；正则原样复用，不放宽任何空白匹配
//   · 只在 text 节点识别；link、code、inlineCode、fallback 与非 Markdown 容器子树整段跳过
//   · 预算由 context.budget 给出；子剪贴板共享父消息的同一份计数器
//   · 取数只走 reference-reader（同源 cookie 鉴权），同一次适配内按资源去重，
//     并发 ≤ MAX_REF_CONCURRENCY，受 context.signal 取消
//   · 剪贴板正文交给 context.compileChild 独立编译；子剪贴板不再递归展开
//
// 输入文档不被修改；节点 attrs 只放 slot，字符 / URL / 用户资料都只存在于 hostData。
// ─────────────────────────────────────────────────────────────────────────────

import type { LocalDocument, LocalNode } from 'reactive-md';
import { AUDIO_REF_RE, audioUrl } from '../audio-refs';
import { avatarUrl } from '../avatar-refs';
import type { ContentFormat } from '../content-format';
import {
  CLIPBOARD_REF_PROBE,
  CLIP_EXPAND_MAX,
  IMAGE_REF_RE,
  MAX_REF_CONCURRENCY,
  createConcurrencyLimiter,
} from '../content-refs';
import { EMOJI_COLLECTION, emojiFileFor, emojiUrl } from '../emoji-faces';
import { STICKER_REF_RE, stickerUrl } from '../sticker-refs';
import { USER_REF_RE } from '../user-refs';
import {
  createChatReferenceReader,
  type ChatClipboardRead,
  type ChatReferenceReader,
  type ChatUserCard,
  type ChatUserCardRead,
} from './reference-reader';
import {
  CHAT_REFERENCE_BUDGET,
  CHAT_REF_HOST_TAG,
  CHAT_REF_SLOT_ATTR,
  chatRefSlot,
  type ChatClipboardHostData,
  type ChatHostData,
  type ChatHostDataMap,
} from './reference-types';
import type {
  ChatReferenceBudget,
  ChatReferenceContext,
  ChatReferenceDocument,
} from './types';

// ── 扫描：只在最终可见的 text 节点里找 token ─────────────────────────────────

type RefMatch =
  | { kind: 'image'; id: string; token: string; start: number; end: number }
  | { kind: 'audio'; id: string; token: string; start: number; end: number }
  | { kind: 'sticker'; collection: string; name: string; token: string; start: number; end: number }
  | { kind: 'user'; name: string; token: string; start: number; end: number }
  | { kind: 'clipboard'; id: string; token: string; start: number; end: number };

/**
 * 允许继续向下扫描的容器。刻意不含 link（整棵子树跳过）、code / inlineCode /
 * fallback（叶子）以及原生 HTML 容器 —— 文档策略拒绝的结构不参与引用识别。
 */
const CONTAINER_TYPES = new Set([
  'paragraph',
  'heading',
  'strong',
  'emphasis',
  'delete',
  'underline',
  'list',
  'listItem',
  'blockquote',
  'table',
  'tableBody',
  'tableRow',
  'tableCell',
]);

interface ScannedText {
  node: LocalNode;
  matches: RefMatch[];
}

function collectMatches(value: string): RefMatch[] {
  const matches: RefMatch[] = [];

  for (const m of value.matchAll(new RegExp(IMAGE_REF_RE.source, 'g'))) {
    const start = m.index ?? 0;
    matches.push({ kind: 'image', id: m[1], token: m[0], start, end: start + m[0].length });
  }
  for (const m of value.matchAll(new RegExp(CLIPBOARD_REF_PROBE.source, 'g'))) {
    const start = m.index ?? 0;
    matches.push({ kind: 'clipboard', id: m[1], token: m[0], start, end: start + m[0].length });
  }
  for (const m of value.matchAll(new RegExp(AUDIO_REF_RE.source, 'g'))) {
    const start = m.index ?? 0;
    matches.push({ kind: 'audio', id: m[1], token: m[0], start, end: start + m[0].length });
  }
  for (const m of value.matchAll(new RegExp(USER_REF_RE.source, 'gu'))) {
    const start = m.index ?? 0;
    matches.push({ kind: 'user', name: m[1], token: m[0], start, end: start + m[0].length });
  }
  for (const m of value.matchAll(new RegExp(STICKER_REF_RE.source, 'gu'))) {
    const start = m.index ?? 0;
    matches.push({
      kind: 'sticker',
      collection: m[1],
      name: m[2],
      token: m[0],
      start,
      end: start + m[0].length,
    });
  }

  // 各语法互不重叠；排序 + 区间过滤只是防御未来加入的新形态。
  matches.sort((a, b) => a.start - b.start || a.end - b.end);
  const result: RefMatch[] = [];
  let cursor = 0;
  for (const match of matches) {
    if (match.start < cursor) continue;
    result.push(match);
    cursor = match.end;
  }
  return result;
}

function scanDocument(nodes: LocalNode[], out: ScannedText[]): void {
  for (const node of nodes) {
    if (node.type === 'text') {
      if (typeof node.value === 'string' && node.value.includes('[@')) {
        const matches = collectMatches(node.value);
        if (matches.length) out.push({ node, matches });
      }
      continue;
    }
    // 宿主组件与代码 / 链接 / fallback 一样不进入：token 只从作者正文文本产生。
    if (CONTAINER_TYPES.has(node.type) && node.children) scanDocument(node.children, out);
  }
}

function collectUserNames(groups: ScannedText[], max: number): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  if (max <= 0) return names;
  for (const { matches } of groups) {
    for (const match of matches) {
      if (match.kind !== 'user') continue;
      if (names.length >= max) return names;
      if (seen.has(match.name)) continue;
      seen.add(match.name);
      names.push(match.name);
    }
  }
  return names;
}

type ClipboardMatch = Extract<RefMatch, { kind: 'clipboard' }>;

function findFirstClipboard(
  groups: ScannedText[]
): { node: LocalNode; match: ClipboardMatch } | null {
  for (const group of groups) {
    for (const match of group.matches) {
      if (match.kind === 'clipboard') return { node: group.node, match };
    }
  }
  return null;
}

// ── 适配状态 ────────────────────────────────────────────────────────────────

/**
 * 页面内所有消息共用的取数闸门（同一时刻在飞 ≤ MAX_REF_CONCURRENCY）。
 * 闸门只排队、不缓存结果：私聊正文与剪贴板内容不留在模块里。
 */
const chatReferenceFetchGate = createConcurrencyLimiter(MAX_REF_CONCURRENCY);

interface AdaptState {
  budget: ChatReferenceBudget;
  used: { images: number; audio: number; stickers: number; users: number; clipboard: number };
  nextSlotIndex: number;
  hostData: ChatHostDataMap;
  /** 适配器亲手建出的宿主节点；裸图判定只认它们，作者伪造的节点不算。 */
  generated: WeakSet<LocalNode>;
  reader: ChatReferenceReader;
  /** 父文档按可见 AST 收集、已取回的名片；子剪贴板沿用这一份，不再发请求。 */
  cards: Map<string, ChatUserCard>;
}

interface AcceptedRef {
  match: RefMatch;
  data: ChatHostData;
}

interface AdaptOptions {
  allowClipboard: boolean;
  fetchUserCards: boolean;
  signal: AbortSignal;
  compileChild?: ChatReferenceContext['compileChild'];
}

function normalizeBudget(budget: ChatReferenceBudget | undefined): ChatReferenceBudget {
  const pick = (value: unknown, fallback: number): number => {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return fallback;
    return Math.floor(value);
  };
  return {
    images: pick(budget?.images, CHAT_REFERENCE_BUDGET.images),
    audio: pick(budget?.audio, CHAT_REFERENCE_BUDGET.audio),
    stickers: pick(budget?.stickers, CHAT_REFERENCE_BUDGET.stickers),
    users: pick(budget?.users, CHAT_REFERENCE_BUDGET.users),
    clipboard: pick(budget?.clipboard, CHAT_REFERENCE_BUDGET.clipboard),
  };
}

function cloneDocument<T>(value: T): T {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value)) as T;
}

function allocate(state: AdaptState, build: (slot: string) => ChatHostData): ChatHostData {
  const slot = chatRefSlot(state.nextSlotIndex);
  state.nextSlotIndex += 1;
  const data = build(slot);
  state.hostData[slot] = data;
  return data;
}

function renderSimple(match: RefMatch, state: AdaptState): ChatHostData | undefined {
  switch (match.kind) {
    case 'image': {
      if (state.used.images >= state.budget.images) return undefined;
      state.used.images += 1;
      return allocate(state, (slot) => ({
        kind: 'image',
        slot,
        token: match.token,
        imageId: match.id,
        url: `/api/images/${match.id}/raw`,
      }));
    }
    case 'audio': {
      if (state.used.audio >= state.budget.audio) return undefined;
      state.used.audio += 1;
      return allocate(state, (slot) => ({
        kind: 'audio',
        slot,
        token: match.token,
        url: audioUrl(match.id),
      }));
    }
    case 'sticker': {
      let url: string;
      let emoji: boolean;
      if (match.collection === EMOJI_COLLECTION) {
        const file = emojiFileFor(match.name);
        // 清单里没有的黄脸名字：不猜字节路由，直接保留字面量（与「资源失效回 token」同向）。
        if (!file) return undefined;
        url = emojiUrl(file);
        emoji = true;
      } else {
        url = stickerUrl(match.collection, match.name);
        emoji = false;
      }
      if (state.used.stickers >= state.budget.stickers) return undefined;
      state.used.stickers += 1;
      return allocate(state, (slot) => ({
        kind: 'sticker',
        slot,
        token: match.token,
        url,
        emoji,
      }));
    }
    case 'user': {
      const card = state.cards.get(match.name);
      // 失败 / 未取到不占预算：后面画得出来的名片仍有机会落位（与旧 embedUserRefs 同口径）。
      if (!card) return undefined;
      if (state.used.users >= state.budget.users) return undefined;
      state.used.users += 1;
      return allocate(state, (slot) => ({
        kind: 'user',
        slot,
        token: match.token,
        user: {
          id: card.id,
          username: card.username,
          avatar_url: avatarUrl(card.id),
          frame_url: card.frameUrl,
        },
      }));
    }
    case 'clipboard':
      // 剪贴板在简单引用之后单独处理（需要异步编译子文档）。
      return undefined;
  }
}

// ── 文本节点改写 ────────────────────────────────────────────────────────────

function createHostNode(node: LocalNode, match: RefMatch, slot: string): LocalNode {
  return {
    type: 'hostComponent',
    id: `${node.id}:chat-ref:${match.start}`,
    range: {
      start: node.range.start + match.start,
      end: node.range.start + match.end,
    },
    name: CHAT_REF_HOST_TAG,
    // 上游只对 inline/container 宿主节点调用 hostRenderer；聊天引用全走 slot 查表，
    // 用 inline 是本意（块级剪贴板子文档由视图层 lift 出段落）。
    hostForm: 'inline',
    attrs: { [CHAT_REF_SLOT_ATTR]: slot },
  };
}

function splitTextNode(
  node: LocalNode,
  accepted: AcceptedRef[],
  state: AdaptState
): LocalNode[] {
  const value = node.value ?? '';
  const parts: LocalNode[] = [];
  let cursor = 0;
  for (const { match, data } of accepted) {
    if (cursor < match.start) {
      parts.push({
        ...node,
        id: `${node.id}:part:${cursor}`,
        range: { start: node.range.start + cursor, end: node.range.start + match.start },
        value: value.slice(cursor, match.start),
      });
    }
    const host = createHostNode(node, match, data.slot);
    state.generated.add(host);
    parts.push(host);
    cursor = match.end;
  }
  if (cursor < value.length) {
    parts.push({
      ...node,
      id: `${node.id}:part:${cursor}`,
      range: { start: node.range.start + cursor, end: node.range.start + value.length },
      value: value.slice(cursor),
    });
  }
  return parts;
}

function replaceTextNodes(nodes: LocalNode[], replacements: Map<LocalNode, LocalNode[]>): void {
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index];
    const replacement = replacements.get(node);
    if (replacement) {
      nodes.splice(index, 1, ...replacement);
      index += replacement.length - 1;
      continue;
    }
    if (node.children) replaceTextNodes(node.children, replacements);
  }
}

function applyAccepted(
  root: LocalDocument,
  accepted: Map<LocalNode, AcceptedRef[]>,
  state: AdaptState
): void {
  if (!accepted.size) return;
  const replacements = new Map<LocalNode, LocalNode[]>();
  for (const [node, list] of accepted) {
    list.sort((a, b) => a.match.start - b.match.start);
    replacements.set(node, splitTextNode(node, list, state));
  }
  replaceTextNodes(root.nodes, replacements);
}

// ── 剪贴板（首条、子文档内联一层、截断 + 回链）────────────────────────────────

/**
 * 可以展开进聊天的剪贴板格式（`ContentFormat` 的全部取值）。两者都是 RMD 源码，
 * 由同一个 `compileChild` 入口编译；库内认不出的 `unknown` 不在此列，只给回链。
 */
const INLINE_CLIPBOARD_FORMATS: ReadonlySet<string> = new Set<ContentFormat>([
  'markdown',
  'reactive',
]);

function buildClipboardData(
  match: ClipboardMatch,
  read: ChatClipboardRead,
  state: AdaptState,
  options: AdaptOptions
): Promise<{ aborted: true } | { data?: ChatHostData }> {
  const token = match.token;
  const href = `/clipboard/${match.id}`;
  const make = (
    fields: Omit<ChatClipboardHostData, 'kind' | 'slot' | 'token' | 'href'>
  ): ChatHostData =>
    allocate(state, (slot) => ({ kind: 'clipboard', slot, token, href, ...fields }));

  if (read.status === 'missing' || read.status === 'forbidden') {
    return Promise.resolve({ data: make({ error: read.status }) });
  }
  if (read.status !== 'ready') {
    // 网络 / 解析失败：不给回链也不给半截内容，宿主位置原样显示 token。
    return Promise.resolve({
      data: allocate(state, (slot) => ({ kind: 'fallback', slot, token })),
    });
  }
  if (!INLINE_CLIPBOARD_FORMATS.has(read.format)) {
    // 库内认不出的格式：整篇正文不进聊天，只给站内回链。
    return Promise.resolve({ data: make({ error: 'format' }) });
  }

  return (async () => {
    const truncated = read.content.length > CLIP_EXPAND_MAX;
    const source = truncated ? read.content.slice(0, CLIP_EXPAND_MAX) : read.content;
    let child: LocalDocument | null = null;
    if (options.compileChild) {
      try {
        const compiled = await options.compileChild(source, options.signal);
        if (compiled && Array.isArray(compiled.nodes)) child = cloneDocument(compiled);
      } catch {
        // 子编译失败仍保留回链卡片，不把半截文档塞进消息。
        child = null;
      }
    }
    if (options.signal.aborted) return { aborted: true as const };
    if (child) {
      const childAborted = await adaptTree(child, state, {
        allowClipboard: false,
        fetchUserCards: false,
        signal: options.signal,
        compileChild: undefined,
      });
      if (childAborted || options.signal.aborted) return { aborted: true as const };
      return {
        data: make(truncated ? { document: child, truncated: true } : { document: child }),
      };
    }
    return { data: make(truncated ? { truncated: true } : {}) };
  })();
}

// ── 主流程 ──────────────────────────────────────────────────────────────────

async function adaptTree(
  root: LocalDocument,
  state: AdaptState,
  options: AdaptOptions
): Promise<boolean> {
  const groups: ScannedText[] = [];
  scanDocument(root.nodes, groups);
  if (!groups.length) return false;
  if (options.signal.aborted) return true;

  const gate = chatReferenceFetchGate;

  const userReads: Array<[string, Promise<ChatUserCardRead>]> = [];
  if (options.fetchUserCards) {
    for (const name of collectUserNames(groups, state.budget.users)) {
      userReads.push([
        name,
        gate(() => state.reader.readUserCard(name, options.signal)).catch(
          () => ({ status: 'error' }) as ChatUserCardRead
        ),
      ]);
    }
  }

  const clipboardTarget =
    options.allowClipboard && state.used.clipboard < state.budget.clipboard
      ? findFirstClipboard(groups)
      : null;
  const clipboardRead = clipboardTarget
    ? gate(() => state.reader.readClipboard(clipboardTarget.match.id, options.signal)).catch(
        () => ({ status: 'error' }) as ChatClipboardRead
      )
    : null;

  if (options.fetchUserCards) {
    const cards = new Map<string, ChatUserCard>();
    for (const [name, pending] of userReads) {
      const result = await pending;
      if (result.status === 'ready') cards.set(name, result.card);
    }
    if (options.signal.aborted) return true;
    state.cards = cards;
  }

  const accepted = new Map<LocalNode, AcceptedRef[]>();
  const push = (node: LocalNode, match: RefMatch, data: ChatHostData): void => {
    const list = accepted.get(node);
    if (list) list.push({ match, data });
    else accepted.set(node, [{ match, data }]);
  };

  // 简单引用按文档顺序占预算；超限 / 失败的名字留在文本里当字面量。
  for (const group of groups) {
    for (const match of group.matches) {
      const data = renderSimple(match, state);
      if (data) push(group.node, match, data);
    }
  }

  if (clipboardTarget && clipboardRead) {
    const read = await clipboardRead;
    if (options.signal.aborted) return true;
    const built = await buildClipboardData(clipboardTarget.match, read, state, options);
    if ('aborted' in built) return true;
    if (built.data) {
      push(clipboardTarget.node, clipboardTarget.match, built.data);
      state.used.clipboard += 1;
    }
  }

  if (options.signal.aborted) return true;
  applyAccepted(root, accepted, state);
  return false;
}

// ── 裸图候选 ────────────────────────────────────────────────────────────────

/** 允许包住裸图的 Markdown 行内容器（P / BR / A / STRONG / B / EM / I / U / S / DEL）。 */
const BARE_WRAPPERS = new Set(['paragraph', 'strong', 'emphasis', 'delete', 'underline', 'link']);

function findBareImageSlot(nodes: LocalNode[], state: AdaptState): string | null {
  let slot: string | null = null;
  let invalid = false;

  const visit = (list: LocalNode[]): void => {
    for (const node of list) {
      if (invalid) return;
      if (node.type === 'text') {
        if ((node.value ?? '').trim() !== '') invalid = true;
        continue;
      }
      if (node.type === 'break') continue;
      if (BARE_WRAPPERS.has(node.type)) {
        visit(node.children ?? []);
        continue;
      }
      if (node.type === 'hostComponent') {
        if (node.name !== CHAT_REF_HOST_TAG || !state.generated.has(node)) {
          invalid = true;
          return;
        }
        const slotId = node.attrs?.[CHAT_REF_SLOT_ATTR];
        const data = slotId ? state.hostData[slotId] : undefined;
        if (!data || data.kind !== 'image' || slot !== null) {
          invalid = true;
          return;
        }
        slot = data.slot;
        continue;
      }
      // 其他块（标题、列表、引用、媒体、字面量等）都算「有正文」。
      invalid = true;
    }
  };

  visit(nodes);
  return invalid ? null : slot;
}

/**
 * 引用适配的唯一出口。
 *
 * 返回的 document 是输入文档的深拷贝；hostData 只包含适配器登记的数据；
 * 每个出现位置独立 slot。取消（signal.aborted）时返回未适配的空结果。
 */
export async function adaptChatReferences(
  document: LocalDocument,
  context: ChatReferenceContext
): Promise<ChatReferenceDocument> {
  const source = cloneDocument(document);
  const empty: ChatReferenceDocument = {
    document: source,
    hostData: {},
    bareImageCandidateSlot: null,
  };
  const signal = context?.signal;
  if (!signal || signal.aborted) return empty;

  const state: AdaptState = {
    budget: normalizeBudget(context.budget),
    used: { images: 0, audio: 0, stickers: 0, users: 0, clipboard: 0 },
    nextSlotIndex: 0,
    hostData: {},
    generated: new WeakSet(),
    reader: createChatReferenceReader({ viewerScope: context.viewerScope }),
    cards: new Map(),
  };

  const aborted = await adaptTree(source, state, {
    allowClipboard: (context.depth ?? 0) <= 0,
    fetchUserCards: true,
    signal,
    compileChild: context.compileChild,
  });
  if (aborted || signal.aborted) {
    return {
      document: cloneDocument(document),
      hostData: {},
      bareImageCandidateSlot: null,
    };
  }

  return {
    document: source,
    hostData: state.hostData,
    bareImageCandidateSlot: findBareImageSlot(source.nodes, state),
  };
}