// ─────────────────────────────────────────────────────────────────────────────
// snapshot.ts — reactive 正文的**同版本静态快照**契约（P8 的骨架，不是生产存储）
//
// 为什么需要快照：reactive 文档一旦解释失败，**不能**把源码交给旧 Markdown 渲染器
// （那会把它当普通文本，页面上出现一堆标签字面量）。阅读页要展示的替代品是「与当前
// 正文同一内容版本」的服务端静态快照。因此发布正文与发布快照必须同版本、原子地成功，
// 缺一个就拒绝发布新版本。
//
// 本文件只定义**纯接口**，刻意不接 Prisma / 文件系统 / 真实表：
//   · `TrustedSnapshotGenerator` —— 只能是站点服务端生成器（同一编译配置 + 静态
//     renderer），**不接受作者上传的 HTML**；本文件不做任何假渲染。
//   · `SnapshotStore` —— `commit(record, expected)` 必须在**一个事务**里核对
//     `expected.contentVersion` 再写记录；版本已经变了就抛 `SnapshotVersionConflictError`。
//     失败时一次都不 commit。
//   · `readSnapshot` —— 版本/编译签名不符一律拒读（返回 `stale`，不把旧 HTML 交出去）。
//
// 快照的公开范围**固定 external**：不把会话数据（`user_voted`、成员私有引用等）写进
// 可公开下发的快照。调用方传入的 `publicData` 只是给生成器的公开上下文，不落库；
// 它必须 JSON-safe，避免函数/类实例混进跨请求数据。
//
// 【与生产路径的关系】这里保留的是**HTML 快照**的通用契约（含它的纯函数测试）。
// 线上实际写入的表是迁移 36 的 `reactive_snapshots`，存的是编译产物 JSON
// （`snapshot-store.ts`）：Next 的 RSC 编译链不允许在服务端现调 `react-dom/server`，
// 阅读页改用上游组件的 `mode="static"` 从 JSON 得到同样的静态首屏。
// 本文件不参与那条线上链路，不要把它当成生产存储。见 `docs/architecture.md` §6.23。
// ─────────────────────────────────────────────────────────────────────────────

import {
  isReactiveJsonObject,
  sha256Hex,
  utf8ByteLength,
  type ReactiveJsonValue,
} from './cache';

export const SNAPSHOT_SCOPE = 'external' as const;
export type SnapshotScope = typeof SNAPSHOT_SCOPE;

export const SNAPSHOT_FORMAT = 'reactive' as const;
export type SnapshotFormat = typeof SNAPSHOT_FORMAT;

/** 一次「正文内容版本 + 编译签名」的完整描述。 */
export interface SnapshotVersionRef {
  contentId: string;
  /** 正文内容版本（正文与快照同版本发布的那个版本号）。 */
  contentVersion: string;
  syntaxVersion: string;
  compilerVersion: string;
  adapterVersion: string;
  /** 上游 `localCompileOptionsKey(options)`。 */
  optionsKey: string;
}

/** 交给受信任生成器的输入：只有公开上下文，没有会话数据。 */
export interface SnapshotGenerationInput extends SnapshotVersionRef {
  format: SnapshotFormat;
  scope: SnapshotScope;
  publicData: { readonly [key: string]: ReactiveJsonValue };
}

/**
 * 服务端静态快照生成器。
 *
 * 返回 null = 这次生成不可用（例如编译失败 / 数学降级不可接受），调用方**不得**回退成
 * 「拿正文源码顶替」。抛错同样视为失败。生成器只返回 HTML 字符串；摘要与字节数由本
 * 模块自己算，避免生成器与记录两处各写一份。
 */
export type TrustedSnapshotGenerator = (
  input: SnapshotGenerationInput
) => Promise<string | null>;

/** 落库记录。真实表设计未定，这里只固定字段语义。 */
export interface StaticSnapshotRecord extends SnapshotVersionRef {
  format: SnapshotFormat;
  scope: SnapshotScope;
  html: string;
  htmlDigest: string;
  byteLength: number;
  /** 站点时钟的 ISO 时间（应由 `isoWithOffset(nowForDb())` 产生）。 */
  generatedAt: string;
}

