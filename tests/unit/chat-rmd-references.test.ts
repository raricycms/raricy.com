// ─────────────────────────────────────────────────────────────────────────────
// chat-rmd-references.test.ts —— 聊天 AST 引用适配的兼容矩阵
//
// 覆盖：图床 / 剪贴板（正常、截断、ReactiveMD、未知格式、失败）、投票与收藏夹保持字面量、
// 音频与表情上限、名片取数与失败、代码与链接子树屏蔽、重复资源独立 slot、
// 子剪贴板预算共享与不递归、裸图判定、并发闸门与取消、输入不可变。
// 取数走 stub 的全局 fetch（reference-reader 的默认实现），不触网。
// ─────────────────────────────────────────────────────────────────────────────

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LocalDocument, LocalNode } from 'reactive-md';
import { MAX_AUDIO_REFS, audioUrl } from '@/lib/audio-refs';
import { avatarUrl } from '@/lib/avatar-refs';
import { CLIP_EXPAND_MAX, MAX_IMAGE_REFS, MAX_REF_CONCURRENCY } from '@/lib/content-refs';
import { adaptChatReferences } from '@/lib/chat-rmd/references';
import { CHAT_REF_HOST_TAG } from '@/lib/chat-rmd/reference-types';
import { clearChatReferenceCache } from '@/lib/chat-rmd/reference-reader';
import type { ChatHostData } from '@/lib/chat-rmd/reference-types';
import { MAX_STICKER_REFS } from '@/lib/sticker-refs';
import type { ChatReferenceBudget, ChatReferenceContext } from '@/lib/chat-rmd/types';
import { MAX_USER_REFS } from '@/lib/user-refs';

// 名片缓存挂在 globalThis（页面级），每条用例从空缓存开始，避免上一个用例的
// 已取数结果让本用例的 fetch 计数失真。
beforeEach(() => {
  clearChatReferenceCache();
});

// ── AST fixture ─────────────────────────────────────────────────────────────

let nextNodeId = 0;

function makeNode(
  type: string,
  extra: Partial<LocalNode> = {},
  children?: LocalNode[]
): LocalNode {
  const node: LocalNode = { type, id: `n${nextNodeId++}`, range: { start: 0, end: 0 }, ...extra };
  if (children) node.children = children;
  return node;
}

const text = (value: string): LocalNode => makeNode('text', { value });
const para = (...children: LocalNode[]): LocalNode => makeNode('paragraph', {}, children);
const doc = (...nodes: LocalNode[]): LocalDocument => ({
  syntax: 'local',
  source: '',
  nodes,
  initialState: {},
  bindings: {},
});

function flatten(nodes: LocalNode[]): LocalNode[] {
  return nodes.flatMap((node) => [node, ...flatten(node.children ?? [])]);
}

function hostNodes(document: LocalDocument): LocalNode[] {
  return flatten(document.nodes).filter(
    (node) => node.type === 'hostComponent' && node.name === CHAT_REF_HOST_TAG
  );
}

function hostDataOf(
  result: { hostData: Record<string, unknown> },
  node: LocalNode
): ChatHostData {
  const slot = node.attrs?.slot;
  expect(slot).toBeTruthy();
  return result.hostData[slot as string] as ChatHostData;
}

// ── context / fetch ─────────────────────────────────────────────────────────

const defaultCompileChild = async (_source: string, _signal: AbortSignal) =>
  doc(para(text('子文档')));

type ContextOverrides = Partial<Omit<ChatReferenceContext, 'budget'>> & {
  budget?: Partial<ChatReferenceBudget>;
};

