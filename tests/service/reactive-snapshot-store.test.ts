// snapshot-store.ts — reactive 同版本静态快照的**读路径**（真库）
//
// 【为什么这个文件必须存在】
// `readReactiveSnapshot` 是整个 reactive 阅读路径上**唯一**决定「这一行快照能不能拿来
// 渲染」的地方，四种裁决各自对应一类线上事故：
//
//   ready   → 正常，用快照渲染静态首屏（访客不发任何请求）
//   missing → 没快照：现编译，性能变差但**内容正确**
//   stale   → 版本/签名对不上：必须重编译。**判错就会拿旧正文冒充新正文**
//   corrupt → JSON/摘要坏了：宁可当没有，也不能把半坏的文档送进渲染器
//
// 其中 stale 的三个理由（content-version / compile-signature / scope）与 corrupt 的
// 三个理由（format / digest / json）都是**静默错**：判成 ready 不会报错，页面照常
// 渲染，只是渲染的是**别的东西**（旧正文、别人的权限视图、半截文档）。
//
// 而这块逻辑此前只有 mock 级覆盖 —— 另有一个 286 行的 `snapshot.ts` 是**生产死代码**
// （`src/` 下零 import），却占着 `reactive-preparation.test.ts` 里 8 个 it。这个文件
// 补的是「真正在跑的那条路」，用真库、真行、真摘要。
//
// 跑在临时 SQLite 上（tests/helpers/db.ts 有硬校验，不会碰真实库）。

import { describe, it, expect, beforeEach } from 'vitest';
import { prisma, resetDb } from '../helpers/db';
import {
  readReactiveSnapshot,
  currentSnapshotSignature,
  reactiveContentVersion,
} from '@/lib/reactive/snapshot-store';
import { sha256Hex } from '@/lib/reactive/cache';

const KIND = 'blog' as const;
const CONTENT_ID = 'blog-snapshot-probe';
const CONTENT = '## 标题\n\n正文 [[1+1]] 与 [@12345678]。';

/**
 * 库行的**宽松**类型 —— 故意不用 `ReactiveSnapshotRow`。
 *
 * 那个类型把 `format` 收成 `'reactive'`、`scope` 收成 `'external'`（写入侧的不变量），
 * 而本文件要测的恰恰是**读侧遇到坏行怎么办**：`format='markdown'`、`scope='expand'`
 * 这些行在正常写入路径下产生不出来，但库里可能有（老版本、手改、迁移错误）。
 * 用强类型就得靠 `as` 强转，反而模糊了「这是故意造的坏数据」这层意思。
 */
interface RawRow {
  id: string;
  kind: 'blog' | 'clipboard';
  contentId: string;
  contentVersion: string;
  format: string;
  scope: string;
  syntaxVersion: string;
  compilerVersion: string;
  adapterVersion: string;
  optionsKey: string;
  documentJson: string;
  hostDataJson: string;
  digest: string;
  generatedAt: string;
}

/** 一份形状合法的 `LocalDocument` —— 只要 `nodes` 是数组就能过读侧的形状校验。 */
const DOCUMENT = {
  type: 'document',
  version: 'local-draft-2',
  nodes: [{ type: 'paragraph', children: [{ type: 'text', value: '正文' }] }],
};

const HOST_DATA = { 'clipboard:abcdefgh': { kind: 'clipboard', ref: 'abcdefgh' } };

/** 与生产写入同口径的摘要：document + hostData 两段 JSON 用 \n 连接。 */
function digestOf(documentJson: string, hostDataJson: string): string {
  return sha256Hex(`${documentJson}\n${hostDataJson}`);
}

/**
 * 造一行快照。默认**完全合法**（各用例只覆盖自己关心的那一格）。
 * 摘要默认按传进来的两份 JSON 现算 —— 于是「只改签名不改摘要」这类用例才真的有区分度。
 */
function makeRow(overrides: Partial<RawRow> = {}): RawRow {
  const documentJson = overrides.documentJson ?? JSON.stringify(DOCUMENT);
  const hostDataJson = overrides.hostDataJson ?? JSON.stringify(HOST_DATA);
  const sig = currentSnapshotSignature();
  return {
    id: 'row-1',
    kind: KIND,
    contentId: CONTENT_ID,
    contentVersion: reactiveContentVersion('reactive', sig.syntaxVersion, CONTENT),
    format: 'reactive',
    scope: 'external',
    syntaxVersion: sig.syntaxVersion,
    compilerVersion: sig.compilerVersion,
    adapterVersion: sig.adapterVersion,
    optionsKey: sig.optionsKey,
    documentJson,
    hostDataJson,
    digest: digestOf(documentJson, hostDataJson),
    generatedAt: '2026-10-26T00:00:00.000Z',
    ...overrides,
  };
}

