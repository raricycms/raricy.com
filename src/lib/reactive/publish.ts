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
import { isoWithOffset, nowForDb } from '../db-time';
import { shouldFallbackToLegacy } from './diagnostics';
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
}

/** 发布被拒的**类型化**错误：route 用它折 400，不靠比对错误文案。 */
export class ReactivePublishError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReactivePublishError';
  }
}

export type BuildReactiveSnapshotResult =
  | {
      ok: true;
      row: ReactiveSnapshotRow;
      contentVersion: string;
      syntaxVersion: string;
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
  const { compileReactiveSource } = await import('./compile');

  const bundle = await compileReactiveSource({
    source: input.content,
    format: 'reactive',
    mode: 'external',
    viewer: null,
  });

  if (!bundle.result.ok) {
    return {
      ok: false,
      reason: 'compile',
      codes: bundle.result.diagnostics.map((diagnostic) => diagnostic.code),
    };
  }
  if (shouldFallbackToLegacy(bundle.result)) {
    return {
      ok: false,
      reason: 'fallback',
      codes: bundle.result.diagnostics.map((diagnostic) => diagnostic.code),
    };
  }

  const contentVersion = reactiveContentVersion(
    'reactive',
    LOCAL_SYNTAX_VERSION,
    input.content,
  );
  const generatedAt = isoWithOffset(nowForDb());
  const row = toSnapshotRow(
    input.kind,
    input.contentId,
    contentVersion,
    { document: bundle.result.document, hostData: bundle.hostData },
    generatedAt ?? '',
  );

  return {
    ok: true,
    row,
    contentVersion,
    syntaxVersion: LOCAL_SYNTAX_VERSION,
  };
}