function makeContext(overrides: ContextOverrides = {}): ChatReferenceContext {
  const {
    budget: budgetOverride,
    signal,
    compileChild,
    ...rest
  } = overrides;
  return {
    viewerScope: 'viewer-1',
    depth: 0,
    ...rest,
    signal: signal ?? new AbortController().signal,
    compileChild: compileChild ?? defaultCompileChild,
    budget: {
      images: MAX_IMAGE_REFS,
      audio: MAX_AUDIO_REFS,
      stickers: MAX_STICKER_REFS,
      users: MAX_USER_REFS,
      clipboard: 1,
      ...budgetOverride,
    },
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function clipboardResponse(content: string, format?: unknown): Response {
  const clip = format === undefined ? { content } : { content, format };
  return jsonResponse({ code: 200, message: 'ok', clip });
}

function userResponse(id: string, username: string, frameUrl: string | null = null): Response {
  return jsonResponse({ code: 200, message: 'ok', user: { id, username, frameUrl } });
}

function stubFetch(map: Record<string, () => Response | Promise<Response>>) {
  const mock = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    const handler = map[url];
    if (!handler) throw new Error(`unexpected fetch: ${url}`);
    return handler();
  });
  vi.stubGlobal('fetch', mock);
  return mock;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

// ── 图床 ────────────────────────────────────────────────────────────────────

describe('10 位图床引用', () => {
  it('每处独立 slot，URL 走 raw 路由，输入与结果互不共享', async () => {
    const input = doc(para(text('前 [@AbCdEf1234] 中 [@AbCdEf1234] 后')));
    const before = JSON.stringify(input);
    const result = await adaptChatReferences(input, makeContext());

    expect(JSON.stringify(input)).toBe(before);
    const hosts = hostNodes(result.document);
    expect(hosts).toHaveLength(2);
    const slots = hosts.map((node) => node.attrs?.slot);
    expect(new Set(slots).size).toBe(2);
    for (const node of hosts) {
      expect(node.attrs).toEqual({ slot: node.attrs?.slot });
      expect(hostDataOf(result, node)).toMatchObject({
        kind: 'image',
        token: '[@AbCdEf1234]',
        imageId: 'AbCdEf1234',
        url: '/api/images/AbCdEf1234/raw',
      });
    }
    expect(result.bareImageCandidateSlot).toBeNull();
    expect(() => structuredClone(result)).not.toThrow();

    // 返回值是深拷贝：改结果不会伤到输入。
    result.document.nodes.length = 0;
    expect(JSON.stringify(input)).toBe(before);
  });

  it('超过 MAX_IMAGE_REFS 的部分保留字面量', async () => {
    const token = '[@AbCdEf1234]';
    const input = doc(para(text(Array.from({ length: MAX_IMAGE_REFS + 1 }, () => token).join(' '))));
    const result = await adaptChatReferences(input, makeContext());
    expect(hostNodes(result.document)).toHaveLength(MAX_IMAGE_REFS);
    expect(JSON.stringify(result.document)).toContain(token);
  });
});

// ── 剪贴板 ──────────────────────────────────────────────────────────────────

describe('8 位剪贴板引用', () => {
  it('只展开首条，Markdown 子文档独立编译；子剪贴板不递归', async () => {
    const childSource = '子正文 [@AbCd5678] [@AbCdEf1234] [@猫猫/开心]';
    const compileChild = vi.fn(async (_source: string, _signal: AbortSignal) =>
      doc(para(text(childSource)))
    );
    const fetchMock = stubFetch({
      '/api/clipboard/AbCd1234': () => clipboardResponse(childSource, 'markdown'),
    });
    const input = doc(para(text('看 [@AbCd1234] 和 [@AbCd5678]')));
    const result = await adaptChatReferences(
      input,
      makeContext({ compileChild, budget: { clipboard: 1 } })
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(compileChild).toHaveBeenCalledTimes(1);
    expect(compileChild.mock.calls[0][0]).toBe(childSource);

    const hosts = hostNodes(result.document);
    expect(hosts).toHaveLength(1);
    const data = hostDataOf(result, hosts[0]);
    expect(data.kind).toBe('clipboard');
    if (data.kind !== 'clipboard') throw new Error('unreachable');
    expect(data.error).toBeUndefined();
    expect(data.href).toBe('/clipboard/AbCd1234');
    expect(data.document).toBeTruthy();

    // 子文档里：8 位剪贴板保持字面量，图床与表情继续展开，slot 共用父 hostData。
    const childText = JSON.stringify(data.document?.nodes);
    expect(childText).toContain('[@AbCd5678]');
    const childHosts = hostNodes(data.document as LocalDocument);
    expect(childHosts.map((node) => hostDataOf(result, node).kind).sort()).toEqual([
      'image',
      'sticker',
    ]);
    // 父正文的第二个剪贴板 token 保持字面量。
    expect(JSON.stringify(result.document)).toContain('[@AbCd5678]');
  });

  it('超过 2000 字截断后再编译，并给回链', async () => {
    const content = '甲'.repeat(CLIP_EXPAND_MAX + 20);
    const compileChild = vi.fn(async (_source: string, _signal: AbortSignal) =>
      doc(para(text('截断后的子文档')))
    );
    stubFetch({ '/api/clipboard/AbCd1234': () => clipboardResponse(content) });
    const result = await adaptChatReferences(
      doc(para(text('[@AbCd1234]'))),
      makeContext({ compileChild })
    );

    expect(compileChild.mock.calls[0][0]).toHaveLength(CLIP_EXPAND_MAX);
    const data = hostDataOf(result, hostNodes(result.document)[0]);
    if (data.kind !== 'clipboard') throw new Error('unreachable');
    expect(data.truncated).toBe(true);
    expect(data.href).toBe('/clipboard/AbCd1234');
    expect(data.document).toBeTruthy();
  });

  it('ReactiveMD 剪贴板与 Markdown 走同一子编译路径，子剪贴板不递归', async () => {
    const childSource = '# 标题\n\n带引用 [@AbCd5678] [@AbCdEf1234]';
    const compileChild = vi.fn(async (_source: string, _signal: AbortSignal) =>
      doc(
        para(text('RMD 子文档 [@AbCd5678] [@AbCdEf1234]')),
        // Worker 对不支持组件的局部降级节点：原样接受，不影响父消息。
        makeNode('fallback', { value: '坏组件' })
      )
    );
    stubFetch({
      '/api/clipboard/AbCd1234': () => clipboardResponse(childSource, 'reactive'),
    });
    const result = await adaptChatReferences(
      doc(para(text('看 [@AbCd1234]'))),
      makeContext({ compileChild, budget: { images: 0 } })
    );

    expect(compileChild).toHaveBeenCalledTimes(1);
    expect(compileChild.mock.calls[0][0]).toBe(childSource);

    const data = hostDataOf(result, hostNodes(result.document)[0]);
    if (data.kind !== 'clipboard') throw new Error('unreachable');
    expect(data.error).toBeUndefined();
    expect(data.href).toBe('/clipboard/AbCd1234');
    expect(data.document).toBeTruthy();

    // 子文档里的 8 位剪贴板 token 保持字面量（不递归），图床受父消息 images=0 约束；
    // Worker 的局部 fallback 节点原样保留在子文档里。
    const childText = JSON.stringify(data.document?.nodes);
    expect(childText).toContain('[@AbCd5678]');
    expect(childText).toContain('[@AbCdEf1234]');
    expect(childText).toContain('坏组件');
    expect(hostNodes(data.document as LocalDocument)).toHaveLength(0);
  });

  it('库内认不出的格式只给站内回链，不把整篇正文带进聊天', async () => {
    for (const format of [null, 'html'] as const) {
      stubFetch({
        '/api/clipboard/AbCd1234': () =>
          clipboardResponse('<secret> [@AbCdEf1234]', format),
      });
      const compileChild = vi.fn(async () => doc(para(text('不应编译'))));
      const result = await adaptChatReferences(
        doc(para(text('[@AbCd1234]'))),
        makeContext({ compileChild })
      );
      expect(compileChild).not.toHaveBeenCalled();
      const data = hostDataOf(result, hostNodes(result.document)[0]);
      expect(data.kind).toBe('clipboard');
      if (data.kind !== 'clipboard') throw new Error('unreachable');
      expect(data.error).toBe('format');
      expect(data.href).toBe('/clipboard/AbCd1234');
      expect(data.document).toBeUndefined();
      // 失败态不携带服务端私密内容。
      expect(JSON.stringify(data)).not.toContain('secret');
      expect(JSON.stringify(data)).not.toContain('title');
      vi.unstubAllGlobals();
    }
  });

  it('子编译返回 null / 抛错时退回收链卡片，不塞半截文档', async () => {
    const failing: Array<ChatReferenceContext['compileChild']> = [
      vi.fn(async (_source: string, _signal: AbortSignal) => null),
      vi.fn(async (_source: string, _signal: AbortSignal): Promise<LocalDocument | null> => {
        throw new Error('worker compile failed');
      }),
    ];
    for (const compileChild of failing) {
      stubFetch({
        '/api/clipboard/AbCd1234': () => clipboardResponse('RMD 正文', 'reactive'),
      });
      const result = await adaptChatReferences(
        doc(para(text('[@AbCd1234]'))),
        makeContext({ compileChild })
      );
      const data = hostDataOf(result, hostNodes(result.document)[0]);
      if (data.kind !== 'clipboard') throw new Error('unreachable');
      expect(data.error).toBeUndefined();
      expect(data.document).toBeUndefined();
      expect(data.href).toBe('/clipboard/AbCd1234');
      expect(JSON.stringify(result.document)).not.toContain('RMD 正文');
      vi.unstubAllGlobals();
    }
  });

  it('ReactiveMD 剪贴板同样只展开首条并共享预算', async () => {
    const compileChild = vi.fn(async (_source: string, _signal: AbortSignal) =>
      doc(para(text('[@AbCdEf1234]')))
    );
    stubFetch({ '/api/clipboard/AbCd1234': () => clipboardResponse('子', 'reactive') });
    const result = await adaptChatReferences(
      doc(para(text('[@AbCd1234] [@AbCd5678]'))),
      makeContext({ compileChild, budget: { clipboard: 1, images: 0 } })
    );
    const hosts = hostNodes(result.document);
    expect(hosts).toHaveLength(1);
    // 第二条剪贴板保持字面量。
    expect(JSON.stringify(result.document)).toContain('[@AbCd5678]');
    // 子文档复用父消息已用尽的图床额度。
    const data = hostDataOf(result, hosts[0]);
    if (data.kind !== 'clipboard') throw new Error('unreachable');
    expect(JSON.stringify(data.document?.nodes)).toContain('[@AbCdEf1234]');
  });

  it('404 / 403 / 网络失败分别降级，且后续剪贴板 token 不再展开', async () => {
    const cases: Array<{
      status: number | 'throw';
      error: 'missing' | 'forbidden' | 'fallback';
    }> = [
      { status: 404, error: 'missing' },
      { status: 403, error: 'forbidden' },
      { status: 'throw', error: 'fallback' },
    ];
    for (const { status, error } of cases) {
      stubFetch({
        '/api/clipboard/AbCd1234': () => {
          if (status === 'throw') throw new Error('network down');
          return jsonResponse({ code: status, message: 'failed' }, status);
        },
      });
      const result = await adaptChatReferences(
        doc(para(text('[@AbCd1234] [@AbCd5678]'))),
        makeContext()
      );
      const hosts = hostNodes(result.document);
      expect(hosts).toHaveLength(1);
      const data = hostDataOf(result, hosts[0]);
      if (error === 'fallback') {
        expect(data).toMatchObject({ kind: 'fallback', token: '[@AbCd1234]' });
      } else {
        expect(data).toMatchObject({ kind: 'clipboard', error, href: '/clipboard/AbCd1234' });
      }
      expect(JSON.stringify(result.document)).toContain('[@AbCd5678]');
      vi.unstubAllGlobals();
    }
  });
});

// ── 保持字面量的其他数字 id ──────────────────────────────────────────────────

describe('9 位投票与 6 位收藏夹', () => {
  it('保持字面量，不发请求也不产生宿主节点', async () => {
    const fetchMock = stubFetch({});
    const input = doc(para(text('[@123456789] [@123456]')));
    const result = await adaptChatReferences(input, makeContext());
    expect(fetchMock).not.toHaveBeenCalled();
    expect(hostNodes(result.document)).toHaveLength(0);
    expect(JSON.stringify(result.document)).toContain('[@123456789]');
    expect(JSON.stringify(result.document)).toContain('[@123456]');
  });
});

// ── 音频 / 表情 ─────────────────────────────────────────────────────────────

describe('音频与表情', () => {
  it('音频上限 3，超出保留 token；重复引用各自独立 slot', async () => {
    const token = '[@音频/abcdefghij]';
    const input = doc(para(text(Array.from({ length: MAX_AUDIO_REFS + 1 }, () => token).join(' '))));
    const result = await adaptChatReferences(input, makeContext());
    const hosts = hostNodes(result.document);
    expect(hosts).toHaveLength(MAX_AUDIO_REFS);
    expect(new Set(hosts.map((node) => node.attrs?.slot)).size).toBe(MAX_AUDIO_REFS);
    expect(hostDataOf(result, hosts[0])).toMatchObject({
      kind: 'audio',
      token,
      url: audioUrl('abcdefghij'),
    });
    expect(JSON.stringify(result.document)).toContain(token);
  });

  it('表情与黄脸共用一个 30 的预算，黄脸走静态清单并保留命名空间', async () => {
    const sticker = '[@猫猫/开心]';
    const emoji = '[@黄脸/微笑]';
    const all = [
      ...Array.from({ length: MAX_STICKER_REFS / 2 }, () => sticker),
      ...Array.from({ length: MAX_STICKER_REFS / 2 + 1 }, () => emoji),
    ];
    const result = await adaptChatReferences(doc(para(text(all.join(' ')))), makeContext());
    const hosts = hostNodes(result.document);
    expect(hosts).toHaveLength(MAX_STICKER_REFS);
    const data = hosts.map((node) => hostDataOf(result, node));
    const stickerData = data.filter((item) => item.kind === 'sticker' && !item.emoji);
    const emojiData = data.filter((item) => item.kind === 'sticker' && item.emoji);
    expect(stickerData).toHaveLength(MAX_STICKER_REFS / 2);
    expect(emojiData).toHaveLength(MAX_STICKER_REFS / 2);
    expect(stickerData[0]).toMatchObject({
      token: sticker,
      url: '/api/stickers/%E7%8C%AB%E7%8C%AB/%E5%BC%80%E5%BF%83',
    });
    expect(emojiData[0]).toMatchObject({
      token: emoji,
      url: '/static/emoji/1f60a.svg',
    });
    expect(JSON.stringify(result.document)).toContain(emoji);
  });

  it('清单外的黄脸名字、含空白的合集名与保留命名空间都按规则处理', async () => {
    const fetchMock = stubFetch({
      '/api/users/user01': () => userResponse('id-user01', 'user01'),
    });
    const result = await adaptChatReferences(
      doc(
        para(
          text(
            '[@黄脸/不存在] [@猫 猫/开心] [@音频/abcdefghij] [@用户/user01] [@猫猫/难过]'
          )
        )
      ),
      makeContext()
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const kinds = hostNodes(result.document).map((node) => hostDataOf(result, node).kind).sort();
    expect(kinds).toEqual(['audio', 'sticker', 'user']);
    expect(JSON.stringify(result.document)).toContain('[@黄脸/不存在]');
    expect(JSON.stringify(result.document)).toContain('[@猫 猫/开心]');
  });
});

// ── 名片 ────────────────────────────────────────────────────────────────────

describe('用户名片', () => {
  it('最多 5 个位置、按名字去重取数，只使用公开字段', async () => {
    const names = ['user01', 'user02', 'user03', 'user04', 'user05', 'user06'];
    const fetchMock = stubFetch(
      Object.fromEntries(
        names.map((name) => [
          `/api/users/${name}`,
          () => userResponse(`id-${name}`, name, null),
        ])
      )
    );
    const input = doc(
      para(text(names.map((name) => `[@用户/${name}]`).join(' ')))
    );
    const result = await adaptChatReferences(input, makeContext());
    const hosts = hostNodes(result.document);
    expect(hosts).toHaveLength(MAX_USER_REFS);
    expect(fetchMock).toHaveBeenCalledTimes(MAX_USER_REFS);
    expect(fetchMock).not.toHaveBeenCalledWith('/api/users/user06', expect.anything());
    const first = hostDataOf(result, hosts[0]);
    expect(first).toEqual({
      kind: 'user',
      slot: expect.any(String),
      token: '[@用户/user01]',
      user: {
        id: 'id-user01',
        username: 'user01',
        avatar_url: avatarUrl('id-user01'),
        frame_url: null,
      },
    });
    expect(JSON.stringify(result.document)).toContain('[@用户/user06]');
  });

  it('取数失败回 token 且不占预算，中文名字按 URL 编码请求', async () => {
    const fetchMock = stubFetch({
      '/api/users/%E5%BC%A0%E4%B8%89%E4%B8%B0': () =>
        jsonResponse({ code: 200, message: 'ok', user: { id: 'id-zhang', username: '张三丰', frameUrl: '/static/frames/a.svg' } }),
      '/api/users/missing1': () => jsonResponse({ code: 404, message: '用户不存在' }, 404),
    });
    const input = doc(
      para(text('[@用户/missing1] [@用户/张三丰] [@用户/张三丰]'))
    );
    const result = await adaptChatReferences(input, makeContext());

    expect(fetchMock).toHaveBeenCalledTimes(2); // 失败名一次 + 张三丰去重后一次
    const hosts = hostNodes(result.document);
    expect(hosts).toHaveLength(2);
    for (const node of hosts) {
      expect(hostDataOf(result, node)).toMatchObject({
        kind: 'user',
        token: '[@用户/张三丰]',
        user: { id: 'id-zhang', username: '张三丰', frame_url: '/static/frames/a.svg' },
      });
    }
    expect(new Set(hosts.map((node) => node.attrs?.slot)).size).toBe(2);
    expect(JSON.stringify(result.document)).toContain('[@用户/missing1]');
  });

  it('代码 / 链接里的名字不占取数预算', async () => {
    const fetchMock = stubFetch({
      '/api/users/visible1': () => userResponse('id-visible', 'visible1'),
    });
    const input = doc(
      makeNode('code', { value: '[@用户/code0001] [@用户/code0002]' }),
      para(makeNode('link', { url: 'https://example.com' }, [makeNode('emphasis', {}, [text('[@用户/linked01]')])])),
      para(text('[@用户/visible1]'))
    );
    const result = await adaptChatReferences(input, makeContext());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(hostNodes(result.document)).toHaveLength(1);
  });
});

// ── 屏蔽结构 ────────────────────────────────────────────────────────────────

describe('代码 / 链接 / fallback 子树', () => {
  it('这些结构里的 token 全是字面量，不取数也不占预算', async () => {
    const fetchMock = stubFetch({});
    const input = doc(
      makeNode('code', { value: '[@AbCdEf1236] [@AbCdEf1235]' }), // 代码在最前，预算只有 1
      para(makeNode('inlineCode', { value: '[@AbCdEf1235]' })),
      para(makeNode('link', { url: '/x' }, [makeNode('strong', {}, [text('[@AbCdEf1237]')])])),
      para(makeNode('fallback', { value: '[@AbCdEf1238]' })),
      para(makeNode('div', {}, [text('[@AbCdEf1239]')])),
      para(text('[@AbCdEf1234]')) // 唯一应该展开的可见 token
    );
    const before = JSON.stringify(input);
    const result = await adaptChatReferences(input, makeContext({ budget: { images: 1 } }));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(hostNodes(result.document)).toHaveLength(1);
    expect(JSON.stringify(input)).toBe(before);
    const rendered = JSON.stringify(result.document.nodes);
    for (const id of ['1235', '1236', '1237', '1238', '1239']) {
      expect(rendered).toContain(`[@AbCdEf${id}]`);
    }
  });
});

// ── 预算共享 ────────────────────────────────────────────────────────────────

describe('子剪贴板与父消息共享预算', () => {
  it('父正文用尽的图床 / 音频 / 表情额度不会被子的内容突破', async () => {
    const child = doc(para(text('[@AbCdEf1235] [@音频/abcdefghik] [@猫猫/难过]')));
    const compileChild = vi.fn(async () => child);
    stubFetch({ '/api/clipboard/AbCd1234': () => clipboardResponse('子', 'markdown') });
    const result = await adaptChatReferences(
      doc(para(text('[@AbCdEf1234] [@音频/abcdefghij] [@猫猫/开心] [@AbCd1234]'))),
      makeContext({
        compileChild,
        budget: { images: 1, audio: 1, stickers: 1, clipboard: 1, users: 0 },
      })
    );
    const clip = hostDataOf(result, hostNodes(result.document)[3]);
    if (clip.kind !== 'clipboard') throw new Error('unreachable');
    const childText = JSON.stringify(clip.document?.nodes);
    expect(childText).toContain('[@AbCdEf1235]');
    expect(childText).toContain('[@音频/abcdefghik]');
    expect(childText).toContain('[@猫猫/难过]');
  });

  it('子文档可使用父消息剩余的额度', async () => {
    const compileChild = vi.fn(async () => doc(para(text('[@AbCdEf1235]'))));
    stubFetch({ '/api/clipboard/AbCd1234': () => clipboardResponse('子', 'markdown') });
    const result = await adaptChatReferences(
      doc(para(text('[@AbCdEf1234] [@AbCd1234]'))),
      makeContext({ compileChild, budget: { images: 2, clipboard: 1 } })
    );
    const hosts = hostNodes(result.document);
    expect(hosts).toHaveLength(2);
    const clip = hostDataOf(result, hosts[1]);
    if (clip.kind !== 'clipboard') throw new Error('unreachable');
    expect(hostNodes(clip.document as LocalDocument)).toHaveLength(1);
  });

  it('子剪贴板不再递归展开剪贴板', async () => {
    const compileChild = vi.fn(async (_source: string, _signal: AbortSignal) =>
      doc(para(text('[@AbCd5678]')))
    );
    const fetchMock = stubFetch({
      '/api/clipboard/AbCd1234': () => clipboardResponse('子', 'markdown'),
    });
    const result = await adaptChatReferences(
      doc(para(text('[@AbCd1234]'))),
      makeContext({ compileChild })
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const clip = hostDataOf(result, hostNodes(result.document)[0]);
    if (clip.kind !== 'clipboard') throw new Error('unreachable');
    expect(JSON.stringify(clip.document?.nodes)).toContain('[@AbCd5678]');
    expect(hostNodes(clip.document as LocalDocument)).toHaveLength(0);
  });

  it('子剪贴板的名片沿用父消息已取数范围，不新增请求', async () => {
    const compileChild = vi.fn(async (_source: string, _signal: AbortSignal) =>
      doc(para(text('[@用户/user01] [@用户/user02]')))
    );
    const fetchMock = stubFetch({
      '/api/users/user01': () => userResponse('id-user01', 'user01'),
      '/api/clipboard/AbCd1234': () => clipboardResponse('子', 'markdown'),
    });
    const result = await adaptChatReferences(
      doc(para(text('[@用户/user01] [@AbCd1234]'))),
      makeContext({ compileChild })
    );

    expect(fetchMock).toHaveBeenCalledTimes(2); // user01 + 剪贴板；user02 没有请求
    const clipHost = hostNodes(result.document).find(
      (node) => hostDataOf(result, node).kind === 'clipboard'
    );
    const clip = hostDataOf(result, clipHost as LocalNode);
    if (clip.kind !== 'clipboard') throw new Error('unreachable');
    const childHosts = hostNodes(clip.document as LocalDocument);
    expect(childHosts).toHaveLength(1);
    expect(hostDataOf(result, childHosts[0])).toMatchObject({
      kind: 'user',
      token: '[@用户/user01]',
    });
    expect(JSON.stringify(clip.document?.nodes)).toContain('[@用户/user02]');
  });
});

// ── 裸图 ────────────────────────────────────────────────────────────────────

describe('裸图候选', () => {
  it('仅一张图床图片、无其他有意义正文时为候选（允许强调 / 换行包裹）', async () => {
    const result = await adaptChatReferences(
      doc(
        para(
          text('  '),
          makeNode('strong', {}, [text('[@AbCdEf1234]')]),
          makeNode('break')
        )
      ),
      makeContext()
    );
    const host = hostNodes(result.document)[0];
    expect(result.bareImageCandidateSlot).toBe(host.attrs?.slot);
    expect(result.bareImageCandidateSlot).toBe(
      (hostDataOf(result, host) as { slot: string }).slot
    );
  });

  it('额外正文、两张图、其他引用或块结构都取消候选', async () => {
    const imageToken = '[@AbCdEf1234]';
    const cases: LocalDocument[] = [
      doc(para(text(`图：${imageToken}`))),
      doc(para(text(`${imageToken} ${imageToken}`))),
      doc(para(text(`${imageToken} [@音频/abcdefghij]`))),
      doc(para(text(imageToken)), para(text('还有正文'))),
      doc(makeNode('heading', {}, [text(imageToken)])),
      doc(makeNode('list', {}, [makeNode('listItem', {}, [para(text(imageToken))])])),
    ];
    for (const input of cases) {
      const result = await adaptChatReferences(input, makeContext());
      expect(result.bareImageCandidateSlot).toBeNull();
    }
  });
});

// ── 并发 / 取消 ─────────────────────────────────────────────────────────────

describe('取数并发与取消', () => {
  it('同一次适配的在飞请求不超过 MAX_REF_CONCURRENCY，同名只取一次', async () => {
    const names = ['user01', 'user02', 'user03', 'user04', 'user05'];
    let active = 0;
    let maxActive = 0;
    const pending: Array<() => void> = [];

    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      active += 1;
      maxActive = Math.max(maxActive, active);
      return new Promise<Response>((resolve) => {
        pending.push(() => {
          active -= 1;
          if (url.startsWith('/api/users/')) {
            const name = url.slice('/api/users/'.length);
            resolve(userResponse(`id-${name}`, name));
          } else {
            resolve(clipboardResponse('子', 'markdown'));
          }
        });
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const input = doc(
      para(text([...names, names[0]].map((name) => `[@用户/${name}]`).join(' ') + ' [@AbCd1234]'))
    );
    const promise = adaptChatReferences(input, makeContext());

    await vi.waitFor(() => expect(pending.length).toBe(MAX_REF_CONCURRENCY));
    expect(maxActive).toBeLessThanOrEqual(MAX_REF_CONCURRENCY);
    while (pending.length) {
      pending.shift()?.();
      await tick();
    }
    await promise;
    expect(maxActive).toBe(MAX_REF_CONCURRENCY);
    // 5 个不同名字 + 1 条剪贴板；重复的 user01 不再发请求。
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  it('已取消的信号不取数、返回未适配结果', async () => {
    const fetchMock = stubFetch({});
    const controller = new AbortController();
    controller.abort();
    const input = doc(para(text('[@AbCdEf1234] [@用户/user01]')));
    const result = await adaptChatReferences(input, makeContext({ signal: controller.signal }));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.hostData).toEqual({});
    expect(hostNodes(result.document)).toHaveLength(0);
    expect(result.bareImageCandidateSlot).toBeNull();
  });

  it('取数中途取消时不落任何半套宿主数据', async () => {
    const controller = new AbortController();
    let rejectFetch: ((reason?: unknown) => void) | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_input: RequestInfo | URL, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            rejectFetch = reject;
            init?.signal?.addEventListener('abort', () => {
              reject(new DOMException('Aborted', 'AbortError'));
            });
          })
      )
    );
    const input = doc(para(text('[@AbCdEf1234] [@用户/user01]')));
    const promise = adaptChatReferences(input, makeContext({ signal: controller.signal }));
    await vi.waitFor(() => expect(rejectFetch).toBeTypeOf('function'));
    controller.abort();
    const result = await promise;
    expect(result.hostData).toEqual({});
    expect(hostNodes(result.document)).toHaveLength(0);
    expect(JSON.stringify(result.document)).toContain('[@AbCdEf1234]');
    expect(JSON.stringify(result.document)).toContain('[@用户/user01]');
  });
});

// ── 不可变 ──────────────────────────────────────────────────────────────────

describe('不可变输入 / 缓存安全', () => {
  it('子编译返回的文档被复制，适配与调用方都不会改到编译缓存', async () => {
    const child = doc(para(text('[@AbCdEf1234]')));
    const before = JSON.stringify(child);
    stubFetch({ '/api/clipboard/AbCd1234': () => clipboardResponse('子', 'markdown') });
    const result = await adaptChatReferences(
      doc(para(text('[@AbCd1234]'))),
      makeContext({ compileChild: async () => child })
    );
    const clip = hostDataOf(result, hostNodes(result.document)[0]);
    if (clip.kind !== 'clipboard') throw new Error('unreachable');
    expect(hostNodes(clip.document as LocalDocument)).toHaveLength(1);
    expect(JSON.stringify(child)).toBe(before);
    // 改适配结果里的子文档不会反向污染 compileChild 的返回值。
    (clip.document as LocalDocument).nodes.length = 0;
    expect(JSON.stringify(child)).toBe(before);
  });
});