async function insert(row: RawRow): Promise<void> {
  await prisma.reactiveSnapshot.create({ data: row });
}

describe('readReactiveSnapshot —— missing', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('该版本没有行 → missing（不是 stale，也不是 corrupt）', async () => {
    const version = reactiveContentVersion('reactive', currentSnapshotSignature().syntaxVersion, CONTENT);
    expect(await readReactiveSnapshot(KIND, CONTENT_ID, version)).toEqual({ status: 'missing' });
  });

  it('★ 同内容不同版本号 → missing：版本是把快照与**那一版正文**绑死的唯一手段', async () => {
    const row = makeRow();
    await insert(row);
    // 正文改一个字 → contentVersion 变 → 旧行的版本号不再是当前版本
    const otherVersion = reactiveContentVersion('reactive', row.syntaxVersion, CONTENT + '多一个字');
    expect(await readReactiveSnapshot(KIND, CONTENT_ID, otherVersion)).toEqual({ status: 'missing' });
  });

  it('同版本号但换了 contentId → missing（kind + contentId + version 三者共同定位）', async () => {
    const row = makeRow();
    await insert(row);
    expect(await readReactiveSnapshot(KIND, 'another-blog', row.contentVersion)).toEqual({
      status: 'missing',
    });
  });
});

describe('readReactiveSnapshot —— ready', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('签名、版本、摘要全对 → ready，且把 document 与 hostData 原样交回', async () => {
    const row = makeRow();
    await insert(row);
    const result = await readReactiveSnapshot(KIND, CONTENT_ID, row.contentVersion);
    expect(result.status).toBe('ready');
    if (result.status !== 'ready') return;
    expect(result.payload.document).toEqual(DOCUMENT);
    expect(result.payload.hostData).toEqual(HOST_DATA);
  });

  it('clipboard 这一档同样走通（kind 是枚举，不是只有 blog）', async () => {
    const row = makeRow({ kind: 'clipboard', contentId: 'clip-1' });
    await insert(row);
    const result = await readReactiveSnapshot('clipboard', 'clip-1', row.contentVersion);
    expect(result.status).toBe('ready');
  });
});

describe('readReactiveSnapshot —— stale（三个理由）', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('scope 不是 external → stale/scope：**绝不**把带会话数据的快照渲染给访客', async () => {
    const row = makeRow({ scope: 'expand' });
    await insert(row);
    expect(await readReactiveSnapshot(KIND, CONTENT_ID, row.contentVersion)).toEqual({
      status: 'stale',
      reason: 'scope',
    });
  });

  it('scope 判在签名之前：即使签名也坏了，报的仍是 scope', async () => {
    // 顺序有意义 —— scope 是权限问题，比「包版本旧了」严重得多，先报它。
    const row = makeRow({ scope: 'expand', syntaxVersion: 'ancient-syntax' });
    await insert(row);
    expect(await readReactiveSnapshot(KIND, CONTENT_ID, row.contentVersion)).toEqual({
      status: 'stale',
      reason: 'scope',
    });
  });

  it.each([
    ['syntaxVersion', { syntaxVersion: 'local-draft-1' }],
    ['compilerVersion', { compilerVersion: 'reactive-md/0.0.1' }],
    ['adapterVersion', { adapterVersion: 'reactive-ref-adapter/0' }],
    ['optionsKey', { optionsKey: 'site-embed-options/0:...' }],
  ])('编译签名 %s 变了 → stale/compile-signature', async (_label, override) => {
    const row = makeRow(override as Partial<RawRow>);
    await insert(row);
    expect(await readReactiveSnapshot(KIND, CONTENT_ID, row.contentVersion)).toEqual({
      status: 'stale',
      reason: 'compile-signature',
    });
  });

  it('★ 四个签名字段每一个都必须参与比对 —— 漏一个就能拿旧编译产物冒充新产物', async () => {
    // 这条用例是给「将来有人把某个字段从 if 里删掉」准备的：逐个改坏，逐个必须 stale。
    const sig = currentSnapshotSignature();
    const fields: Array<keyof typeof sig> = [
      'syntaxVersion',
      'compilerVersion',
      'adapterVersion',
      'optionsKey',
    ];
    for (const f of fields) {
      await resetDb();
      const row = makeRow({ [f]: `${sig[f]}-drifted` } as Partial<RawRow>);
      await insert(row);
      const result = await readReactiveSnapshot(KIND, CONTENT_ID, row.contentVersion);
      expect(result, `字段 ${f} 没有参与签名比对`).toEqual({
        status: 'stale',
        reason: 'compile-signature',
      });
    }
  });

  it('★ 行里的 contentVersion 与查询版本不一致 → 实际返回 missing（where 已按版本筛过）', async () => {
    // 这一格钉的是**可达行为**，不是源码里那行 `stale/content-version` 判断：
    // 查询的 where 里带了 contentVersion，所以版本不符的行**根本查不出来**，
    // 走的是 missing。源码里那行是防御性的（万一将来把 where 放宽成
    // 「按 kind+contentId 取最新一行」它就会变成唯一的把关），当下不可达。
    //
    // 断言 missing 而不是 stale 是有意义的：调用方的分支不同 —— missing 会重新编译
    // 并写一份新快照，stale 会重编译但认为「已有旧行」。两者都不该拿旧行渲染。
    const row = makeRow({ contentVersion: 'a-version-from-the-past' });
    await insert(row);
    const queryVersion = reactiveContentVersion('reactive', row.syntaxVersion, CONTENT);
    expect(await readReactiveSnapshot(KIND, CONTENT_ID, queryVersion)).toEqual({
      status: 'missing',
    });
  });
});

