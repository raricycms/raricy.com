// ─────────────────────────────────────────────────────────────────────────────
// snapshot-store.ts — reactive 正文同版本静态快照的读写（服务端）
//
// 快照 = 一次编译的 `LocalDocument` + 该次权限上下文下的 hostData。存 JSON 而不是
// HTML，理由见迁移 36 头部：Next 不允许 `react-dom/server` 进 RSC 模块图；阅读页用
// 上游组件的 `mode="static"` 从这份 JSON 得到同样的静态首屏。
//
// 三条纪律：
//   · **版本先于一切**：只有 content_version 与完整编译签名都一致才返回 ready；
//     旧行按 stale 处理，绝不拿它冒充当前正文（计划 D2）。
//   · **摘要复核**：document + hostData 的摘要不对就是 corrupt，不尝试「修好」它。
//   · 快照只按 **external** 权限生成（publish 侧固定），不写会话数据。
// ─────────────────────────────────────────────────────────────────────────────

import { LOCAL_SYNTAX_VERSION, localCompileOptionsKey } from 'reactive-md';
import type { LocalDocument } from 'reactive-md';
import { prisma } from '../db';
import { sha256Hex } from './cache';
import { ADAPTER_VERSION } from './ref-adapter';
import {
  REACTIVE_COMPILER_VERSION,
  reactiveCompileOptions,
} from './host-components';
import type { SiteHostData } from './ref-types';

export const SNAPSHOT_KIND = { blog: 'blog', clipboard: 'clipboard' } as const;
export type SnapshotKind = (typeof SNAPSHOT_KIND)[keyof typeof SNAPSHOT_KIND];

/** 与正文写入共用的内容版本：格式 / 语法版本 / 原文三者任一变化就换版本。 */
export function reactiveContentVersion(
  format: string,
  syntaxVersion: string | null,
  content: string,
): string {
  return sha256Hex(JSON.stringify([format, syntaxVersion ?? null, content]));
}

/** 当前编译包能认可的完整签名（读取时与写入行逐字段比较）。 */
export function currentSnapshotSignature(): {
  syntaxVersion: string;
  compilerVersion: string;
  adapterVersion: string;
  optionsKey: string;
} {
  return {
    syntaxVersion: LOCAL_SYNTAX_VERSION,
    compilerVersion: REACTIVE_COMPILER_VERSION,
    adapterVersion: ADAPTER_VERSION,
    optionsKey: localCompileOptionsKey(reactiveCompileOptions('reactive')),
  };
}

export interface SnapshotPayload {
  document: LocalDocument;
  hostData: SiteHostData;
}

export type SnapshotReadResult =
  | { status: 'ready'; payload: SnapshotPayload }
  | { status: 'missing' }
  | { status: 'stale'; reason: 'content-version' | 'compile-signature' | 'scope' }
  | { status: 'corrupt'; reason: 'format' | 'digest' | 'json' };

function payloadDigest(documentJson: string, hostDataJson: string): string {
  return sha256Hex(`${documentJson}\n${hostDataJson}`);
}

/**
 * 读出该内容版本的快照。
 *
 * `contentVersion` 由调用方按当前正文现算（`reactiveContentVersion`）。查不到该版本
 * 行 = missing；查到了但签名不符 = stale；JSON / 摘要坏了 = corrupt。
 */
export async function readReactiveSnapshot(
  kind: SnapshotKind,
  contentId: string,
  contentVersion: string,
): Promise<SnapshotReadResult> {
  const row = await prisma.reactiveSnapshot.findUnique({
    where: {
      uq_reactive_snapshot_version: { kind, contentId, contentVersion },
    },
  });
  if (!row) return { status: 'missing' };
  if (row.format !== 'reactive') return { status: 'corrupt', reason: 'format' };
  if (row.scope !== 'external') return { status: 'stale', reason: 'scope' };

  const current = currentSnapshotSignature();
  if (
    row.syntaxVersion !== current.syntaxVersion ||
    row.compilerVersion !== current.compilerVersion ||
    row.adapterVersion !== current.adapterVersion ||
    row.optionsKey !== current.optionsKey
  ) {
    return { status: 'stale', reason: 'compile-signature' };
  }
  if (row.contentVersion !== contentVersion) return { status: 'stale', reason: 'content-version' };
  if (row.digest !== payloadDigest(row.documentJson, row.hostDataJson)) {
    return { status: 'corrupt', reason: 'digest' };
  }

  try {
    const document = JSON.parse(row.documentJson) as LocalDocument;
    const hostData = JSON.parse(row.hostDataJson) as SiteHostData;
    if (!document || typeof document !== 'object' || !hostData || typeof hostData !== 'object') {
      return { status: 'corrupt', reason: 'json' };
    }
    return { status: 'ready', payload: { document, hostData } };
  } catch {
    return { status: 'corrupt', reason: 'json' };
  }
}

/** 供写入事务直接使用的一行（字段与 Prisma 模型一一对应）。 */
export interface ReactiveSnapshotRow {
  id: string;
  kind: SnapshotKind;
  contentId: string;
  contentVersion: string;
  format: 'reactive';
  scope: 'external';
  syntaxVersion: string;
  compilerVersion: string;
  adapterVersion: string;
  optionsKey: string;
  documentJson: string;
  hostDataJson: string;
  digest: string;
  generatedAt: string;
}

export function snapshotRowId(
  kind: SnapshotKind,
  contentId: string,
  contentVersion: string,
): string {
  return sha256Hex(`${kind}:${contentId}:${contentVersion}`);
}

export function toSnapshotRow(
  kind: SnapshotKind,
  contentId: string,
  contentVersion: string,
  payload: SnapshotPayload,
  generatedAt: string,
): ReactiveSnapshotRow {
  const documentJson = JSON.stringify(payload.document);
  const hostDataJson = JSON.stringify(payload.hostData);
  const signature = currentSnapshotSignature();
  return {
    id: snapshotRowId(kind, contentId, contentVersion),
    kind,
    contentId,
    contentVersion,
    format: 'reactive',
    scope: 'external',
    syntaxVersion: signature.syntaxVersion,
    compilerVersion: signature.compilerVersion,
    adapterVersion: signature.adapterVersion,
    optionsKey: signature.optionsKey,
    documentJson,
    hostDataJson,
    digest: payloadDigest(documentJson, hostDataJson),
    generatedAt,
  };
}
