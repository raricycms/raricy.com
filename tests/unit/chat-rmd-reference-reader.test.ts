// ─────────────────────────────────────────────────────────────────────────────
// chat-rmd-reference-reader.test.ts —— 聊天引用取数的 URL / 状态码 / 取消口径
//
// 只测 reference-reader 本身：fetch 全部注入，不触网、不碰剪贴板或用户库。
// ─────────────────────────────────────────────────────────────────────────────

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearChatReferenceCache,
  createChatReferenceReader,
} from '@/lib/chat-rmd/reference-reader';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function liveSignal(): AbortSignal {
  return new AbortController().signal;
}

beforeEach(() => {
  // 名片缓存挂在 globalThis（跨 reader 共享），用例之间必须清干净。
  clearChatReferenceCache();
});

function fetchRecorder(handler: (url: string) => Response | Promise<Response>) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.toString();
    calls.push({ url, init: init ?? undefined });
    return handler(url);
  };
  return { fetchImpl, calls };
}

describe('readClipboard', () => {
  it('同源读取；缺省 format 沿用 Markdown 兼容', async () => {
    const { fetchImpl, calls } = fetchRecorder(() =>
      jsonResponse({ code: 200, message: 'ok', clip: { content: '正文' } })
    );
    const reader = createChatReferenceReader({ fetchImpl });
    const signal = liveSignal();
    const result = await reader.readClipboard('AbCd1234', signal);

    expect(result).toEqual({ status: 'ready', content: '正文', format: 'markdown' });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('/api/clipboard/AbCd1234');
    expect(calls[0].init?.credentials).toBe('same-origin');
    expect(calls[0].init?.signal).toBe(signal);
  });

  it('显式 markdown / reactive 原样保留，null 与未知值归为 unknown', async () => {
    const cases: Array<[unknown, string]> = [
      ['markdown', 'markdown'],
      ['reactive', 'reactive'],
      [null, 'unknown'],
      ['html', 'unknown'],
    ];
    for (const [format, expected] of cases) {
      const { fetchImpl } = fetchRecorder(() =>
        jsonResponse({ code: 200, message: 'ok', clip: { content: 'x', format } })
      );
      const reader = createChatReferenceReader({ fetchImpl });
      expect(await reader.readClipboard('AbCd1234', liveSignal())).toEqual({
        status: 'ready',
        content: 'x',
        format: expected,
      });
    }
  });

  it('401 / 403 = forbidden，404 = missing，其余状态 = error', async () => {
    const cases: Array<[number, string]> = [
      [401, 'forbidden'],
      [403, 'forbidden'],
      [404, 'missing'],
      [500, 'error'],
    ];
    for (const [status, expected] of cases) {
      const { fetchImpl } = fetchRecorder(() =>
        jsonResponse({ code: status, message: 'x' }, status)
      );
      const reader = createChatReferenceReader({ fetchImpl });
      expect(await reader.readClipboard('AbCd1234', liveSignal())).toEqual({
        status: expected,
      });
    }
  });

  it('响应形状不符 / 非 JSON / 网络异常都降级为 error', async () => {
    const bodies: Array<unknown> = [
      {},
      { clip: { content: 123 } },
      { clip: null },
    ];
    for (const body of bodies) {
      const { fetchImpl } = fetchRecorder(() => jsonResponse(body));
      const reader = createChatReferenceReader({ fetchImpl });
      expect(await reader.readClipboard('AbCd1234', liveSignal())).toEqual({ status: 'error' });
    }

    const badJson = createChatReferenceReader({
      fetchImpl: async () => new Response('not json', { status: 200 }),
    });
    expect(await badJson.readClipboard('AbCd1234', liveSignal())).toEqual({ status: 'error' });

    const network = createChatReferenceReader({
      fetchImpl: async () => {
        throw new Error('offline');
      },
    });
    expect(await network.readClipboard('AbCd1234', liveSignal())).toEqual({ status: 'error' });
  });

  it('已取消的信号不发请求；等待中被取消同样返回 error', async () => {
    const pre = fetchRecorder(() => jsonResponse({}));
    const reader = createChatReferenceReader({ fetchImpl: pre.fetchImpl });
    const controller = new AbortController();
    controller.abort();
    expect(await reader.readClipboard('AbCd1234', controller.signal)).toEqual({
      status: 'error',
    });
    expect(pre.calls).toHaveLength(0);

    const pendingController = new AbortController();
    const pending = createChatReferenceReader({
      fetchImpl: (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('Aborted', 'AbortError'));
          });
        }),
    });
    const promise = pending.readClipboard('AbCd1234', pendingController.signal);
    pendingController.abort();
    expect(await promise).toEqual({ status: 'error' });
  });

  it('不缓存：同一个 id 读两次会发两次请求', async () => {
    const { fetchImpl, calls } = fetchRecorder(() =>
      jsonResponse({ code: 200, message: 'ok', clip: { content: 'x' } })
    );
    const reader = createChatReferenceReader({ fetchImpl });
    await reader.readClipboard('AbCd1234', liveSignal());
    await reader.readClipboard('AbCd1234', liveSignal());
    expect(calls).toHaveLength(2);
  });
});

