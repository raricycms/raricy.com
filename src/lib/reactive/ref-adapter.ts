import { compileSource } from './compile-source';
import type { LocalDocument, LocalNode } from 'reactive-md';
import { AUDIO_REF_RE, MAX_AUDIO_REFS } from '../audio-refs';
import {
  CLIPBOARD_ID_LEN, IMAGE_ID_LEN, VOTE_ID_LEN,
  MAX_BLOG_REF_ITEMS, MAX_REF_CONCURRENCY, MAX_REF_FETCHES, createConcurrencyLimiter,
} from '../content-refs';
import { isFavoriteId, MAX_FAVORITE_REFS } from '../favorite-refs';
import { BoundedLruCache } from './bounded-cache';
import { SITE_EMBED_TAG } from './host-components';
import type {
  ReferenceKind, ReferenceMode, ReferenceReader, ReferenceSlot, SiteEmbedData, SiteHostData,
} from './ref-types';

export const ADAPTER_VERSION = 'reactive-ref-ast/1';

interface Options {
  mode: ReferenceMode;
  resolve?: ReferenceReader;
  scheduler?: ReturnType<typeof createConcurrencyLimiter>;
}

export interface ReferenceDocument {
  document: LocalDocument;
  hostData: SiteHostData;
}

const NUMERIC_REFERENCE = /\[@\s*([A-Za-z0-9]+)\s*\]/g;

function numericKind(id: string): ReferenceKind | undefined {
  if (id.length === IMAGE_ID_LEN) return 'image';
  if (id.length === CLIPBOARD_ID_LEN) return 'clipboard';
  if (id.length === VOTE_ID_LEN) return 'vote';
  if (isFavoriteId(id)) return 'favorite';
}

function textReferences(value: string, allowBlocks: boolean): ReferenceSlot[] {
  const slots: ReferenceSlot[] = [];
  for (const { 0: token, 1: ref, index: start } of value.matchAll(NUMERIC_REFERENCE)) {
    const kind = numericKind(ref);
    if (kind && (allowBlocks || kind === 'image')) {
      slots.push({ kind, ref, token, start, end: start + token.length });
    }
  }
  if (allowBlocks) {
    for (const { 0: token, 1: ref, index: start } of value.matchAll(AUDIO_REF_RE)) {
      slots.push({ kind: 'audio', ref, token, start, end: start + token.length });
    }
    slots.sort((a, b) => a.start - b.start);
  }
  return slots;
}

function findReferences(nodes: LocalNode[], slots: Map<LocalNode, ReferenceSlot[]>, inParagraph = false): void {
  for (const node of nodes) {
    if (node.type === 'link' || node.type === 'fallback' || node.type === 'code' || node.type === 'inlineCode') continue;
    if (node.type === 'text' && node.value?.includes('[@')) {
      const found = textReferences(node.value, inParagraph);
      if (found.length) slots.set(node, found);
    }
    if (node.children) findReferences(node.children, slots, inParagraph || node.type === 'paragraph');
  }
}

function refKey({ kind, ref }: ReferenceSlot): string {
  return kind + ':' + ref;
}

async function readReferences(slots: Map<LocalNode, ReferenceSlot[]>, options: Options) {
  const resolved = new Map<string, SiteEmbedData>();
  const read = options.mode === 'expand' ? options.resolve : undefined;
  if (!read) return resolved;
  const candidates = new Map<string, ReferenceSlot>();
  for (const group of slots.values()) {
    for (const slot of group) {
      if (slot.kind === 'image' || slot.kind === 'audio') continue;
      if (candidates.size < MAX_REF_FETCHES) candidates.set(refKey(slot), slot);
    }
  }
  const schedule = options.scheduler ?? createConcurrencyLimiter(MAX_REF_CONCURRENCY);
  await Promise.all([...candidates].map(async ([key, slot]) => {
    const data = await schedule(async () => read(slot)).catch(() => undefined);
    if (data && slot.kind !== 'image') resolved.set(key, { ...data, kind: slot.kind, ref: slot.ref });
  }));
  return resolved;
}

