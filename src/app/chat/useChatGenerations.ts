'use client';

// ─────────────────────────────────────────────────────────────────────────────
// useChatGenerations.ts — 讨论 SSE 生成事件的客户端临时状态（React 薄壳）
//
// 【职责】把 generation_snapshot / generation_terminal 折叠成 ChatApp 可渲染的
// `generations`，并在 terminal.completed 时通过 onCompleted 通知调用方补拉正式消息。
// 决策逻辑全在零 React 的 @/lib/chat-generation-reducer（见那里的文件头）；这里只做：
//   1. 用 ref 镜像最新状态，让 applyEvent 能同步返回 accepted 并稳定跨渲染
//      （SSE effect 的依赖里放它不会每次快照重连）；
//   2. 用 ref 保存最新 onCompleted，回调引用变化不会重建状态或丢事件；
//   3. 每个 CHAT_GENERATION_SWEEP_INTERVAL_MS 清一次超过 150 秒没更新的预览，
//      卸载时清定时器。
//
// 【接入】ChatApp 的 src.onmessage 里把每一帧交给 applyEvent（它只认两种生成事件，
// 其余返回 false）；正式 message 带 generation_id 时在同一次状态更新里调用
// removeGeneration；切频道 / resync / 断线 / 离开页面时 clearChannel / clearAll。
// 临时预览不是 ChatMessageDTO，不进入保存、回复、拍一拍与消息菜单。
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ChatStreamEvent } from '@/lib/chat-shared';
import {
  CHAT_GENERATION_SWEEP_INTERVAL_MS,
  EMPTY_CHAT_GENERATION_STATE,
  applyChatGenerationEvent,
  clearChatGenerationChannel,
  pruneStaleChatGenerationPreviews,
  removeChatGenerationPreview,
  type ChatGenerationPreview,
  type ChatGenerationState,
} from '@/lib/chat-generation-reducer';

export type { ChatGenerationPreview } from '@/lib/chat-generation-reducer';

export interface ChatGenerationsController {
  /** 仅未终止的任务，按首次出现顺序；调用方按 channel 过滤后再渲染。 */
  generations: ChatGenerationPreview[];
  /** 处理两种生成事件；返回是否被接受/改变了状态。其他事件类型返回 false。 */
  applyEvent(ev: ChatStreamEvent): boolean;
  /** 正式消息带 generation_id 时调用，移除对应临时预览并记录终态墓碑。 */
  removeGeneration(generationId: string): void;
  /** 切频道/断线/resync 时清理。 */
  clearChannel(channelId: string): void;
  clearAll(): void;
}

export function useChatGenerations(options: {
  /** terminal.completed 且正式消息可能尚未在列表时调用，由 ChatApp 触发补拉。 */
  onCompleted: (channelId: string, messageId: number) => void;
}): ChatGenerationsController {
  const [state, setState] = useState<ChatGenerationState>(EMPTY_CHAT_GENERATION_STATE);
  // 状态镜像：applyEvent/removeGeneration 需要同步读最新状态并同步返回 accepted，
  // 同时避免 setState(updater) 在 StrictMode 下被重复调用造成的副作用。
  const stateRef = useRef(state);
  const onCompletedRef = useRef(options.onCompleted);

  // 回调引用变化只更新 ref，不触发状态重建；快照照常逐帧渲染，但事件不会丢。
  useEffect(() => {
    onCompletedRef.current = options.onCompleted;
  });

  const commit = useCallback((next: ChatGenerationState) => {
    if (next === stateRef.current) return;
    stateRef.current = next;
    setState(next);
  }, []);

  const applyEvent = useCallback(
    (ev: ChatStreamEvent): boolean => {
      const result = applyChatGenerationEvent(stateRef.current, ev, Date.now());
      if (!result.accepted) return false;
      commit(result.state);
      if (result.completed) {
        // 同步执行：调用方在同一事件里补拉，不必等下一次渲染。
        onCompletedRef.current(result.completed.channelId, result.completed.messageId);
      }
      return true;
    },
    [commit]
  );

  const removeGeneration = useCallback(
    (generationId: string) => {
      commit(removeChatGenerationPreview(stateRef.current, generationId));
    },
    [commit]
  );

  const clearChannel = useCallback(
    (channelId: string) => {
      commit(clearChatGenerationChannel(stateRef.current, channelId));
    },
    [commit]
  );

  const clearAll = useCallback(() => {
    commit(EMPTY_CHAT_GENERATION_STATE);
  }, [commit]);

  // 超时清理：只清临时预览；重新收到活动任务快照时允许再次出现（见 reducer）。
  useEffect(() => {
    const timer = setInterval(() => {
      commit(pruneStaleChatGenerationPreviews(stateRef.current, Date.now()));
    }, CHAT_GENERATION_SWEEP_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [commit]);

  return useMemo(
    () => ({
      generations: state.previews,
      applyEvent,
      removeGeneration,
      clearChannel,
      clearAll,
    }),
    [state, applyEvent, removeGeneration, clearChannel, clearAll]
  );
}