describe('readUserCard', () => {
  it('按用户名取公开字段，中文名字编码进 URL', async () => {
    const { fetchImpl, calls } = fetchRecorder(() =>
      jsonResponse({
        code: 200,
        message: 'ok',
        user: { id: 'id-zhang', username: '张三丰', frameUrl: '/static/frames/a.svg' },
      })
    );
    const reader = createChatReferenceReader({ fetchImpl });
    const result = await reader.readUserCard('张三丰', liveSignal());

    expect(result).toEqual({
      status: 'ready',
      card: { id: 'id-zhang', username: '张三丰', frameUrl: '/static/frames/a.svg' },
    });
    expect(calls[0].url).toBe('/api/users/%E5%BC%A0%E4%B8%89%E4%B8%B0');
    expect(calls[0].init?.credentials).toBe('same-origin');
  });

  it('frameUrl 非字符串按 null；缺 id / username 归为 error', async () => {
    const cases: Array<[unknown, unknown]> = [
      [{ id: 'u1', username: 'user01', frameUrl: null }, 'ready'],
      [{ id: 'u1', username: 'user01' }, 'ready'],
      [{ username: 'user01' }, 'error'],
      [{ id: 'u1' }, 'error'],
      [null, 'error'],
    ];
    for (const [user, expected] of cases) {
      const { fetchImpl } = fetchRecorder(() =>
        jsonResponse({ code: 200, message: 'ok', user })
      );
      const reader = createChatReferenceReader({ fetchImpl });
      const result = await reader.readUserCard('user01', liveSignal());
      expect(result.status).toBe(expected);
      if (expected === 'ready') {
        expect(result).toMatchObject({ card: { frameUrl: null } });
      }
    }
  });

  it('403 / 404 / 5xx 与网络异常分别降级', async () => {
    const cases: Array<[number, string]> = [
      [403, 'forbidden'],
      [404, 'missing'],
      [500, 'error'],
    ];
    for (const [status, expected] of cases) {
      const { fetchImpl } = fetchRecorder(() =>
        jsonResponse({ code: status, message: 'x' }, status)
      );
      const reader = createChatReferenceReader({ fetchImpl });
      expect(await reader.readUserCard('user01', liveSignal())).toEqual({
        status: expected,
      });
    }

    const network = createChatReferenceReader({
      fetchImpl: async () => {
        throw new Error('offline');
      },
    });
    expect(await network.readUserCard('user01', liveSignal())).toEqual({ status: 'error' });
  });

  it('已取消的信号不发请求', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const reader = createChatReferenceReader({ fetchImpl });
    const controller = new AbortController();
    controller.abort();
    expect(await reader.readUserCard('user01', controller.signal)).toEqual({
      status: 'error',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('同一 viewerScope 跨 reader 共享缓存，不同 scope 隔离，清理后重新取', async () => {
    const { fetchImpl, calls } = fetchRecorder(() =>
      jsonResponse({ code: 200, message: 'ok', user: { id: 'u1', username: 'user01' } })
    );

    await createChatReferenceReader({ fetchImpl, viewerScope: 'viewer-a' })
      .readUserCard('user01', liveSignal());
    await createChatReferenceReader({ fetchImpl, viewerScope: 'viewer-a' })
      .readUserCard('user01', liveSignal());
    expect(calls).toHaveLength(1);

    await createChatReferenceReader({ fetchImpl, viewerScope: 'viewer-b' })
      .readUserCard('user01', liveSignal());
    expect(calls).toHaveLength(2);

    clearChatReferenceCache('viewer-a');
    await createChatReferenceReader({ fetchImpl, viewerScope: 'viewer-a' })
      .readUserCard('user01', liveSignal());
    expect(calls).toHaveLength(3);
  });

  it('失败不缓存：权限恢复后下一次重新取', async () => {
    let status = 403;
    const { fetchImpl, calls } = fetchRecorder(() =>
      status === 200
        ? jsonResponse({ code: 200, message: 'ok', user: { id: 'u1', username: 'user01' } })
        : jsonResponse({ code: status, message: 'x' }, status)
    );
    const reader = createChatReferenceReader({ fetchImpl, viewerScope: 'viewer-a' });
    expect(await reader.readUserCard('user01', liveSignal())).toEqual({ status: 'forbidden' });

    status = 200;
    expect((await reader.readUserCard('user01', liveSignal())).status).toBe('ready');
    expect(calls).toHaveLength(2);
  });
});