function replaceText(node: LocalNode, slots: ReferenceSlot[], render: (slot: ReferenceSlot, node: LocalNode) => LocalNode | undefined) {
  const result: LocalNode[] = [];
  let cursor = 0;
  for (const slot of slots) {
    const nodeId = node.id + ':ref:' + slot.start;
    const replacement = render(slot, { type: 'text', id: nodeId, range: node.range });
    if (!replacement) continue;
    if (cursor < slot.start) {
      result.push({ ...node, id: nodeId + ':before', value: node.value!.slice(cursor, slot.start) });
    }
    result.push(replacement);
    cursor = slot.end;
  }
  if (cursor === 0) return [node];
  if (cursor < node.value!.length) result.push({ ...node, value: node.value!.slice(cursor) });
  return result;
}

function splitFlow(node: LocalNode, children: LocalNode[]): LocalNode[] {
  const result: LocalNode[] = [];
  let start = 0;
  for (const [index, child] of children.entries()) {
    if (child.type !== 'hostComponent') continue;
    if (index > start) result.push({ ...node, id: node.id + ':part:' + start, children: children.slice(start, index) });
    result.push(child);
    start = index + 1;
  }
  if (start === 0) return [{ ...node, children }];
  if (start < children.length) result.push({ ...node, children: children.slice(start) });
  return result;
}

/** Expand references in parsed prose without rescanning code, links or rejected markup. */
export async function expandDocumentReferences(document: LocalDocument, options: Options): Promise<ReferenceDocument> {
  const slots = new Map<LocalNode, ReferenceSlot[]>();
  findReferences(document.nodes, slots);
  if (!slots.size) return { document, hostData: {} };
  const resolved = await readReferences(slots, options);
  const hostData: Record<string, SiteEmbedData> = {};
  const used = { main: 0, audio: 0, favorite: 0 };
  const limits = { main: MAX_BLOG_REF_ITEMS, audio: MAX_AUDIO_REFS, favorite: MAX_FAVORITE_REFS };

  function render(slot: ReferenceSlot, node: LocalNode): LocalNode | undefined {
    const { kind, ref } = slot;
    const group = kind === 'audio' || kind === 'favorite' ? kind : 'main';
    if (used[group] >= limits[group]) return;
    const key = refKey(slot);
    const data = kind === 'audio' ? { kind, ref, status: 'ready' as const } : resolved.get(key);
    if (kind === 'image') {
      used[group] += 1;
      return { ...node, type: 'image', url: '/api/images/' + ref + '/raw', alt: ref };
    }
    if (!data) return;
    used[group] += 1;
    hostData[key] = data;
    return { ...node, type: 'hostComponent', name: SITE_EMBED_TAG, hostForm: 'leaf', attrs: { kind, ref } };
  }

  function rewrite(node: LocalNode, inParagraph = false): LocalNode[] {
    const found = slots.get(node);
    if (found) return replaceText(node, found, render);
    if (!node.children) return [node];
    const flow = inParagraph || node.type === 'paragraph';
    const children = node.children.flatMap((child) => rewrite(child, flow));
    return flow ? splitFlow(node, children) : [{ ...node, children }];
  }

  const nodes = document.nodes.flatMap((node) => rewrite(node));
  await Promise.all(Object.values(hostData).map(async (data) => {
    const content = data.content;
    delete data.content;
    if (data.kind !== 'clipboard' || data.status !== 'ready' || data.format !== 'markdown' || !content) return;
    const inline = await prepareInlineMarkdownDocument(content);
    if (inline) Object.assign(data, inline);
  }));
  return { document: { ...document, nodes }, hostData };
}

const inlineCache = new BoundedLruCache<ReferenceDocument | null>({
  maxEntries: 64,
  maxBytes: 8 * 1024 * 1024,
  sizeOf: (value) => JSON.stringify(value).length,
});

export async function prepareInlineMarkdownDocument(content: string): Promise<ReferenceDocument | null> {
  const cached = inlineCache.get(content);
  if (cached !== undefined) return cached;
  let artifact: ReferenceDocument | null = null;
  try {
    const result = compileSource(content);
    if (result.ok) artifact = await expandDocumentReferences(result.document, { mode: 'external' });
  } catch {
    // An unreadable child still has a link card in the parent document.
  }
  inlineCache.set(content, artifact);
  return artifact;
}