/**
 * 存储接口。
 *
 * `commit` 的 `expected` 必须在**同一个事务**里与当前正文版本比较 —— 这是
 * 「正文与快照同版本发布」的唯一保障。不要先 `readLatest` 再写：两步之间正文可能
 * 已经变了（那正是快照与正文错位的窗口）。
 */
export interface SnapshotStore {
  commit(record: StaticSnapshotRecord, expected: SnapshotVersionRef): Promise<void>;
  /** 读出该内容最新的快照（不判版本；版本判断在 `readSnapshot`）。 */
  readLatest(contentId: string): Promise<StaticSnapshotRecord | null>;
}

export class SnapshotVersionConflictError extends Error {
  constructor(
    readonly contentId: string,
    readonly expectedVersion: string,
    readonly actualVersion: string
  ) {
    super(
      `正文版本已变化，拒绝发布快照：${contentId} 期望 ${expectedVersion}，实际 ${actualVersion}`
    );
    this.name = 'SnapshotVersionConflictError';
  }
}

export type PublishSnapshotResult =
  | { status: 'published'; record: StaticSnapshotRecord }
  | { status: 'conflict' }
  | { status: 'unavailable'; reason: 'generator-unavailable' | 'generator-error'; error?: unknown }
  | {
      status: 'rejected';
      reason: 'invalid-input' | 'invalid-scope' | 'invalid-public-data' | 'invalid-html';
    };

export type SnapshotReadResult =
  | { status: 'ready'; record: StaticSnapshotRecord }
  | { status: 'missing' }
  | {
      status: 'stale';
      reason: 'content-version' | 'compile-signature' | 'scope';
    }
  | {
      status: 'corrupt';
      reason: 'content-id' | 'format' | 'digest' | 'size';
    };

export interface PublishSnapshotOptions {
  ref: SnapshotVersionRef;
  generator: TrustedSnapshotGenerator;
  store: SnapshotStore;
  /** 站点时钟 ISO 时间；不在这里取「现在」，避免第二把钟。 */
  generatedAt: string;
  /** 传给生成器的公开上下文；必须 JSON-safe，且不得含会话数据。 */
  publicData?: { readonly [key: string]: ReactiveJsonValue };
  /** 只用于显式拒绝非法来源；合法值只有 external（省略即 external）。 */
  scope?: unknown;
}

const TIME_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isValidVersionRef(ref: SnapshotVersionRef): boolean {
  return (
    isNonEmptyString(ref?.contentId) &&
    isNonEmptyString(ref?.contentVersion) &&
    isNonEmptyString(ref?.syntaxVersion) &&
    isNonEmptyString(ref?.compilerVersion) &&
    isNonEmptyString(ref?.adapterVersion) &&
    isNonEmptyString(ref?.optionsKey)
  );
}

/** 记录是否就是 `expected` 这一版（内容版本 + 完整编译签名 + 固定范围）。 */
export function isSnapshotForVersion(
  record: StaticSnapshotRecord,
  expected: SnapshotVersionRef
): boolean {
  return (
    record.contentId === expected.contentId &&
    record.contentVersion === expected.contentVersion &&
    record.syntaxVersion === expected.syntaxVersion &&
    record.compilerVersion === expected.compilerVersion &&
    record.adapterVersion === expected.adapterVersion &&
    record.optionsKey === expected.optionsKey
  );
}

/**
 * 生成并原子发布一份静态快照。
 *
 * 顺序（每一步失败都**不 commit**）：
 *   1. 校验版本字段、时间、范围与公开数据；
 *   2. 调一次受信任生成器；
 *   3. 自己算摘要/字节数并构造记录；
 *   4. 调一次 `store.commit(record, ref)`。
 *
 * 生成器抛错只返回 `unavailable`，不把原始错误当正文；`commit` 抛
 * `SnapshotVersionConflictError` 返回 `conflict`，其他存储错误继续上抛（那是真的坏）。
 */
