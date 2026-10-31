// ─────────────────────────────────────────────────────────────────────────────
// publish.ts — reactive 正文发布前的可信快照生成（服务端）
//
// 【为什么动态 import `compile`】`compile` → `prepare` → `ref-reader` 会拖进
// clipboard / vote / favorite 三个 service；而这三个 service 又要 import 本模块来做
// 写入闸门。静态 import 会形成模块环，环在求值期炸不炸取决于加载顺序。把最重的那段
// 放进函数体内 `await import()`，服务的模块图只依赖本文件与 `snapshot-store`。
//
// 【快照固定按 external 生成】公开快照不得含会话数据（user_voted、成员私有引用）。
// 成员阅读时的 expand 展开走的是**实时编译**，不写进快照。
// ─────────────────────────────────────────────────────────────────────────────

import { LOCAL_SYNTAX_VERSION } from 'reactive-md';
import type { ContentFormat, ContentWriteErrorCode } from '../content-format';
import { isoWithOffset, nowForDb } from '../db-time';
import { shouldRejectReactive } from './diagnostics';
import { documentEvidence } from './detect-format';
import { compileContent } from './compile-content';
import {
  reactiveContentVersion,
  toSnapshotRow,
  type ReactiveSnapshotRow,
  type SnapshotKind,
} from './snapshot-store';

export interface BuildReactiveSnapshotInput {
  kind: SnapshotKind;
  contentId: string;
  content: string;
  /** 正文语言。Markdown 与 reactive 的编译选项不同，快照签名也不同。 */
  format: ContentFormat;
}

/** 发布被拒的**类型化**错误：route 用它折 400，不靠比对错误文案。 */
export class ReactivePublishError extends Error {
  readonly code: ContentWriteErrorCode;

  constructor(message: string, code: ContentWriteErrorCode = 'content_unrenderable') {
    super(message);
    this.name = 'ReactivePublishError';
    this.code = code;
  }
}

export type BuildReactiveSnapshotResult =
  | {
      ok: true;
      row: ReactiveSnapshotRow;
      contentVersion: string;
      /** 写回正文行 `syntax_version` 的值：Markdown 恒为 null。 */
      syntaxVersion: string | null;
      /** 解析器实际认出的格式（用于写入格式不匹配闸门）。 */
      detectedFormat: ContentFormat;
    }
  | {
      ok: false;
      reason: 'compile' | 'fallback';
      codes: string[];
    };

/**
 * 编译一次（external 权限）并产出可随正文同事务写入的快照行。
 *
 * 编译失败或命中回退码都返回 `ok: false` —— 调用方必须拒绝这次发布，不能落一个
 * 「正文是 reactive、却没有可读快照」的版本（计划 D2）。
 */
export async function buildReactiveSnapshotForWrite(
  input: BuildReactiveSnapshotInput,
): Promise<BuildReactiveSnapshotResult> {
  // 延迟加载：避开 service ↔ compile 的模块环，见文件头。
  const { compileContent } = await import('./compile-content');

  const { outcome } = await compileContent({
    source: input.content,
    format: input.format,
    mode: 'external',
    viewer: null,
  });

  if (!outcome.result.ok) {
    return {
      ok: false,
      reason: 'compile',
      codes: outcome.result.diagnostics.map((diagnostic) => diagnostic.code),
    };
  }
  if (shouldRejectReactive(outcome.result)) {
    return {
      ok: false,
      reason: 'fallback',
      codes: outcome.result.diagnostics.map((diagnostic) => diagnostic.code),
    };
  }

  const detectedFormat: ContentFormat =
    documentEvidence(outcome.result.document).length > 0 ? 'reactive' : 'markdown';
  const syntaxVersion = input.format === 'reactive' ? LOCAL_SYNTAX_VERSION : null;
  const contentVersion = reactiveContentVersion(input.format, syntaxVersion, input.content);
  const generatedAt = isoWithOffset(nowForDb());
  const row = toSnapshotRow(
    input.kind,
    input.contentId,
    contentVersion,
    input.format,
    { document: outcome.result.document, hostData: outcome.hostData },
    generatedAt ?? '',
  );

  return {
    ok: true,
    row,
    contentVersion,
    syntaxVersion,
    detectedFormat,
  };
}
