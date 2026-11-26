'use client';

// ─────────────────────────────────────────────────────────────────────────────
// ChatRmdProvider.tsx — 聊天页面的 RMD 编译上下文（一条页面一个 Manager / Worker）
//
// 责任只有四件：
//   · 每页创建并持有一个 `ChatCompileManager`，挂载后立即预热 Worker，卸载时 dispose；
//   · 把当前查看者作用域与子编译入口传给消息视图；
//   · 订阅页面滚动活动信号，快速滚动期间让 Manager 暂停派发新编译任务；
//   · 提供一个可注入 Manager 的测试缝（默认走 createChatCompileManager）。
//
// 【为什么子编译不另建 Manager】剪贴板子文档与父正文共用同一 Worker 队列：
// manager 自己排队，子编译键（`child:<hash>:<seq>`）与消息键（`msg:<id>` /
// `gen:<id>`）不同，不会互相顶掉，也不会占住父文档的执行槽。
//
// 【预热】挂载后的下一个任务（setTimeout(0)）调用一次 `manager.warmup?.()`，让
// Worker 的下载与求值和 hydration、频道 / 消息请求并行，而不是等页面空闲。长列表
// 恰恰最难进入 idle，requestIdleCallback 会让预热触发得最晚，所以这里不用它。
// 只预创建 Worker，不订阅、不编译；卸载 / 重挂时取消。
//
// 【SSR】模块顶层不访问 window / Worker；服务端渲染时 manager 为 null，消息视图
// 直接显示源码（转义文本）。Worker 在首次 subscribe 或挂载预热时才创建，
// 所以即使客户端首帧就建 Manager 也不产生网络 / 子进程资源。
//
// 【StrictMode】Manager 的预热幂等（已有 Worker 直接复用），不订阅、不编译；
// 卸载 dispose 用微任务 + 共享 mounted 标记与 CompiledDocumentView 同构：开发态
// 「卸载后立即重挂」不会把仍在使用的 Manager 关掉。
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
import { subscribeChatScrollActivity } from './scroll-activity';

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

/**
 * 挂载后的下一个任务调度一次预热，返回取消函数。仅在客户端 effect 中调用。
 * 不用 requestIdleCallback：长列表和水合期间页面几乎不会 idle，预热会被拖到
 * 用户已经开始滚动之后。setTimeout(0) 让 Worker 的下载 / 求值与 hydration、
 * 频道 / 消息请求并行。`manager.warmup` 可重复调用且失败静默，取消后不再触发。
 */
function scheduleWarmup(manager: ChatCompileManager): () => void {
  if (typeof window === 'undefined') return () => {};

  let cancelled = false;
  const timer = setTimeout(() => {
    if (cancelled) return;
    cancelled = true;
    // 只预创建 Worker；失败由 Manager 静默，首次订阅仍按既有逻辑重试。
    manager.warmup?.();
  }, 0);
  return () => {
    cancelled = true;
    clearTimeout(timer);
  };
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

  // 预热：挂载后立即预创建 Worker，让下载 / 求值与页面首轮请求并行，缩短首条
  // 消息从源码升级为渲染视图的等待。只预创建，不订阅、不编译；StrictMode 重挂时
  // cleanup 先取消再重新调度，Manager.warmup 幂等，不会重复创建 Worker。
  useEffect(() => {
    if (!manager) return;
    return scheduleWarmup(manager);
  }, [manager]);

  // 快速滚动期暂停新编译任务的派发：只影响排队任务何时交给 Worker，在途编译与
  // 结果投递不受影响（提交层的降优先级由 ChatRmdMessage 的 final transition 负责）。
  // 卸载时退订；Manager 已 dispose 时 setScrolling 自身是 no-op，竞态安全。
  useEffect(() => {
    if (!manager) return;
    return subscribeChatScrollActivity((active) => {
      manager.setScrolling?.(active);
    });
  }, [manager]);

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