export async function publishSnapshot(
  options: PublishSnapshotOptions
): Promise<PublishSnapshotResult> {
  const { generator, store, generatedAt } = options;
  // Freeze a copy before awaiting: an edited request must not relabel already generated HTML.
  const ref: SnapshotVersionRef = Object.freeze({ ...options.ref });

  if (!isValidVersionRef(ref)) return { status: 'rejected', reason: 'invalid-input' };
  if (options.scope !== undefined && options.scope !== SNAPSHOT_SCOPE) {
    return { status: 'rejected', reason: 'invalid-scope' };
  }
  if (typeof generatedAt !== 'string' || !TIME_WITH_OFFSET.test(generatedAt)) {
    return { status: 'rejected', reason: 'invalid-input' };
  }

  const publicData = options.publicData ?? {};
  if (!isReactiveJsonObject(publicData)) {
    return { status: 'rejected', reason: 'invalid-public-data' };
  }

  const input: SnapshotGenerationInput = Object.freeze({
    ...ref,
    format: SNAPSHOT_FORMAT,
    scope: SNAPSHOT_SCOPE,
    publicData,
  });

  let html: string | null;
  try {
    html = await generator(input);
  } catch (error) {
    return { status: 'unavailable', reason: 'generator-error', error };
  }
  if (html === null) return { status: 'unavailable', reason: 'generator-unavailable' };
  if (typeof html !== 'string' || html.length === 0) {
    return { status: 'rejected', reason: 'invalid-html' };
  }

  const record: StaticSnapshotRecord = Object.freeze({
    ...ref,
    format: SNAPSHOT_FORMAT,
    scope: SNAPSHOT_SCOPE,
    html,
    htmlDigest: sha256Hex(html),
    byteLength: utf8ByteLength(html),
    generatedAt,
  });

  try {
    await store.commit(record, ref);
  } catch (error) {
    if (error instanceof SnapshotVersionConflictError) return { status: 'conflict' };
    throw error;
  }

  return { status: 'published', record };
}

/**
 * 读取当前正文版本可用的静态快照。
 *
 * **版本不符拒读**：只有内容版本与完整编译签名都一致、且摘要在读时复核通过，才返回
 * `ready`；否则把旧快照归类为 stale / corrupt，绝不交给页面冒充当前正文。
 * 范围只认 external（公开快照）。
 */
export async function readSnapshot(
  store: SnapshotStore,
  expected: SnapshotVersionRef
): Promise<SnapshotReadResult> {
  expected = Object.freeze({ ...expected });
  if (!isValidVersionRef(expected)) {
    // 调用方拿不到完整版本信息时就没有「同版本」可比 —— 当缺失处理，不猜。
    return { status: 'missing' };
  }

  const record = await store.readLatest(expected.contentId);
  if (!record) return { status: 'missing' };
  if (record.contentId !== expected.contentId) {
    return { status: 'corrupt', reason: 'content-id' };
  }
  if (record.format !== SNAPSHOT_FORMAT) return { status: 'corrupt', reason: 'format' };
  if (record.scope !== SNAPSHOT_SCOPE) return { status: 'stale', reason: 'scope' };
  if (record.contentVersion !== expected.contentVersion) {
    return { status: 'stale', reason: 'content-version' };
  }
  if (!isSnapshotForVersion(record, expected)) {
    return { status: 'stale', reason: 'compile-signature' };
  }
  if (
    typeof record.html !== 'string' ||
    typeof record.htmlDigest !== 'string' ||
    record.htmlDigest !== sha256Hex(record.html)
  ) {
    return { status: 'corrupt', reason: 'digest' };
  }
  // 记录里的 byteLength 是 HTML 原串的 UTF-8 字节数（不是 JSON 序列化后的长度）。
  if (record.byteLength !== utf8ByteLength(record.html)) {
    return { status: 'corrupt', reason: 'size' };
  }

  return { status: 'ready', record };
}
