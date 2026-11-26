// ─────────────────────────────────────────────────────────────────────────────
// chat-rmd/compile.worker.ts — 聊天多文档编译 Worker
//
// 上游 `startLocalCompileWorker` 是单会话协议；聊天需要按 key 并发多条消息，
// 所以这里自定义协议，但**复用** `compileSource` 与 `createLocalCompileSession`：
// 同一 key 的连续快照走增量会话，final / release 后释放；会话数上限 8（LRU）。
//
// 只接收源码、key、revision、phase 这些可序列化参数，不接收 cookie、用户资料或
// 权限数据。编译前先把 `{{ … }}` 掩码为字面文本，成功后再恢复并过
// `applyChatDocumentPolicy`，最后回传主线程。
//
// 文件底部只在 DedicatedWorkerGlobalScope 中安装 handler；被普通页面 import 时无副作用。
// ─────────────────────────────────────────────────────────────────────────────

import { createLocalCompileSession, type LocalCompileResult } from 'reactive-md';
import { compileSource } from '../reactive/compile-source';
import type { ChatWorkerRequest, ChatWorkerResponse } from './compile-manager';
import type { ChatSourcePhase } from './types';
import {
  CHAT_RMD_POLICY_UNSUPPORTED,
  applyChatDocumentPolicy,
} from './document-policy';
import {
  maskChatExpressionLiterals,
  restoreChatExpressionLiterals,
} from './interpolation-literals';
import { CHAT_RMD_COMPILE_OPTIONS } from './options';

/** 每个 Worker 内允许同时保留的增量会话数。 */
export const CHAT_RMD_MAX_COMPILE_SESSIONS = 8;

type CompileSession = ReturnType<typeof createLocalCompileSession>;

export interface ChatCompileWorkerHandler {
  handle(message: ChatWorkerRequest): void;
  dispose(): void;
  readonly sessionCount: number;
}

function isCompileRequest(
  value: unknown
): value is Extract<ChatWorkerRequest, { type: 'compile' }> {
  if (typeof value !== 'object' || value === null) return false;
  const request = value as Record<string, unknown>;
  return (
    request.type === 'compile' &&
    typeof request.id === 'number' &&
    typeof request.key === 'string' &&
    request.key.length > 0 &&
    typeof request.revision === 'number' &&
    typeof request.source === 'string' &&
    (request.phase === 'streaming' || request.phase === 'final')
  );
}

/**
 * 创建 Worker 侧处理器。独立导出是为了单元测试；生产环境由文件底部的安装逻辑调用。
 */
export function createChatCompileWorkerHandler(
  postMessage: (message: ChatWorkerResponse) => void
): ChatCompileWorkerHandler {
  const sessions = new Map<string, CompileSession>();
  let disposed = false;

  function postError(
    id: number,
    key: string,
    revision: number,
    phase: ChatSourcePhase,
    code: string,
    message: string
  ): void {
    postMessage({ type: 'error', id, key, revision, phase, code, message });
  }

  function disposeSession(key: string): void {
    const session = sessions.get(key);
    if (!session) return;
    sessions.delete(key);
    try {
      session.dispose();
    } catch {
      // dispose 不应影响后续编译。
    }
  }

  function disposeAll(): void {
    disposed = true;
    for (const key of [...sessions.keys()]) disposeSession(key);
  }

  function getSession(key: string): CompileSession {
    const existing = sessions.get(key);
    if (existing) {
      // Map 插入顺序 = LRU 顺序。
      sessions.delete(key);
      sessions.set(key, existing);
      return existing;
    }

    const session = createLocalCompileSession();
    sessions.set(key, session);
    while (sessions.size > CHAT_RMD_MAX_COMPILE_SESSIONS) {
      const oldest = sessions.keys().next();
      if (oldest.done) break;
      disposeSession(oldest.value);
    }
    return session;
  }

  function handleCompile(
    request: Extract<ChatWorkerRequest, { type: 'compile' }>
  ): void {
    const { id, key, revision, source, phase } = request;
    let session: CompileSession;
    try {
      session = getSession(key);
    } catch {
      postError(id, key, revision, phase, 'worker.error', '聊天编译会话创建失败');
      return;
    }

    try {
      // 表达式按字面文本编译：未声明标识符不再让整块结构回退源码。
      const masked = maskChatExpressionLiterals(source, CHAT_RMD_COMPILE_OPTIONS);
      const result = compileSource(
        masked.source,
        CHAT_RMD_COMPILE_OPTIONS,
        phase,
        (input, options, sourcePhase) => session.compile(input, options, sourcePhase)
      );

      if (!result.ok) {
        const failure: LocalCompileResult = result;
        postMessage({ type: 'result', id, key, revision, phase, result: failure });
        return;
      }

      if (masked.masked) restoreChatExpressionLiterals(result.document, source);

      const policy = applyChatDocumentPolicy(result.document);
      if (!policy.ok) {
        postError(
          id,
          key,
          revision,
          phase,
          CHAT_RMD_POLICY_UNSUPPORTED,
          '聊天文档包含未支持的节点'
        );
        return;
      }

      postMessage({
        type: 'result',
        id,
        key,
        revision,
        phase,
        result: { ...result, document: policy.document },
      });
    } catch {
      // 异常信息可能带源码片段，回传稳定码 + 通用文案即可。
      disposeSession(key);
      postError(id, key, revision, phase, 'worker.error', '聊天编译失败');
    } finally {
      if (phase === 'final') disposeSession(key);
    }
  }

  function handle(message: ChatWorkerRequest): void {
    if (disposed || typeof message !== 'object' || message === null) return;

    if (message.type === 'dispose') {
      disposeAll();
      return;
    }
    if (message.type === 'release') {
      if (typeof message.key === 'string') disposeSession(message.key);
      return;
    }
    if (isCompileRequest(message)) handleCompile(message);
  }

  return {
    handle,
    dispose: disposeAll,
    get sessionCount() {
      return sessions.size;
    },
  };
}

interface ChatWorkerScopeLike {
  onmessage: ((event: { data: unknown }) => void) | null;
  postMessage(message: ChatWorkerResponse): void;
  document?: unknown;
}

function installChatCompileWorker(): void {
  const scope = globalThis as unknown as Partial<ChatWorkerScopeLike>;
  // 只认 DedicatedWorkerGlobalScope：有 postMessage、没有 document。
  // 不用 importScripts 判定 —— 模块 Worker 里该函数存在但调用即抛，且各实现不完全一致。
  if (typeof scope.postMessage !== 'function' || scope.document !== undefined) {
    return;
  }

  const handler = createChatCompileWorkerHandler((message) => scope.postMessage!(message));
  scope.onmessage = (event) => {
    const request = event?.data;
    if (typeof request === 'object' && request !== null) handler.handle(request as ChatWorkerRequest);
  };
}

installChatCompileWorker();