describe('readReactiveSnapshot —— corrupt（三个理由）', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('format 不是 reactive → corrupt/format', async () => {
    const row = makeRow({ format: 'markdown' });
    await insert(row);
    expect(await readReactiveSnapshot(KIND, CONTENT_ID, row.contentVersion)).toEqual({
      status: 'corrupt',
      reason: 'format',
    });
  });

  it('★ 摘要对不上 → corrupt/digest：这是防「有人手改了库里的 JSON」的那一道', async () => {
    const row = makeRow();
    // 摘要保持合法，只把正文换掉 —— 等价于绕过写入路径直接改库
    await insert({ ...row, documentJson: JSON.stringify({ ...DOCUMENT, nodes: [] }) });
    expect(await readReactiveSnapshot(KIND, CONTENT_ID, row.contentVersion)).toEqual({
      status: 'corrupt',
      reason: 'digest',
    });
  });

  it('document_json 不是合法 JSON → corrupt/json（不抛异常，也不当作 missing）', async () => {
    const broken = '{ not json';
    const row = makeRow({ documentJson: broken, digest: digestOf(broken, JSON.stringify(HOST_DATA)) });
    await insert(row);
    expect(await readReactiveSnapshot(KIND, CONTENT_ID, row.contentVersion)).toEqual({
      status: 'corrupt',
      reason: 'json',
    });
  });

  it('host_data_json 不是合法 JSON → corrupt/json', async () => {
    const brokenHost = '[';
    const row = makeRow({
      hostDataJson: brokenHost,
      digest: digestOf(JSON.stringify(DOCUMENT), brokenHost),
    });
    await insert(row);
    expect(await readReactiveSnapshot(KIND, CONTENT_ID, row.contentVersion)).toEqual({
      status: 'corrupt',
      reason: 'json',
    });
  });

  it('document 缺 nodes 数组 → corrupt/json（形状校验，不是只看能不能 parse）', async () => {
    const noNodes = JSON.stringify({ type: 'document' });
    const row = makeRow({
      documentJson: noNodes,
      digest: digestOf(noNodes, JSON.stringify(HOST_DATA)),
    });
    await insert(row);
    expect(await readReactiveSnapshot(KIND, CONTENT_ID, row.contentVersion)).toEqual({
      status: 'corrupt',
      reason: 'json',
    });
  });

  it('document 是 JSON null → corrupt/json', async () => {
    const nullDoc = 'null';
    const row = makeRow({
      documentJson: nullDoc,
      digest: digestOf(nullDoc, JSON.stringify(HOST_DATA)),
    });
    await insert(row);
    expect(await readReactiveSnapshot(KIND, CONTENT_ID, row.contentVersion)).toEqual({
      status: 'corrupt',
      reason: 'json',
    });
  });
});

describe('reactiveContentVersion —— 版本号的三个输入', () => {
  it('格式 / 语法版本 / 原文任一变化 → 版本变化', () => {
    const base = reactiveContentVersion('reactive', 'local-draft-2', 'abc');
    expect(reactiveContentVersion('markdown', 'local-draft-2', 'abc')).not.toBe(base);
    expect(reactiveContentVersion('reactive', 'local-draft-1', 'abc')).not.toBe(base);
    expect(reactiveContentVersion('reactive', 'local-draft-2', 'abd')).not.toBe(base);
  });

  it('相同输入必须得到相同版本（否则每次读都是 missing）', () => {
    expect(reactiveContentVersion('reactive', 'local-draft-2', 'abc')).toBe(
      reactiveContentVersion('reactive', 'local-draft-2', 'abc'),
    );
  });

  it('syntaxVersion 为 null 与空串**不可混同** —— 前者是「没有语法版本」，后者是一个值', () => {
    expect(reactiveContentVersion('reactive', null, 'abc')).not.toBe(
      reactiveContentVersion('reactive', '', 'abc'),
    );
  });
});
