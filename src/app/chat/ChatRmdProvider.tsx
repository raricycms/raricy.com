'use client';

// ─────────────────────────────────────────────────────────────────────────────
// ChatRmdProvider.tsx — 聊天页面的 RMD 编译上下文（一条页面一个 Manager / Worker）
//
// 责任只有三件：
//   · 每页创建并持有一个 `ChatCompileManager`，卸载时 dispose；
//   · 把当前查看者作用域与子编译入口传给消息视图；
//   · 提供一个可注入 Manager 的测试缝（默认走 createChatCompileManager）。
//
// 【为什么子编译不另建 Manager】剪贴板子文档与父正文共用同一 Worker 队列：
// manager 自己排队，子编译键（`child:<hash>:<seq>`）与消息键（`msg:<id>` /
// `gen:<id>`）不同，不会互相顶掉，也不会占住父文档的执行槽。
//
// 【SSR】模块顶层不访问 window / Worker；服务端渲染时 manager 为 null，消息视图
// 直接显示源码（转义文本）。Manager 的 Worker 是首次 subscribe 才创建的，所以
// 即使客户端首帧就建 Manager 也不产生网络 / 子进程资源。
//
// 【StrictMode】Manager 本身没有外部资源（Worker 延迟创建），卸载 dispose 用
// 微任务 + 共享 mounted 标记与 CompiledDocumentView 同构：开发态「卸载后立即
// 重挂」不会把仍在使用的 Manager 关掉。
// ─────────────────────────────────────────────────────────────────────────────

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { LocalDocument } from 'reactive-md';
import { createChatCompileManager } from '@/lib/chat-rmd/compile-manager';
import { clearChatReferenceCache } from '@/lib/chat-rmd/reference-reader';
import type {
  ChatCompiledSnapshot,
  ChatCompileManager,
  ChatCompileRequest,
} from '@/lib/chat-rmd/types';

/** 子编译的缺省上限；B 的适配器只负责发起，超时由本层兜底。 */
export const CHAT_RMD_CHILD_COMPILE_TIMEOUT_MS = 15_000;

export interface ChatRmdContextValue {
  manager: ChatCompileManager;
  /** 引用取数作用域（当前查看者 id）；切号会换 provider，旧请求随信号取消。 */
  viewerScope: string;
  /** 子剪贴板重新排队编译；取消或失败返回 null（调用方保留回链 / token）。 */
  compileChild: (source: string, signal: AbortSignal) => Promise<LocalDocument | null>;
}

const ChatRmdContext = createContext<ChatRmdContextValue | null>(null);

/** 无 provider 时返回 null：消息视图落到源码回退，不抛异常。 */
export function useChatRmd(): ChatRmdContextValue | null {
  return useContext(ChatRmdContext);
}

export interface ChatRmdProviderProps {
  /** 当前查看者 id；用于引用取数去重与切号清理。 */
  viewerScope: string;
  children: ReactNode;
  /** 测试注入；生产不传，由 createChatCompileManager() 创建。 */
  manager?: ChatCompileManager;
  /** 子编译超时（毫秒）；测试可调小。 */
  childCompileTimeoutMs?: number;
}

function canStartCompileManager(): boolean {
  // Manager 本身可在无 DOM 环境创建；只有 Worker 的构造需要浏览器能力。
  return typeof window !== 'undefined';
}

/** 稳定但非安全的源码指纹，仅用于子编译 key 的可读片段。 */
function sourceFingerprint(source: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36);
}

interface Lifecycle {
  mounted: boolean;
}

export default function ChatRmdProvider({
  viewerScope,
  children,
  manager: injectedManager,
  childCompileTimeoutMs = CHAT_RMD_CHILD_COMPILE_TIMEOUT_MS,
}: ChatRmdProviderProps) {
  const [manager] = useState<ChatCompileManager | null>(() =>
    injectedManager ?? (canStartCompileManager() ? createChatCompileManager() : null)
  );
  const lifecycle = useMemo<Lifecycle>(() => ({ mounted: false }), []);

  useEffect(() => {
    lifecycle.mounted = true;
    return () => {
      lifecycle.mounted = false;
      queueMicrotask(() => {
        // StrictMode 会在同一个任务里先 cleanup 再重跑 effect；共享标记能区分
        // 「真的卸载」和「开发态重挂」。
        if (!lifecycle.mounted) manager?.dispose();
      });
    };
  }, [lifecycle, manager]);

  // 名片取数是页面级公开数据缓存（reference-reader）：切账号或离开页面即释放，
  // 不把上一个查看者的作用域留在内存里。
  useEffect(() => () => clearChatReferenceCache(viewerScope), [viewerScope]);

  const childKeySeq = useRef(0);
  const childRevisionSeq = useRef(0);

  const compileChild = useCallback(
    (source: string, signal: AbortSignal): Promise<LocalDocument | null> => {
      if (!manager || signal.aborted) return Promise.resolve(null);

      const key = `child:${sourceFingerprint(source)}:${++childKeySeq.current}`;
      const revision = ++childRevisionSeq.current;
      const request: ChatCompileRequest = {
        key,
        revision,
        source,
        phase: 'final',
        priority: 'visible',
      };

      return new Promise<LocalDocument | null>((resolve) => {
        let settled = false;
        let unsubscribe: (() => void) | null = null;
        let timer: ReturnType<typeof setTimeout> | null = null;

        const finish = (document: LocalDocument | null): void => {
          if (settled) return;
          settled = true;
          if (timer !== null) clearTimeout(timer);
          signal.removeEventListener('abort', onAbort);
          const off = unsubscribe;
          unsubscribe = null;
          off?.();
          resolve(document);
        };
        const onAbort = (): void => finish(null);

        if (childCompileTimeoutMs > 0) {
          timer = setTimeout(() => finish(null), childCompileTimeoutMs);
        }
        signal.addEventListener('abort', onAbort, { once: true });

        const onSnapshot = (snapshot: ChatCompiledSnapshot): void => {
          // 子编译每 key 独立 revision；只接受自己的那一条，旧结果直接丢弃。
          if (snapshot.key !== key || snapshot.revision !== revision || snapshot.phase !== 'final') {
            return;
          }
          finish(snapshot.document);
        };

        try {
          unsubscribe = manager.subscribe(request, onSnapshot);
        } catch {
          finish(null);
          return;
        }
        // 缓存命中时 manager 会同步回调，此时 unsubscribe 还没赋上。
        if (settled) {
          const off = unsubscribe;
          unsubscribe = null;
          off?.();
        }
      });
    },
    [manager, childCompileTimeoutMs]
  );

  const value = useMemo<ChatRmdContextValue | null>(
    () => (manager ? { manager, viewerScope, compileChild } : null),
    [manager, viewerScope, compileChild]
  );

  return <ChatRmdContext.Provider value={value}>{children}</ChatRmdContext.Provider>;
}